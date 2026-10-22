// 国家哲学社会科学文献中心 (ncpssd.cn) translator.
//
// Like WoS, ncpssd is an *index*: its only meta tags describe the site itself
// (`<title>国家哲学社会科学文献中心</title>`, `author=中国社会科学院图书馆`), so `generic`
// rejects it — and would have captured the library as the paper's author if it
// hadn't. The record is rendered into `<p>` elements carrying stable, spelled-out
// ids (`p_creator`, `p_year`, `p_page`…), which is what we read.
//
// Shape notes:
//   * Every record is bilingual. `h2_title_c`/`p_creator`'s first line hold the
//     work's own language; `h3_title_e`/`p_creator`'s second line hold the
//     publisher-supplied English rendering. CSL has one title slot, so we keep
//     the primary and drop the translation.
//   * There is no DOI anywhere on the page, so nothing downstream can repair a
//     bad field — 卷/期/页 must be read correctly here or not at all.
//   * Full text is behind `#a_down`, an `<a>` with no href whose click handler
//     calls an authenticated JSON API. We surface no attachment rather than
//     guess a URL, and we forbid the raw-HTML fallback: the page carries the
//     abstract only.
//
// Pure/string-based → runs headless in the MV3 worker, unit-testable w/o a DOM.

import { canonicalizeUrl, extractCanonicalHint } from "../canonical-url.js";
import type { PartialCsl } from "../metadata-extract.js";
import { innerHtmlById, innerTextById, stripMarkup } from "./html-text.js";
import type { Translator, TranslatorResult } from "./types.js";

/** The `<h1>` holding the record's own-language title — present only on articleinfo. */
const TITLE_ID = "h2_title_c";

const TYPE_MAP: Array<[RegExp, PartialCsl["type"]]> = [
  [/thesis|degree|dissertation/i, "thesis"],
  [/conference|proceeding/i, "paper-conference"],
  [/book|ancient/i, "book"],
];

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function hasCjk(text: string): boolean {
  return /[一-鿿]/.test(text);
}

/** Value of the hidden `<input id="…">` ncpssd stamps the route params into. */
function hiddenValue(html: string, id: string): string | null {
  const tag = html.match(new RegExp(`<input\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i"))?.[0];
  const value = tag?.match(/\bvalue=["']([^"']*)["']/i)?.[1];
  return value ? stripMarkup(value) : null;
}

/** Inner HTML of `#id` with its bold `全角` field label (`作　　者：`) removed. */
function fieldHtml(html: string, id: string): string | null {
  const inner = innerHtmlById(html, id);
  if (inner === null) return null;
  return inner.replace(/<strong\b[^>]*>[\s\S]*?<\/strong>/i, "");
}

/** Text of `#id` minus its field label. */
function fieldText(html: string, id: string): string | null {
  const inner = fieldHtml(html, id);
  return inner === null ? null : stripMarkup(inner) || null;
}

/** `先前经验对新产品开发绩效的影响机制<i>中文期刊文章</i>` — the `<i>` is a type badge. */
function title(html: string): string | null {
  const inner = innerHtmlById(html, TITLE_ID);
  if (inner === null) return null;
  return stripMarkup(inner.replace(/<i\b[^>]*>[\s\S]*?<\/i>/gi, "")) || null;
}

function toAuthor(name: string): NonNullable<PartialCsl["author"]>[number] {
  if (hasCjk(name)) return { literal: name };
  // "Li Yanni" is a romanized family-first name with no comma to split on;
  // guessing would swap it. Only an explicit "Family, Given" is safe.
  const comma = name.indexOf(",");
  if (comma < 0) return { literal: name };
  return { family: name.slice(0, comma).trim(), given: name.slice(comma + 1).trim() };
}

/**
 * `作　　者：李艳妮[1];徐兰香[2]<br>Li Yanni[1];Xu Lanxiang[2]` — two `<br>`-separated
 * lines, own-language first. `[1]` indexes into `#p_institutions`.
 */
function authors(html: string, wantCjk: boolean): PartialCsl["author"] {
  const inner = fieldHtml(html, "p_creator");
  if (!inner) return undefined;
  const lines = inner
    .split(/<br\s*\/?>/i)
    .map(stripMarkup)
    .filter(Boolean);
  const line = lines.find((l) => hasCjk(l) === wantCjk) ?? lines[0];
  if (!line) return undefined;

  const names = line
    .replace(/\[[\d,\s]+\]/g, "")
    .split(/[;；]/)
    .map((n) => n.trim())
    .filter(Boolean);
  return names.length ? names.map(toAuthor) : undefined;
}

/** `《科研管理》 (Science Research Management)` → `科研管理`. */
function containerTitle(html: string): string | undefined {
  const text = fieldText(html, "p_media");
  if (!text) return undefined;
  const bracketed = text.match(/《([^》]+)》/)?.[1];
  return (bracketed ?? text.split(" (")[0])?.trim() || undefined;
}

/** `2023年第044卷第3期` — volume is zero-padded on the page but not in CSL. */
function yearVolumeIssue(html: string): Pick<PartialCsl, "issued" | "volume" | "issue"> {
  const text = fieldText(html, "p_year") ?? "";
  const out: Pick<PartialCsl, "issued" | "volume" | "issue"> = {};
  const year = Number(text.match(/(\d{4})\s*年/)?.[1]);
  if (Number.isFinite(year)) out.issued = { "date-parts": [[year]] };
  const volume = text.match(/第\s*0*(\d+)\s*卷/)?.[1];
  if (volume) out.volume = volume;
  const issue = text.match(/第\s*0*(\d+)\s*期/)?.[1];
  if (issue) out.issue = issue;
  return out;
}

/** `142-150页`, or a lone `142页` for one-page notes. */
function page(html: string): string | undefined {
  const text = fieldText(html, "p_page") ?? "";
  const range = text.match(/(\d{1,6})\s*[-–—]\s*(\d{1,6})/);
  if (range) return `${range[1]}-${range[2]}`;
  return text.match(/(\d{1,6})\s*页/)?.[1];
}

/**
 * Each keyword is its own `<font>`; the English rendering trails a `<br>` as one
 * `;`-joined run, which CSL has no slot for. Taking only the `<font>`s therefore
 * also drops the translation.
 */
function keywords(html: string): string[] | undefined {
  const inner = fieldHtml(html, "p_keyword");
  if (!inner) return undefined;
  const words = [...inner.matchAll(/<font\b[^>]*>([\s\S]*?)<\/font>/gi)]
    .map((m) => stripMarkup(m[1]!))
    .filter(Boolean);
  return words.length ? words : undefined;
}

/**
 * `#p_remark` is the own-language abstract and `#p_remarke` the English one —
 * but on a 外文期刊文章 record "own language" *is* English, so match on script
 * rather than trusting the id suffix.
 */
function abstract(html: string, wantCjk: boolean): string | undefined {
  const candidates = [fieldText(html, "p_remark"), fieldText(html, "p_remarke")].filter(
    (t): t is string => Boolean(t),
  );
  return candidates.find((t) => hasCjk(t) === wantCjk) ?? candidates[0];
}

function cslType(html: string): PartialCsl["type"] {
  const raw = `${hiddenValue(html, "ftl_urlType") ?? ""} ${hiddenValue(html, "ftl_urlTypename") ?? ""}`;
  for (const [pattern, type] of TYPE_MAP) if (pattern.test(raw)) return type;
  return "article-journal";
}

export const ncpssdTranslator: Translator = {
  id: "ncpssd",
  label: "国家哲学社会科学文献中心",
  match: (url) => /(^|\.)ncpssd\.(cn|org)$/i.test(host(url)),
  // The title element is the signal: it exists only on an article page, and its
  // id is ncpssd-specific. Requiring text also rejects the pre-render shell.
  detect: ({ html }) => Boolean(title(html)),
  async extract(ctx): Promise<TranslatorResult> {
    const { html } = ctx;
    const primaryTitle = title(html);
    const zh = hasCjk(primaryTitle ?? "");

    const metadata: PartialCsl = { type: cslType(html) };
    if (primaryTitle) metadata.title = primaryTitle;
    if (zh) metadata.language = "zh";

    const author = authors(html, zh);
    if (author?.length) metadata.author = author;

    const container = containerTitle(html);
    if (container) metadata["container-title"] = container;

    Object.assign(metadata, yearVolumeIssue(html));

    const pages = page(html);
    if (pages) metadata.page = pages;

    const summary = abstract(html, zh);
    if (summary) metadata.abstract = summary;

    const words = keywords(html);
    if (words) metadata.keywords = words;

    metadata.URL = canonicalizeUrl(ctx.url, { canonicalHint: extractCanonicalHint(html) });

    return {
      metadata,
      identifier: null,
      resolverSource: zh ? "plugin-dom-zh" : "plugin-dom-en",
      attachments: [],
      allowGenericPdfDiscovery: false,
      allowRawHtmlFallback: false,
    };
  },
};
