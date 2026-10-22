// Byte-level PDF sniffing + tab-document classification for the direct-PDF
// import path.
//
// When the active tab IS a PDF (Chrome's native viewer renders a
// `application/pdf` response), the page has no scholarly DOM to snapshot — the
// popup must hand the tab URL to the background, which fetches the bytes and
// confirms they're really a PDF before enqueueing. We check the `%PDF-` magic
// rather than trusting the Content-Type header: signed object-store links
// (academia.edu → CloudFront, etc.) set the type via a `response-content-*`
// query param that can be spoofed or wrong, and some paywalls return an HTML
// login page with a `.pdf` URL. Pure/unit-testable.

/** How the active tab's main document should be imported. */
export type TabDocumentKind = "pdf" | "html" | "unknown";

/** `%PDF-` header bytes. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

/**
 * True when `bytes` begins with the PDF signature. The spec allows leading
 * junk before `%PDF-`, so we scan the first 1KB rather than only offset 0.
 */
export function looksLikePdfBytes(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - PDF_MAGIC.length, 1024);
  for (let i = 0; i <= limit; i++) {
    let match = true;
    for (let j = 0; j < PDF_MAGIC.length; j++) {
      if (bytes[i + j] !== PDF_MAGIC[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/**
 * Classify a main-frame response by its Content-Type — the same fact Chrome
 * used to decide whether to render the native PDF viewer. `application/pdf`
 * (parameters ignored) is the only kind that renders in-viewer and is
 * byte-fetchable at the tab URL; text documents are webpages; anything else
 * (octet-stream, missing header) usually downloads rather than navigating, so
 * it stays "unknown" for the URL/DOM heuristics to arbitrate.
 */
export function documentKindFromContentType(contentType: string | null | undefined): TabDocumentKind {
  if (!contentType) return "unknown";
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/html" || mime === "application/xhtml+xml" || mime.startsWith("text/")) {
    return "html";
  }
  return "unknown";
}

/**
 * Path-only `.pdf` suffix check (query string excluded, so `.pdf?sequence=1`
 * counts; case-insensitive). A fallback heuristic for when the recorded
 * Content-Type fact is missing — never authoritative, since paywalls serve
 * HTML at `.pdf` URLs and real PDFs live at extension-less URLs.
 */
export function urlPathnameLooksLikePdf(url: string | null | undefined): boolean {
  if (!url || !/^https?:/i.test(url)) return false;
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}
