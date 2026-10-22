// PDF-viewer shell translator.
//
// Some "open the PDF" links from Google Scholar don't serve `application/pdf`
// directly — they return a thin HTML page whose whole body is an
// `<iframe>/<embed>/<object>` pointing at the real PDF. IEEE Xplore's
// `stamp/stamp.jsp?arnumber=<id>` is the canonical example: content-type is
// text/html (so the content script DOES run, unlike a native-viewer PDF tab),
// the title is "IEEE Xplore Full-Text PDF:", and the only meaningful element is
// `<iframe src=".../<id>.pdf?<jwt>">`. The site translators don't fire here
// (IEEE's needs the `xplGlobal.document.metadata` blob, absent on the viewer),
// and the generic translator rejects it for lack of citation meta — so without
// this adapter the user gets "no paper found" on a page that is nothing but a
// PDF.
//
// We emit that embedded PDF as the sole attachment and let the background worker
// download it with the tab's cookies (same-origin → tab-relay, so entitlement /
// anti-leech tokens ride along). Metadata is resolved server-side from the PDF.
// Pure/string-based → unit-testable without a DOM.

import type { Translator, TranslatorResult } from "./types.js";

const EMBED_TAG_RE = /<(?:iframe|embed|object)\b[^>]*>/gi;

/** Highwire/Dublin Core/PRISM citation meta — the generic translator's signal. */
const CITATION_META_RE =
  /<meta[^>]+(?:name|property)=["'](?:citation_title|citation_pdf_url|citation_doi|dc\.title|dc\.identifier|prism\.doi|bepress_citation_title)["']/i;

/** Read a tag attribute value (double, single, or unquoted), case-insensitive. */
function attrValue(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

/** Resolve `src` against `baseUrl` and keep it only if its path ends in `.pdf`. */
function asPdfUrl(src: string, baseUrl: string): string | null {
  try {
    const abs = new URL(src, baseUrl);
    return /\.pdf$/i.test(abs.pathname) ? abs.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The URL of the first embedded object whose source is a `.pdf`, or null. The
 * `.pdf` may carry a query string (IEEE's signed link) — we test the path only.
 */
export function findEmbeddedPdfUrl(html: string, baseUrl: string): string | null {
  const tags = html.match(EMBED_TAG_RE);
  if (!tags) return null;
  for (const tag of tags) {
    const src = attrValue(tag, "src") ?? attrValue(tag, "data");
    if (!src) continue;
    const pdf = asPdfUrl(src, baseUrl);
    if (pdf) return pdf;
  }
  return null;
}

function filenameFromPdfUrl(pdfUrl: string): string {
  try {
    const last = new URL(pdfUrl).pathname.split("/").filter(Boolean).at(-1);
    if (last) return last.toLowerCase().endsWith(".pdf") ? last : `${last}.pdf`;
  } catch {
    // fall through
  }
  return "document.pdf";
}

export const embeddedPdfTranslator: Translator = {
  id: "embedded-pdf",
  label: "内嵌 PDF 查看器",
  match: () => true,
  // Fire only when the page is a PDF viewer shell: it embeds a `.pdf` AND carries
  // no citation metadata. The meta guard keeps a metadata-rich article page (which
  // might also embed a PDF preview) with the generic translator, whose CSL is
  // richer than the nothing we'd produce here.
  detect: ({ url, html }) =>
    !CITATION_META_RE.test(html) && findEmbeddedPdfUrl(html, url) !== null,
  async extract(ctx): Promise<TranslatorResult> {
    // detect() already confirmed a match; re-find for the resolved URL.
    const pdfUrl = findEmbeddedPdfUrl(ctx.html, ctx.url)!;
    return {
      metadata: {},
      identifier: null,
      resolverSource: "plugin-pdf-embed",
      attachments: [
        {
          kind: "pdf",
          url: pdfUrl,
          mime: "application/pdf",
          filename: filenameFromPdfUrl(pdfUrl),
        },
      ],
      // The embedded PDF is the only content; there's no landing-page metadata
      // to snapshot and no other link for the server to discover.
      allowGenericPdfDiscovery: false,
      allowRawHtmlFallback: false,
    };
  },
};
