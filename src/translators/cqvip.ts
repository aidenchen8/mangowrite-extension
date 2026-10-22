// CQVIP (维普/中文科技期刊) translator.
//
// Strategy mirrors the maintained community translator (l0o0/translators_CN):
//   1. Recover the article id from the URL (/doc/<kind>/<digits>) or the
//      embedded __NUXT__ state (`vipdc:<digits>`).
//   2. Pull authoritative metadata from CQVIP's own export endpoint. Despite
//      `styles=RefMan`, `.data[0].refText` is **RefWorks** tagged text
//      (`RT Journal Article` / `T1 …`), not RIS (`TY  - JOUR`) — see refworks.ts.
//      The endpoint answers anonymously; cookies only matter for the page itself.
//   3. Best-effort full-text PDF from a download anchor on the page; CQVIP
//      gates PDFs behind login and the community translator leaves this
//      unimplemented, so we degrade to metadata-only when absent.
//
// Pure/string-based → runs headless in the MV3 worker, unit-testable w/o a DOM.

import { canonicalizeUrl, extractCanonicalHint } from "../canonical-url.js";
import { parseRefworks } from "./refworks.js";
import type { PartialCsl } from "../metadata-extract.js";
import type { Attachment, Translator, TranslatorContext, TranslatorResult } from "./types.js";

/** Same-origin API base, WebVPN-aware (see cnki.ts for the proxy shape). */
function cqvipApiBase(pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    const proxied = u.pathname.match(/^\/(https?)\/([^/]+)\//i);
    if (proxied) return `${u.origin}/${proxied[1]}/${proxied[2]}`;
    return u.origin;
  } catch {
    return "https://www.cqvip.com";
  }
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Article id from the URL path or the __NUXT__ payload. */
export function extractCqvipId(input: { url: string; html: string }): string | null {
  const fromUrl = input.url.match(/\/doc\/[a-z]+\/(\d+)/i)?.[1];
  if (fromUrl) return fromUrl;
  // NUXT SSR state embeds e.g. "vipdc:1234567" for the current doc.
  const fromNuxt = input.html.match(/vipdc:(\d+)/)?.[1];
  return fromNuxt ?? null;
}

async function fetchCqvipMetadata(
  ctx: TranslatorContext,
  id: string,
): Promise<PartialCsl | null> {
  const url = `${cqvipApiBase(ctx.url)}/newsite/literature/base/ref/export?ids=${encodeURIComponent(
    id,
  )}&types=1&styles=RefMan`;
  try {
    const text = await ctx.fetchText(url, {
      headers: { Referer: ctx.url },
      credentials: "include",
    });
    // { data: [ { refText: "TY  - JOUR\n…" } ] }
    const refText = (JSON.parse(text) as { data?: Array<{ refText?: string }> }).data?.[0]?.refText;
    if (!refText) return null;
    const parsed = parseRefworks(refText);
    return parsed.title ? parsed : null;
  } catch {
    return null;
  }
}

/** Rendered-text fallback title when the export API is unavailable. */
function scrapeCqvipTitle(html: string): PartialCsl {
  const out: PartialCsl = { type: "article-journal", language: "zh" };
  const raw =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
    "";
  const title = raw.replace(/\s*[-—]\s*维普.*$/, "").trim();
  if (title) out.title = title;
  return out;
}

/** Best-effort PDF href: a download anchor pointing at a PDF/download route. */
function findCqvipPdfHref(html: string): string | null {
  const anchors = html.match(/<a\b[^>]*>/gi) ?? [];
  for (const tag of anchors) {
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    if (/\/(?:doc\/)?download\//i.test(href) || /\.pdf(?:[?#]|$)/i.test(href)) {
      return href.replace(/&amp;/g, "&").trim();
    }
  }
  return null;
}

export const cqvipTranslator: Translator = {
  id: "cqvip",
  label: "维普期刊",
  match: (url) => /(^|\.)cqvip\.com$/i.test(host(url)),
  detect: ({ url, html }) => {
    // Need a doc-id signal AND a CQVIP-origin signal, so a random `/doc/x/123`
    // path on some other host isn't misread as CQVIP. The origin signal also
    // covers WebVPN, where the host isn't cqvip.com but the page still refers
    // to it. `vipdc:` is CQVIP-specific on its own.
    const hasId = /\/doc\/[a-z]+\/\d+/i.test(url) || /vipdc:\d+/.test(html);
    return hasId && (/cqvip\.com/i.test(url) || /cqvip/i.test(html));
  },
  async extract(ctx): Promise<TranslatorResult> {
    const id = extractCqvipId({ url: ctx.url, html: ctx.html });
    const metadata =
      (id ? await fetchCqvipMetadata(ctx, id) : null) ?? scrapeCqvipTitle(ctx.html);

    // CQVIP's doc id is the article's stable identity, and CQVIP records rarely
    // carry a DOI. Without it the work falls back to the landing-page URL, which
    // moves with the WebVPN host prefix — the same paper would mint a fresh work
    // on every import (same failure CNKI had).
    if (id && !metadata.nativeId) metadata.nativeId = `cqvip:${id}`;

    if (!metadata.URL) {
      metadata.URL = canonicalizeUrl(ctx.url, {
        canonicalHint: extractCanonicalHint(ctx.html),
      });
    }

    const pdfHref = findCqvipPdfHref(ctx.html);
    const attachments: Attachment[] = [];
    if (pdfHref) {
      attachments.push({
        kind: "pdf",
        url: pdfHref,
        mime: "application/pdf",
        filename: `${id ?? "cqvip"}.pdf`,
      });
    }

    return {
      metadata,
      identifier: metadata.DOI ?? null,
      resolverSource: "plugin-dom-zh",
      attachments,
      // We drive metadata from the export API; the SPA HTML is only a shell, so
      // never snapshot it, and don't let server-side discovery scrape the shell.
      allowGenericPdfDiscovery: false,
      allowRawHtmlFallback: false,
    };
  },
};
