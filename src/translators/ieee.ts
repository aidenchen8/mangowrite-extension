// IEEE Xplore translator.
//
// Xplore ships *no* Highwire/Dublin Core/JSON-LD tags. The record used to live
// in an inline `xplGlobal.document.metadata = {...}` assignment; since 2026-09
// that block only carries session state ({"userInfo":{…}}) and the Angular app
// pulls the record from /rest/document/<arnumber>/metadata instead — so the
// translator fetches that endpoint same-origin, with the inline assignment
// kept as a fallback parser for whatever still inlines it.
//
// Pure/string-based → runs headless in the MV3 worker, unit-testable w/o a DOM.

import { canonicalizeUrl, extractCanonicalHint } from "../canonical-url.js";
import type { PartialCsl } from "../metadata-extract.js";
import type { Attachment, Translator, TranslatorResult } from "./types.js";

const ASSIGNMENT = /xplGlobal\.document\.metadata\s*=\s*\{/;

interface XplAuthor {
  name?: string;
  firstName?: string;
  lastName?: string;
}

interface XplMetadata {
  title?: string;
  doi?: string;
  publicationTitle?: string;
  volume?: string;
  issue?: string;
  startPage?: string;
  endPage?: string;
  publicationYear?: string;
  publisher?: string;
  authors?: XplAuthor[] | null;
  issn?: Array<{ format?: string; value?: string }> | null;
  pdfUrl?: string;
  articleNumber?: string;
  isConference?: boolean;
  abstract?: string;
}

/**
 * Slice the object literal that follows the assignment, balancing braces while
 * skipping over string contents — an abstract containing `{` would otherwise
 * end the scan early.
 */
export function extractXplMetadata(html: string): XplMetadata | null {
  const m = html.match(ASSIGNMENT);
  if (m?.index === undefined) return null;

  const start = m.index + m[0].length - 1; // at the "{"
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const ch = html[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1)) as XplMetadata;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parseAuthors(authors: XplAuthor[] | null | undefined): PartialCsl["author"] {
  if (!authors?.length) return undefined;
  return authors.map((a) => {
    if (a.lastName) return { family: a.lastName, given: a.firstName ?? "" };
    const name = (a.name ?? "").trim();
    const parts = name.split(/\s+/);
    if (parts.length >= 2) return { given: parts.slice(0, -1).join(" "), family: parts.at(-1)! };
    return { literal: name };
  });
}

function toCsl(meta: XplMetadata): PartialCsl {
  const out: PartialCsl = {
    type: meta.isConference ? "paper-conference" : "article-journal",
  };

  if (meta.title) out.title = meta.title;
  const authors = parseAuthors(meta.authors);
  if (authors?.length) out.author = authors;
  if (meta.publicationTitle) out["container-title"] = meta.publicationTitle;
  if (meta.volume) out.volume = meta.volume;
  if (meta.issue) out.issue = meta.issue;
  if (meta.startPage) {
    out.page =
      meta.endPage && meta.endPage !== meta.startPage
        ? `${meta.startPage}-${meta.endPage}`
        : meta.startPage;
  }

  const year = Number(meta.publicationYear);
  if (Number.isFinite(year) && year > 1000) out.issued = { "date-parts": [[year]] };

  if (meta.doi) out.DOI = meta.doi.toLowerCase();
  if (meta.publisher) out.publisher = meta.publisher;
  if (meta.abstract) out.abstract = meta.abstract;

  const issns = (meta.issn ?? [])
    .map((i) => i.value?.trim())
    .filter((v): v is string => /^\d{4}-\d{3}[\dXx]$/.test(v ?? ""))
    .map((v) => v.toUpperCase());
  if (issns.length) out.ISSN = [...new Set(issns)];

  return out;
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** /document/10286823 → "10286823". */
export function arnumberFromUrl(url: string): string | null {
  return url.match(/\/document\/(\d{4,12})(?:\/|$)/)?.[1] ?? null;
}

/**
 * 2026-09 起文章题录不再内嵌：SSR 里的 `xplGlobal.document.metadata` 只剩
 * 会话信息（{"userInfo":{...}}，document/10286823 实测），题录改由 Angular
 * 从 REST 端点拉取。同源 fetch 带页面 cookie 与 Cloudflare 放行状态，与
 * 页面自己的 XHR 同权；`X-Security-Request` 是该端点的固定守卫头，缺了回 403。
 */
async function fetchRestMetadata(
  ctx: { url: string; fetchText: (url: string, init?: RequestInit) => Promise<string> },
): Promise<XplMetadata | null> {
  const arnumber = arnumberFromUrl(ctx.url);
  if (!arnumber) return null;
  try {
    const raw = await ctx.fetchText(`/rest/document/${arnumber}/metadata`, {
      headers: { Accept: "application/json", "X-Security-Request": "true" },
    });
    const parsed = JSON.parse(raw) as XplMetadata;
    // 挑战页/登录墙也可能回 200 + HTML 被 JSON.parse 拒掉；能 parse 但没题录
    // （userInfo-only）同样不算数。
    return typeof parsed?.title === "string" && parsed.title.trim() ? parsed : null;
  } catch {
    return null;
  }
}

export const ieeeTranslator: Translator = {
  id: "ieee",
  label: "IEEE Xplore",
  match: (url) => /(^|\.)ieee\.org$/i.test(host(url)),
  // The assignment alone is the signal — it's Xplore-specific and survives a
  // WebVPN rewrite where the host is no longer ieee.org (see cnki.ts). Since
  // 2026-09 it carries only session state, but it's still the SSR shell's
  // marker on every Xplore document page.
  detect: ({ html }) => ASSIGNMENT.test(html),
  async extract(ctx): Promise<TranslatorResult> {
    // REST first (the only source with the record since the 2026-09 change),
    // embedded assignment as the fallback for deployments/stale caches that
    // still inline the record.
    const meta = (await fetchRestMetadata(ctx)) ?? extractXplMetadata(ctx.html);
    const metadata = meta?.title ? toCsl(meta) : {};

    if (!metadata.URL) {
      metadata.URL = canonicalizeUrl(ctx.url, {
        canonicalHint: extractCanonicalHint(ctx.html),
      });
    }

    const attachments: Attachment[] = [];
    // `pdfUrl` is the stamp.jsp viewer entry. It does NOT 302 to the file — it
    // serves an HTML shell whose `<iframe src=".../<id>.pdf?<jwt>">` is the real
    // PDF. downloadAttachment follows that one hop (resolveEmbeddedPdf) for
    // entitled sessions; an unentitled one gets a paywall there and falls back
    // to metadata-only.
    if (meta?.pdfUrl) {
      attachments.push({
        kind: "pdf",
        url: new URL(meta.pdfUrl, ctx.url).toString(),
        mime: "application/pdf",
        filename: `${meta.articleNumber ?? arnumberFromUrl(ctx.url) ?? "ieee"}.pdf`,
      });
    }

    return {
      metadata,
      identifier: metadata.DOI ?? null,
      resolverSource: "plugin-dom-en",
      attachments,
      // Everything came from the embedded record; the DOM is an Angular shell.
      allowGenericPdfDiscovery: false,
      allowRawHtmlFallback: false,
    };
  },
};
