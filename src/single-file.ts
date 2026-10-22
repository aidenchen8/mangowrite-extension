// Single-file webpage snapshot: bake stylesheets into the captured HTML,
// inline images as data: URIs, and strip scripts / navigation / external
// references, so the stored snapshot renders standalone inside the reader's
// sandboxed srcdoc iframe (no allow-scripts) without depending on the origin
// site still serving its assets. The stored file doubles as the parse input
// for the HTML adapter and as the archival "view original" artifact.
//
//   - deep-clone the live DOM (the page itself is never mutated),
//   - drop <script>/<noscript>/<iframe>/<object>/<embed>, inline on* handlers,
//     javascript:/vbscript: URLs, and CSP/refresh <meta> (a CSP meta would
//     block our inlined styles),
//   - unwrap <form> (children stay; a snapshot must never submit anywhere),
//   - replace every non-print <link rel=stylesheet> we can read with an
//     in-place <style> (in-place keeps the exact cascade order); print-only
//     sheets keep their <link>; same-origin sheets are read
//     via cssRules, cross-origin sheets are fetched by the background service
//     worker (content-script fetches are CORS-bound to the page),
//   - inline every image we can fetch as a data: URI — <img> src, one dpr-
//     picked candidate per srcset, <picture><source> srcset, <video> poster,
//     and url() inside baked/inline CSS (content images before CSS decor) —
//     so the stored snapshot makes ZERO external requests at view time,
//   - strip src from <video>/<audio>/<source> media (bytes are not archived),
//   - inject <base href> so anything we could not inline still resolves
//     against the origin site at PARSE time (the API strips <base> again when
//     serving the snapshot to the reader).

export interface SingleFileOptions {
  /** Fetch a cross-origin stylesheet's text; return null on failure. */
  fetchCrossOriginCss?: (href: string) => Promise<string | null>;
  /**
   * Read a stylesheet's rules from the live document; throws on cross-origin
   * sheets (SecurityError), like cssRules does. Injectable because node-side
   * tests have no CSSOM.
   */
  readSameOriginCss?: (sheet: CSSStyleSheet) => string;
  /**
   * Fetch an image URL (any origin, page session) and return it as a data:
   * URI; return null on failure. Injectable for tests.
   */
  fetchImageDataUri?: (url: string) => Promise<string | null>;
  /** Device pixel ratio used to pick a single candidate per srcset (default 1). */
  devicePixelRatio?: number;
  /**
   * 总时限检查点：返回 true 后不再发起新的跨域抓取（CSS / 图片内联），
   * 已在途的请求照常收尾。内联缺口的兜底在 serve 端（见文件头注释），
   * 所以这里 abort 是软降级，不是错误。
   */
  shouldAbort?: () => boolean;
}

const STRIP_TAGS = "script,noscript,iframe,object,embed";

/** URL-bearing attributes that must never keep a javascript:/vbscript: target. */
const URL_ATTRS = ["href", "src", "action", "formaction", "poster", "background", "data"];

const MAX_INLINE_IMAGES = 200;
const MAX_INLINE_IMAGE_CHARS = 14 * 1024 * 1024; // data: URI length (~10MB binary)
const MAX_INLINE_TOTAL_CHARS = 60 * 1024 * 1024;
const FETCH_CONCURRENCY = 4;

function defaultReadSameOriginCss(sheet: CSSStyleSheet): string {
  return Array.from(sheet.cssRules ?? [])
    .map((rule) => rule.cssText)
    .join("\n");
}

/**
 * Print-only sheets never render on screen, so their bytes are not worth
 * fetching. Conservative: mixed media ("print, screen") still counts as on-screen.
 */
function isPrintOnlySheet(sheet: StyleSheet): boolean {
  const mediaText = (sheet.media?.mediaText ?? "").toLowerCase();
  return mediaText.includes("print") && !mediaText.includes("screen") && !mediaText.includes("all");
}

interface CssRef {
  /** The stylesheet text / style attribute value containing url() refs. */
  text: string;
  /** Base URL for resolving relative url() refs. */
  base: string;
  /** Where the rewritten text goes once urls are resolved. */
  apply: (rewritten: string) => void;
}

function resolveUrl(raw: string, base: string): string | null {
  try {
    return new URL(raw, base).href;
  } catch {
    return null;
  }
}

const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)/g;

/** Fonts are not images; skipping them at collection avoids a doomed fetch. */
function isFontUrl(url: string): boolean {
  return /\.(?:woff2?|ttf|otf|eot)$/i.test(url.split(/[?#]/, 1)[0]!);
}

/** Extract absolute http(s) image candidate URLs from a CSS text. */
function collectCssUrls(text: string, base: string, into: Set<string>): void {
  for (const match of text.matchAll(CSS_URL_RE)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    if (!raw || raw.startsWith("data:") || raw.startsWith("#")) continue;
    const abs = resolveUrl(raw, base);
    if (abs && /^https?:\/\//i.test(abs) && !isFontUrl(abs)) into.add(abs);
  }
}

/** Rewrite url() refs in a CSS text using the fetched data: URI map. */
function rewriteCssUrls(text: string, base: string, inlined: Map<string, string>): string {
  return text.replace(CSS_URL_RE, (full, dq, sq, bare) => {
    const raw = (dq ?? sq ?? bare ?? "") as string;
    if (!raw || raw.startsWith("data:") || raw.startsWith("#")) return full;
    const abs = resolveUrl(raw, base);
    const dataUri = abs ? inlined.get(abs) : undefined;
    if (!dataUri) return full;
    return `url("${dataUri}")`;
  });
}

/**
 * srcset tokenizer that doesn't split inside data: URIs (their base64 payload
 * follows a comma). URLs never contain spaces; a data: URL's payload charset
 * excludes commas, so `data:<meta>,<payload>` scans cleanly.
 */
function splitSrcsetCandidates(
  srcset: string,
): Array<{ url: string; descriptor: string | null }> {
  const out: Array<{ url: string; descriptor: string | null }> = [];
  let i = 0;
  while (i < srcset.length) {
    while (i < srcset.length && (srcset[i] === "," || /\s/.test(srcset[i]!))) i++;
    if (i >= srcset.length) break;
    let url: string;
    if (srcset.startsWith("data:", i)) {
      url = /^data:[^,\s]*,[A-Za-z0-9+/=]*/.exec(srcset.slice(i))?.[0]
        ?? /^\S+/.exec(srcset.slice(i))![0];
    } else {
      url = /^[^,\s]+/.exec(srcset.slice(i))![0];
    }
    i += url.length;
    const dm = /^\s+(\d+(?:\.\d+)?[wx])\s*/.exec(srcset.slice(i));
    const descriptor = dm?.[1] ?? null;
    if (dm) i += dm[0].length;
    out.push({ url, descriptor });
  }
  return out;
}

/**
 * A snapshot needs one density per srcset, not every candidate. x-descriptor
 * candidates compete on proximity to dpr (first wins a tie); w / bare
 * candidates fall back to the first entry.
 */
function selectSrcsetCandidate(
  srcset: string,
  dpr: number,
): { url: string; descriptor: string | null } | null {
  const candidates = splitSrcsetCandidates(srcset);
  const xCandidates = candidates.filter((c) => c.descriptor?.endsWith("x"));
  if (xCandidates.length === 0) return candidates[0] ?? null;
  let best = xCandidates[0]!;
  for (const candidate of xCandidates) {
    const delta = Math.abs(parseFloat(candidate.descriptor!) - dpr);
    const bestDelta = Math.abs(parseFloat(best.descriptor!) - dpr);
    if (delta < bestDelta) best = candidate;
  }
  return best;
}

/** Collect only the selected candidate's URL (see selectSrcsetCandidate). */
function collectSrcsetUrls(srcset: string, base: string, dpr: number, into: Set<string>): void {
  const candidate = selectSrcsetCandidate(srcset, dpr);
  if (!candidate || candidate.url.startsWith("data:") || isFontUrl(candidate.url)) return;
  const abs = resolveUrl(candidate.url, base);
  if (abs && /^https?:\/\//i.test(abs)) into.add(abs);
}

/** Keep only the selected candidate, swapped for its data: URI when inlined. */
function rewriteSrcset(
  srcset: string,
  base: string,
  dpr: number,
  inlined: Map<string, string>,
): string | null {
  const candidate = selectSrcsetCandidate(srcset, dpr);
  if (!candidate) return null;
  const suffix = candidate.descriptor ? ` ${candidate.descriptor}` : "";
  if (candidate.url.startsWith("data:")) return `${candidate.url}${suffix}`;
  const abs = resolveUrl(candidate.url, base);
  const dataUri = abs ? inlined.get(abs) : undefined;
  return dataUri ? `${dataUri}${suffix}` : null;
}

export async function buildSingleFileHtml(
  doc: Document,
  pageUrl: string,
  options: SingleFileOptions = {},
): Promise<string> {
  const readSameOriginCss = options.readSameOriginCss ?? defaultReadSameOriginCss;
  const dpr = options.devicePixelRatio ?? 1;

  // 1. Bake stylesheets. document.styleSheets is in document order; we record
  //    each LINK sheet's css text keyed by its absolute href, then swap the
  //    <link> for a <style> in place inside the clone.
  const bakedByHref = new Map<string, string>();
  for (const sheet of Array.from(doc.styleSheets)) {
    const href = sheet.href;
    if (!href) continue; // inline <style> elements stay untouched in the clone
    if (isPrintOnlySheet(sheet)) continue; // the <link> stays; base href covers it
    try {
      bakedByHref.set(href, readSameOriginCss(sheet as CSSStyleSheet));
    } catch {
      if (options.shouldAbort?.()) break;
      const text = options.fetchCrossOriginCss
        ? await options.fetchCrossOriginCss(href)
        : null;
      if (text != null) bakedByHref.set(href, text);
      // else: keep the <link>; with <base> injected it can still resolve.
    }
  }

  // 2. Clone the document and strip scripts / handlers / CSP meta /
  //    javascript: URLs; unwrap forms; drop media srcs.
  const clone = doc.documentElement.cloneNode(true) as HTMLElement;
  for (const el of Array.from(clone.querySelectorAll(STRIP_TAGS))) el.remove();
  for (const el of Array.from(clone.querySelectorAll("meta[http-equiv]"))) {
    const equiv = (el.getAttribute("http-equiv") ?? "").toLowerCase();
    if (equiv === "content-security-policy" || equiv === "refresh") el.remove();
  }
  for (const el of Array.from(clone.querySelectorAll("*"))) {
    for (const name of Array.from(el.getAttributeNames())) {
      const lower = name.toLowerCase();
      if (lower.startsWith("on")) {
        el.removeAttribute(name);
        continue;
      }
      if (URL_ATTRS.includes(lower) || lower === "xlink:href") {
        const value = el.getAttribute(name) ?? "";
        if (/^\s*(javascript|vbscript)\s*:/i.test(value)) el.removeAttribute(name);
      }
    }
  }
  // A snapshot never submits anywhere; keep the form's children (layout).
  for (const form of Array.from(clone.querySelectorAll("form"))) {
    form.replaceWith(...Array.from(form.childNodes));
  }
  // Media bytes are not archived; keep the element (layout + poster) but make
  // sure nothing reaches out. <source> under <picture> is handled below.
  for (const el of Array.from(clone.querySelectorAll("video,audio"))) {
    el.removeAttribute("src");
    for (const source of Array.from(el.querySelectorAll("source"))) source.remove();
    for (const track of Array.from(el.querySelectorAll("track"))) track.remove();
  }

  // 3. Collect every image URL we want to inline — DOM images first, because
  //    Set insertion order is the fetch priority and content figures must win
  //    the MAX_INLINE_IMAGES budget over CSS decoration — then url() refs in
  //    baked stylesheets, inline <style> elements and style="" attributes.
  //    CSS refs resolve against the stylesheet's own href; DOM refs against
  //    the page URL (the page's own <base> is resolved below).
  let pageBase = pageUrl;
  const existingBase = clone.querySelector("base");
  if (existingBase) {
    const href = existingBase.getAttribute("href");
    if (href) {
      const abs = resolveUrl(href, pageUrl);
      if (abs) pageBase = abs;
    }
  }

  const cssRefs: CssRef[] = [];
  const imageUrls = new Set<string>();

  const addDomUrl = (raw: string | null) => {
    if (!raw || raw.startsWith("data:")) return;
    const abs = resolveUrl(raw, pageBase);
    if (abs && /^https?:\/\//i.test(abs) && !isFontUrl(abs)) imageUrls.add(abs);
  };

  for (const img of Array.from(clone.querySelectorAll("img"))) {
    addDomUrl(img.getAttribute("src"));
    const srcset = img.getAttribute("srcset");
    if (srcset) collectSrcsetUrls(srcset, pageBase, dpr, imageUrls);
  }
  for (const source of Array.from(clone.querySelectorAll("picture source"))) {
    const srcset = source.getAttribute("srcset");
    if (srcset) collectSrcsetUrls(srcset, pageBase, dpr, imageUrls);
  }
  for (const video of Array.from(clone.querySelectorAll("video[poster]"))) {
    addDomUrl(video.getAttribute("poster"));
  }
  for (const input of Array.from(clone.querySelectorAll('input[type="image"]'))) {
    addDomUrl(input.getAttribute("src"));
  }
  for (const [href, cssText] of bakedByHref) {
    collectCssUrls(cssText, href, imageUrls);
  }
  for (const styleEl of Array.from(clone.querySelectorAll("style"))) {
    const text = styleEl.textContent ?? "";
    cssRefs.push({ text, base: pageBase, apply: (rewritten) => { styleEl.textContent = rewritten; } });
    collectCssUrls(text, pageBase, imageUrls);
  }
  for (const el of Array.from(clone.querySelectorAll("[style]"))) {
    const text = el.getAttribute("style") ?? "";
    cssRefs.push({ text, base: pageBase, apply: (rewritten) => { el.setAttribute("style", rewritten); } });
    collectCssUrls(text, pageBase, imageUrls);
  }

  // 4. Fetch and inline. Failures are soft: the URL stays in the snapshot and
  //    the API's serve-time rewrite either points it at worker-downloaded
  //    figure bytes or strips it — it never hot-links the origin site.
  const inlined = new Map<string, string>();
  if (options.fetchImageDataUri && imageUrls.size > 0) {
    const queue = Array.from(imageUrls).slice(0, MAX_INLINE_IMAGES);
    let totalChars = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length && totalChars < MAX_INLINE_TOTAL_CHARS && !options.shouldAbort?.()) {
        const url = queue[cursor++]!;
        try {
          const dataUri = await options.fetchImageDataUri!(url);
          if (
            dataUri &&
            dataUri.startsWith("data:image/") &&
            dataUri.length <= MAX_INLINE_IMAGE_CHARS &&
            totalChars + dataUri.length <= MAX_INLINE_TOTAL_CHARS
          ) {
            inlined.set(url, dataUri);
            totalChars += dataUri.length;
          }
        } catch {
          // soft-fail: leave the URL for the serve-time fallback
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, () => worker()),
    );
  }

  // 5. Apply CSS url() rewrites to inline <style> elements and style="".
  for (const ref of cssRefs) {
    ref.apply(rewriteCssUrls(ref.text, ref.base, inlined));
  }

  // 6. Swap baked <link rel=stylesheet> for in-place <style> blocks (CSS url()
  //    refs already inlined against the sheet's own href).
  for (const linkEl of Array.from(clone.querySelectorAll("link"))) {
    const rel = (linkEl.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("stylesheet")) continue;
    const hrefAttr = linkEl.getAttribute("href");
    if (!hrefAttr) continue;
    const absHref = resolveUrl(hrefAttr, pageUrl);
    if (!absHref) continue;
    const cssText = bakedByHref.get(absHref);
    if (cssText == null) continue;
    const styleEl = doc.createElement("style");
    styleEl.setAttribute("data-mango-inline", absHref);
    const media = linkEl.getAttribute("media");
    if (media) styleEl.setAttribute("media", media);
    styleEl.textContent = rewriteCssUrls(cssText, absHref, inlined);
    linkEl.replaceWith(styleEl);
  }

  // 7. Inline DOM image refs.
  for (const img of Array.from(clone.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    if (src) {
      const abs = src.startsWith("data:") ? null : resolveUrl(src, pageBase);
      const dataUri = abs ? inlined.get(abs) : undefined;
      if (dataUri) img.setAttribute("src", dataUri);
    }
    const srcset = img.getAttribute("srcset");
    if (srcset) {
      const rewritten = rewriteSrcset(srcset, pageBase, dpr, inlined);
      if (rewritten) img.setAttribute("srcset", rewritten);
      else img.removeAttribute("srcset");
    }
  }
  for (const source of Array.from(clone.querySelectorAll("picture source"))) {
    const srcset = source.getAttribute("srcset");
    if (!srcset) continue;
    const rewritten = rewriteSrcset(srcset, pageBase, dpr, inlined);
    if (rewritten) source.setAttribute("srcset", rewritten);
    else source.removeAttribute("srcset");
  }
  for (const video of Array.from(clone.querySelectorAll("video[poster]"))) {
    const poster = video.getAttribute("poster");
    const abs = poster && !poster.startsWith("data:") ? resolveUrl(poster, pageBase) : null;
    const dataUri = abs ? inlined.get(abs) : undefined;
    if (dataUri) video.setAttribute("poster", dataUri);
  }
  for (const input of Array.from(clone.querySelectorAll('input[type="image"]'))) {
    const src = input.getAttribute("src");
    const abs = src && !src.startsWith("data:") ? resolveUrl(src, pageBase) : null;
    const dataUri = abs ? inlined.get(abs) : undefined;
    if (dataUri) input.setAttribute("src", dataUri);
  }

  // 8. One absolutized <base> at the top of <head> so whatever could not be
  //    inlined still resolves against the origin site at parse time. The API
  //    strips this again when serving the snapshot to the reader.
  for (const el of Array.from(clone.querySelectorAll("base"))) el.remove();
  const baseEl = doc.createElement("base");
  baseEl.setAttribute("href", pageBase);
  const head = clone.querySelector("head");
  if (head) head.insertBefore(baseEl, head.firstChild);
  else clone.insertBefore(baseEl, clone.firstChild);

  return `<!DOCTYPE html>\n${clone.outerHTML}`;
}
