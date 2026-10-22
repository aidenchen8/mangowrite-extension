// Git-host PDF file-page translator.
//
// Papers increasingly live in a git repo instead of a journal site (big-lab
// preprints posted straight to GitHub). The blob page — e.g.
// https://github.com/cordiverse/paper/blob/main/paper.pdf — is an HTML file
// viewer: it carries no citation metadata (generic rejects it) and its PDF
// preview is rendered client-side from a `viewscreen.githubusercontent.com`
// URL that isn't a `.pdf` (embedded-pdf can't see it either). The bytes are
// public at the repo's raw URL, so we map the file-view URL to it and emit
// the raw PDF as the sole attachment; metadata is resolved server-side from
// the PDF, same as embedded-pdf.
//
// (Direct raw links — raw.githubusercontent.com etc. serving application/pdf
// — never reach this translator: the tab runs no content script and the
// popup's import-pdf-url path takes them.)
//
// Branch names may contain slashes, so the ref/path split in
// /blob/<ref>/<path> is not statically decidable. GitHub ships the resolved
// `rawBlobUrl` (…/raw/refs/heads/main/paper.pdf) in its embedded JSON
// payload, which is why that is the primary source; the URL rewrite is the
// degraded fallback and assumes a single-segment ref. GitLab / Gitee have no
// verified payload hook yet — URL rewrite only, same caveat. Self-hosted
// instances (gitlab.<org>.com) can't be enumerated by host and are out of
// scope. Pure/string-based → unit-testable without a DOM.

import type { Translator, TranslatorResult } from "./types.js";

interface HostRule {
  id: string;
  /** Hostname test (subdomains included). */
  host: RegExp;
  /** Is this URL path a file-view page for a `.pdf`? */
  pageUrl: (pathname: string) => boolean;
  /** Raw download URL for the file, or null when it can't be derived. */
  resolve: (input: { url: URL; html: string }) => string | null;
}

/** Decode one JSON string body (handles \u0026-style escapes in embedded payloads). */
function decodeJsonString(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(`"${raw}"`);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** GitHub's embedded payload declares the resolved raw URL of the viewed blob. */
function githubRawBlobUrl(html: string): string | null {
  const m = html.match(/"rawBlobUrl"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!m) return null;
  const decoded = decodeJsonString(m[1]!);
  if (!decoded) return null;
  try {
    const url = new URL(decoded);
    return url.protocol === "https:" && /\.pdf$/i.test(url.pathname) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** /owner/repo/blob/<ref>/<path>.pdf → /owner/repo/raw/<ref>/<path>.pdf (single-segment ref). */
function rewriteSegment(pathname: string, from: string, to: string): string | null {
  const i = pathname.indexOf(from);
  if (i < 0) return null;
  return pathname.slice(0, i) + to + pathname.slice(i + from.length);
}

const HOST_RULES: HostRule[] = [
  {
    id: "github",
    host: /(^|\.)github\.com$/i,
    pageUrl: (p) => /^\/[^/]+\/[^/]+\/blob\/[^?#]*\.pdf$/i.test(p),
    resolve: ({ url, html }) => {
      const declared = githubRawBlobUrl(html);
      if (declared) return declared;
      const path = rewriteSegment(url.pathname, "/blob/", "/raw/");
      return path ? `${url.origin}${path}` : null;
    },
  },
  {
    id: "gitlab",
    host: /(^|\.)gitlab\.com$/i,
    pageUrl: (p) => /\/-\/blob\/[^?#]*\.pdf$/i.test(p),
    resolve: ({ url }) => {
      const path = rewriteSegment(url.pathname, "/-/blob/", "/-/raw/");
      return path ? `${url.origin}${path}` : null;
    },
  },
  {
    id: "gitee",
    host: /(^|\.)gitee\.com$/i,
    pageUrl: (p) => /^\/[^/]+\/[^/]+\/blob\/[^?#]*\.pdf$/i.test(p),
    resolve: ({ url }) => {
      const path = rewriteSegment(url.pathname, "/blob/", "/raw/");
      return path ? `${url.origin}${path}` : null;
    },
  },
];

function ruleFor(url: URL): HostRule | null {
  for (const rule of HOST_RULES) {
    if (rule.host.test(url.hostname) && rule.pageUrl(url.pathname)) return rule;
  }
  return null;
}

function filenameFromPdfPath(pathname: string): string {
  const last = pathname.split("/").filter(Boolean).at(-1);
  if (!last) return "document.pdf";
  const decoded = (() => {
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  })();
  return decoded.toLowerCase().endsWith(".pdf") ? decoded : `${decoded}.pdf`;
}

export const hostedPdfTranslator: Translator = {
  id: "hosted-pdf",
  label: "Git 托管 PDF",
  match: (url) => {
    try {
      return ruleFor(new URL(url)) !== null;
    } catch {
      return false;
    }
  },
  detect: ({ url }) => {
    try {
      return ruleFor(new URL(url)) !== null;
    } catch {
      return false;
    }
  },
  async extract(ctx): Promise<TranslatorResult> {
    const url = new URL(ctx.url);
    const rule = ruleFor(url);
    const pdfUrl = rule?.resolve({ url, html: ctx.html });
    if (!pdfUrl) {
      // detect() matched the page shape but resolve() found nothing (payload
      // absent, path oddity) — stay recognized but attachment-less so the
      // import lands metadata-poor rather than as a raw-HTML webpage capture.
      return {
        metadata: {},
        identifier: null,
        resolverSource: "plugin-git-pdf",
        attachments: [],
        allowGenericPdfDiscovery: false,
        allowRawHtmlFallback: false,
      };
    }
    const filename = filenameFromPdfPath(new URL(pdfUrl).pathname);
    return {
      // Empty, like embedded-pdf — NOT a filename-derived placeholder title.
      // Any non-empty metadata makes the server treat the capture as an
      // authoritative bibliography (stamped `resolved: true`), which freezes it
      // and skips the post-parse title/DOI mining — the paper would sit in the
      // library forever as "paper". A git blob page has no bibliography; the
      // PDF the server parses does.
      metadata: {},
      identifier: null,
      resolverSource: "plugin-git-pdf",
      attachments: [{ kind: "pdf", url: pdfUrl, mime: "application/pdf", filename }],
      // The raw URL is the content; there is no publisher site to discover
      // from and the viewer HTML is never the paper's full text.
      allowGenericPdfDiscovery: false,
      allowRawHtmlFallback: false,
    };
  },
};
