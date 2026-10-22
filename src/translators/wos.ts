// Web of Science (Clarivate) full-record translator.
//
// WoS is an *index*, not a publisher: the full-record page ships exactly one
// meta tag (`viewport`), no Highwire/DC/JSON-LD and no JSON blob, so `generic`
// rejects it outright. Everything the record holds is rendered by its Angular
// app into elements carrying stable `data-ta` test hooks — which is what we
// read here.
//
// Two properties of WoS data shape this adapter:
//   * It normalizes destructively — journal names are upper-cased ("NATURE")
//     and given names collapse to initials ("Harris, CR"). We still emit them,
//     because the backend merge ranks CrossRef above `plugin-dom-en` on
//     bib-core fields for non-Chinese works (see metadata-resolver/merge.ts),
//     so a resolvable DOI silently replaces both. When the record has no DOI
//     they are all the caller gets, which beats nothing.
//   * It hosts no full text. No attachment is ever produced, and neither
//     fallback is allowed: the DOM is an Angular shell, and server-side PDF
//     discovery would probe the WoS URL rather than the publisher's.
//
// Pure/string-based → runs headless in the MV3 worker, unit-testable w/o a DOM.

import { canonicalizeUrl, extractCanonicalHint } from "../canonical-url.js";
import { decodeEntities, type PartialCsl } from "../metadata-extract.js";
import { innerTextAt } from "./html-text.js";
import type { Translator, TranslatorResult } from "./types.js";

const TITLE_HOOK = 'data-ta="FullRTa-fullRecordtitle-';

/** Text of the single element tagged `data-ta="<hook>"`. */
function byHook(html: string, hook: string): string | null {
  const at = html.indexOf(`data-ta="${hook}"`);
  if (at < 0) return null;
  const openTagEnd = html.indexOf(">", at);
  if (openTagEnd < 0) return null;
  return innerTextAt(html, openTagEnd + 1) || null;
}

/**
 * Author display names, in page order. WoS repeats the same `data-ta` inside
 * the collapsed "show more" list, so index into a map rather than pushing.
 */
function authors(html: string): PartialCsl["author"] {
  const hook = /data-ta="SumAuthTa-DisplayName-author-[a-z]{2}-(\d+)"/gi;
  const byIndex = new Map<number, string>();
  let m: RegExpExecArray | null;
  while ((m = hook.exec(html))) {
    const i = Number(m[1]);
    if (byIndex.has(i)) continue;
    const openTagEnd = html.indexOf(">", m.index);
    const name = openTagEnd < 0 ? "" : innerTextAt(html, openTagEnd + 1);
    if (name) byIndex.set(i, name);
  }
  if (!byIndex.size) return undefined;

  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, name]) => {
      // "Harris, CR" / "van der Walt, SJ" — always "Family, Initials".
      const comma = name.indexOf(",");
      if (comma < 0) return { literal: name };
      return { family: name.slice(0, comma).trim(), given: name.slice(comma + 1).trim() };
    });
}

/**
 * Journal name, read off the "search this source" link rather than the visible
 * node — the visible one is wrapped in a JCR side-nav whose markup shifts. The
 * href embeds a URI-encoded query: `…%22rowField%22:%22SO%22,%22rowText%22:%22NATURE%22…`
 */
function journal(html: string): string | undefined {
  const m = decodeEntities(html).match(
    /%22rowField%22:%22SO%22,%22rowText%22:%22([^%]+(?:%(?!22)[\da-f]{2}[^%]*)*)%22/i,
  );
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]!).trim() || undefined;
  } catch {
    return m[1]!.trim() || undefined;
  }
}

/** WoS "Document Type" → CSL type. Anything else stays a journal article. */
function cslType(html: string): PartialCsl["type"] {
  const doctype = byHook(html, "FullRTa-doctype-0")?.toLowerCase() ?? "";
  if (doctype.includes("proceedings")) return "paper-conference";
  if (doctype.includes("book")) return "chapter";
  return "article-journal";
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export const wosTranslator: Translator = {
  id: "wos",
  label: "Web of Science",
  match: (url) =>
    /(^|\.)webofscience\.com$/i.test(host(url)) ||
    /(^|\.)webofscience\.clarivate\.cn$/i.test(host(url)),
  // The title hook alone is the signal — WoS-specific, and it survives both the
  // clarivate.cn mirror and a WebVPN rewrite where the host is neither.
  detect: ({ html }) => html.includes(TITLE_HOOK),
  async extract(ctx): Promise<TranslatorResult> {
    const { html } = ctx;
    const metadata: PartialCsl = { type: cslType(html) };

    const title = byHook(html, "FullRTa-fullRecordtitle-0");
    if (title) metadata.title = title;

    const author = authors(html);
    if (author?.length) metadata.author = author;

    const containerTitle = journal(html);
    if (containerTitle) metadata["container-title"] = containerTitle;

    const volume = byHook(html, "FullRTa-volume");
    if (volume) metadata.volume = volume;

    const issue = byHook(html, "FullRTa-issue");
    if (issue) metadata.issue = issue;

    const page = byHook(html, "FullRTa-pageNo");
    if (page) metadata.page = page;

    // "SEP 17 2020", "2020", "NOV 2019" — only the year is dependable.
    const year = Number(byHook(html, "FullRTa-pubdate")?.match(/\b(1[5-9]\d{2}|20\d{2})\b/)?.[1]);
    if (Number.isFinite(year)) metadata.issued = { "date-parts": [[year]] };

    const doi = byHook(html, "FullRTa-DOI")?.match(/\b(10\.\d{4,9}\/\S+)\b/)?.[1];
    if (doi) metadata.DOI = doi.toLowerCase();

    const abstract = byHook(html, "FullRTa-abstract-basic");
    if (abstract) metadata.abstract = abstract;

    metadata.URL = canonicalizeUrl(ctx.url, { canonicalHint: extractCanonicalHint(html) });

    return {
      metadata,
      identifier: metadata.DOI ?? null,
      resolverSource: "plugin-dom-en",
      attachments: [],
      allowGenericPdfDiscovery: false,
      allowRawHtmlFallback: false,
    };
  },
};
