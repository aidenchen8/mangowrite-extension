// Zotero-connectors–inspired multi-site translator framework.
//
// A translator inspects a page (URL + raw HTML string) and produces the
// bibliographic metadata plus an ordered list of full-text *attachment
// descriptors* — it does NOT download bytes itself. Downloading (cross-origin,
// credentialed) happens later in the background service worker, so the
// translator stays pure/string-based and unit-testable in a Node environment
// (no DOM), matching the rest of the extension (see metadata-extract.ts).

import type { PartialCsl } from "../metadata-extract.js";

export type { PartialCsl };

/**
 * A full-text attachment the background worker should try to fetch, in the
 * order given. `url` attachments are downloaded (credentialed) by the
 * background worker; `inlineHtml` attachments carry their bytes already (used
 * for the generic raw-page-HTML fallback).
 */
export interface Attachment {
  /** "pdf" → routed to MinerU; "html" → routed to the html-structure-adapter. */
  kind: "pdf" | "html";
  /** Fetch this URL for the bytes (bar.cnki.net order links, citation_pdf_url…). */
  url?: string;
  /** …or the HTML is already in hand (generic page-snapshot fallback). */
  inlineHtml?: string;
  mime: string;
  filename: string;
}

export interface TranslatorResult {
  /** Best-effort CSL metadata for the work (authoritative for this import). */
  metadata: PartialCsl;
  /** DOI/arXiv identifier if the page exposes one, else null. */
  identifier: string | null;
  /** Provenance stamp for the backend field-merge (e.g. "plugin-dom-zh"). */
  resolverSource: string;
  /** Full-text candidates, most-preferred first (PDF before HTML for CNKI). */
  attachments: Attachment[];
  /**
   * When no attachment resolves, may the background worker fall back to the
   * server-side publisher PDF discovery (/extract-pdf)? Generic sites: yes.
   * Site translators that already know their download links: no.
   */
  allowGenericPdfDiscovery: boolean;
  /**
   * When nothing else resolves, may we upload the raw page HTML as the
   * captured content? Only the unrecognized-page (webpage) capture sets this —
   * a recognized paper without a PDF stays metadata-only; its landing-page
   * HTML is never filed as the full text.
   */
  allowRawHtmlFallback: boolean;
}

export interface TranslatorContext {
  /** The observed page URL. */
  url: string;
  /** `document.documentElement.outerHTML` captured in the content script. */
  html: string;
  /**
   * Same-origin credentialed text fetch, injected by the content script (so
   * cookies + a correct Referer are sent). Tests supply a mock.
   */
  fetchText: (url: string, init?: RequestInit) => Promise<string>;
}

export interface Translator {
  id: string;
  label: string;
  /** Cheap host/URL test to pick a translator without touching the DOM. */
  match: (url: string) => boolean;
  /** Is this actually an importable article page? */
  detect: (ctx: Pick<TranslatorContext, "url" | "html">) => boolean;
  extract: (ctx: TranslatorContext) => Promise<TranslatorResult>;
}
