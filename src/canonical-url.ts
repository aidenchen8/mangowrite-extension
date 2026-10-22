// canonical URL for a webpage work's identity.
//
// Two users capturing "the same page" via different URLs (tracking params,
// m.-host, http/https, trailing slash) must resolve to ONE work. We prefer the
// page's own declared canonical (<link rel="canonical"> / og:url) — the author's
// intent — and otherwise normalize the observed URL: drop tracking junk, keep
// meaningful query params (?id=123 must survive).

// 只删「删掉不改变落到哪个页面」的参数。`ref` 不在表里：它在 GitHub
// （?ref=分支）、Amazon 等站是正经参数，删了 URL 就指向别的页面。
// 与 apps/api/src/modules/import/works.ts 的同名表必须一致（有 parity 测试守着）。
const TRACKING_PARAM_PATTERNS: RegExp[] = [
  /^utm_/i,
  /^gclid$/i,
  /^dclid$/i,
  /^fbclid$/i,
  /^msclkid$/i,
  /^spm$/i,
  /^ref_src$/i,
  /^_hsenc$/i,
  /^_hsmi$/i,
  /^mc_eid$/i,
  /^mc_cid$/i,
  /^igshid$/i,
  /^vero_id$/i,
  /^oly_enc_id$/i,
  /^scid$/i,
];

function isTrackingParam(key: string): boolean {
  return TRACKING_PARAM_PATTERNS.some((re) => re.test(key));
}

function readHtmlAttribute(tag: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = tag.match(
    new RegExp(`\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  const raw = value?.[1] ?? value?.[2] ?? value?.[3];
  if (!raw) return null;

  // Canonical URLs commonly encode query separators as &amp; in HTML.
  return raw
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function firstHtmlTag(html: string, tagName: string, predicate: (tag: string) => boolean): string | null {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  for (const match of html.matchAll(tagPattern)) {
    if (predicate(match[0])) return match[0];
  }
  return null;
}

/** Read a page-declared canonical URL from raw HTML, if any. */
export function extractCanonicalHint(html: string): string | null {
  const link = firstHtmlTag(html, "link", (tag) =>
    readHtmlAttribute(tag, "rel")?.split(/\s+/).some((token) => token.toLowerCase() === "canonical") ?? false,
  );
  const linkHref = link ? readHtmlAttribute(link, "href") : null;
  if (linkHref?.trim()) return linkHref.trim();

  const og = firstHtmlTag(html, "meta", (tag) =>
    readHtmlAttribute(tag, "property")?.toLowerCase() === "og:url",
  );
  const ogUrl = og ? readHtmlAttribute(og, "content") : null;
  return ogUrl?.trim() || null;
}

export function normalizeObservedUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  // https upgrade + lowercase host + drop default ports.
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  // 不剥 `m.` / `www.` 前缀：`m.media-amazon.com` 的 `m.` 是域名本身的一部分，
  // 剥掉就换了一个站点。移动版与桌面版的归并交给页面声明的 canonical / og:url。
  parsed.hostname = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol === "https:" && parsed.port === "443") ||
    (parsed.protocol === "http:" && parsed.port === "80")
  ) {
    parsed.port = "";
  }

  parsed.hash = "";

  // Strip tracking params; keep everything else.
  const keep = new URLSearchParams();
  parsed.searchParams.forEach((v, k) => {
    if (!isTrackingParam(k)) keep.append(k, v);
  });
  keep.sort();
  parsed.search = keep.toString();

  let out = parsed.toString();
  // Drop a trailing slash on the path (but never reduce "https://host/").
  out = out.replace(/\/(?=$|\?)/, (m, offset: number) =>
    offset > parsed.origin.length ? "" : m,
  );
  return out;
}

/**
 * Normalize an origin URL before storing/comparing it. Used to be where the
 * one-time `mw_import_*` assist params were stripped; mode B tickets now travel
 * via externally_connectable instead of URL query (spec: import.md),
 * so there is nothing Mango-specific left to remove.
 */
export function sanitizeOriginUrl(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

/**
 * Canonical URL used as a webpage work identity: page-declared canonical wins
 * (itself normalized), else the normalized observed URL.
 */
export function canonicalizeUrl(
  rawUrl: string,
  opts: { canonicalHint?: string | null } = {},
): string {
  const hint = opts.canonicalHint?.trim();
  if (hint) {
    try {
      // Resolve relative canonical hrefs against the observed URL.
      const abs = new URL(hint, rawUrl).toString();
      return normalizeObservedUrl(abs);
    } catch {
      // fall through
    }
  }
  return normalizeObservedUrl(rawUrl);
}
