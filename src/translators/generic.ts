// Fallback translator for any site without a dedicated adapter. Wraps the
// two-track meta-tag extractor (Highwire / Dublin Core / JSON-LD for English,
// rendered-text scrape for Chinese) that already lived in metadata-extract.ts
// but was never wired into the capture flow.

import { readMetaContents } from "../vendor/metadata-resolver/html-tag";
import { dspaceRestContentUrl } from "../vendor/metadata-resolver/pdf-candidates";

import { extractArxivId, extractMetadata } from "../metadata-extract.js";
import { resolvePublisherPdf } from "./publisher-pdf.js";
import type { Translator, TranslatorResult, Attachment } from "./types.js";

/**
 * Does the page carry scholarly-article signals? Only Highwire `citation_*`,
 * Dublin Core, PRISM, or a JSON-LD *ScholarlyArticle* count. `og:type=article`
 * and plain JSON-LD `Article`/`NewsArticle`/`BlogPosting` do NOT: every news
 * and blog page carries those, and misreading one as a paper files a
 * metadata-only entry with no attainable full text (a news page has no PDF) —
 * strictly worse than the unrecognized-page path, which archives a readable
 * single-file snapshot. When in doubt, refuse: a real paper page missed here
 * still gets its snapshot imported as a webpage entry.
 */
const SCHOLARLY_META_NAMES = [
  "citation_title",
  "citation_doi",
  "citation_pdf_url",
  "dc.title",
  "dc.identifier",
  "prism.doi",
  "bepress_citation_title",
];

function hasScholarlySignals(html: string): boolean {
  return (
    SCHOLARLY_META_NAMES.some((name) => readMetaContents(html, name).length > 0) ||
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?"@type"\s*:\s*"[^"]*ScholarlyArticle"/i.test(
      html,
    )
  );
}

function filenameFromTitle(title: string | undefined, ext: string): string {
  const slug = (title ?? "article")
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${slug || "article"}.${ext}`;
}

export const genericTranslator: Translator = {
  id: "generic",
  label: "通用网页",
  match: () => true,
  detect: ({ html }) => hasScholarlySignals(html),
  async extract(ctx): Promise<TranslatorResult> {
    const { metadata, pdfUrl, track } = extractMetadata({
      url: ctx.url,
      html: ctx.html,
    });

    // Publisher's own citation_pdf_url wins; otherwise fall back to a known
    // deterministic PDF URL for big publishers that omit that meta tag.
    const resolvedPdf =
      pdfUrl ?? resolvePublisherPdf({ url: ctx.url, doi: metadata.DOI ?? null });

    const attachments: Attachment[] = [];
    if (resolvedPdf) {
      attachments.push({
        kind: "pdf",
        url: resolvedPdf,
        mime: "application/pdf",
        filename: filenameFromTitle(metadata.title, "pdf"),
      });
      // DSpace repositories point citation_pdf_url at
      // /bitstreams/<uuid>/download, which some deployments answer with the SPA
      // shell instead of the file — queue the REST content endpoint behind it.
      const restPdf = dspaceRestContentUrl(resolvedPdf);
      if (restPdf) {
        attachments.push({
          kind: "pdf",
          url: restPdf,
          mime: "application/pdf",
          filename: filenameFromTitle(metadata.title, "pdf"),
        });
      }
    }

    // DOI wins; arXiv pages carry no citation_doi, so fall back to the arXiv id
    // (meta tag / page URL) — without it the server can't dedupe against the
    // metadata-only source an earlier import-by-identifier created.
    const arxivId = metadata.DOI ? null : extractArxivId({ url: ctx.url, html: ctx.html });
    const identifier = metadata.DOI ? metadata.DOI : arxivId ? `arXiv:${arxivId}` : null;

    return {
      metadata,
      identifier,
      resolverSource: track === "zh" ? "plugin-dom-zh" : "plugin-dom-en",
      attachments,
      // Generic pages: let the server's per-publisher rules find a PDF. No PDF
      // means this import stays metadata-only — the landing-page HTML is never
      // filed as the paper's full text; webpage captures are the
      // unrecognized-page path's business, not a recognized paper's.
      allowGenericPdfDiscovery: true,
      allowRawHtmlFallback: false,
    };
  },
};
