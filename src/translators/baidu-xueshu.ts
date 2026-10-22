// 百度学术 (xueshu.baidu.com) translator.
//
// Baidu 学术 is a search aggregator. Its detail page ships two meta tags
// (`charset`, `viewport`) and a Nuxt payload with `serverRendered: false`, so
// there is nothing for `generic` to read — the record exists only in the DOM
// the SPA renders.
//
// Hook choice matters here. Every element carries a `data-v-<hash>` scoped-style
// attribute (`data-v-7501f8f8`), and those hashes are derived from the file
// contents at build time: they change whenever Baidu ships a CSS edit. We key on
// the author-written class names (`title-wrap`, `paper-type`, `label`/`detail`)
// instead, and read each field by its **visible Chinese label** rather than by
// position, because the item list is sparse — a paper with no DOI simply has no
// `DOI：` row.
//
// Shape notes:
//   * No 卷/期/页 anywhere. Chinese records therefore stay at 5/8 citation
//     fields: the backend skips DOI enrichment for `language: "zh"` (Chinese
//     bib-core must come from the origin site, D1), and Baidu is an aggregator,
//     not the origin. A DOI is still worth emitting for de-duplication.
//   * The title links to whichever site Baidu found the text on (百度文库, a
//     publisher, a repository). That is not a PDF and not ours to guess at, so
//     no attachment is produced and generic PDF discovery stays off — it would
//     probe the Baidu URL, not the publisher's.
//
// Pure/string-based → runs headless in the MV3 worker, unit-testable w/o a DOM.

import { canonicalizeUrl, extractCanonicalHint } from "../canonical-url.js";
import type { PartialCsl } from "../metadata-extract.js";
import { classOpenTag, innerHtmlOf, innerTextAt, stripMarkup } from "./html-text.js";
import type { Translator, TranslatorResult } from "./types.js";

/** `<span class="paper-type paper-type-1">期刊</span>` → CSL type. */
const TYPE_MAP: Array<[string, PartialCsl["type"]]> = [
  ["期刊", "article-journal"],
  ["会议", "paper-conference"],
  ["学位论文", "thesis"],
  ["专利", "patent"],
  ["图书", "book"],
  ["报纸", "article-newspaper"],
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

/**
 * The `<div class="detail">` sibling of the `<div class="label">` whose text is
 * `label`. Rows are `<div class="item"><div class="label">DOI：</div><div
 * class="detail">…</div></div>`; long values additionally nest an
 * `atomic-line-collapse-container` alongside a "展开" fold button, and that
 * button's text must not leak into the value.
 */
function rowHtml(html: string, label: string): string | null {
  const at = html.search(
    new RegExp(`<div\\b[^>]*\\bclass=["']label["'][^>]*>\\s*${label}\\s*</div>`, "i"),
  );
  if (at < 0) return null;
  const rest = html.slice(at);
  const detail = innerHtmlOf(rest, classOpenTag("detail", "div"));
  if (detail === null) return null;
  return innerHtmlOf(detail, classOpenTag("atomic-line-collapse-container", "div")) ?? detail;
}

function rowText(html: string, label: string): string | null {
  const inner = rowHtml(html, label);
  return inner === null ? null : stripMarkup(inner) || null;
}

/**
 * The record subtree. Everything below it on the page — 引用走势, 相关论文 — reuses
 * the same class names, so an unscoped lookup for `source` or `title` would pick
 * up a recommendation card instead of this paper.
 */
function record(html: string): string {
  return innerHtmlOf(html, classOpenTag("detail-wrap", "div")) ?? html;
}

/** `<div class="title-wrap"><a class="title"><span>…</span></a></div>` */
function title(html: string): string | null {
  const wrap = innerHtmlOf(html, classOpenTag("title-wrap", "div"));
  if (wrap === null) return null;
  const anchor = innerHtmlOf(wrap, classOpenTag("title", "a"));
  return anchor === null ? null : stripMarkup(anchor) || null;
}

/** Authors are `<a class="detail-link"><span>刘建伟</span></a>` joined by `、`. */
function authors(html: string): PartialCsl["author"] {
  const inner = rowHtml(html, "作者：");
  if (!inner) return undefined;
  const linked = [...inner.matchAll(/<a\b[^>]*\bclass=["'][^"']*\bdetail-link\b[^"']*["'][^>]*>/gi)]
    .map((m) => innerTextAt(inner, m.index + m[0].length))
    .filter(Boolean);
  // Unlinked authors (Baidu has no author page for them) render as bare text.
  const names = linked.length
    ? linked
    : stripMarkup(inner)
        .split(/[、,;；]/)
        .map((n) => n.trim())
        .filter(Boolean);
  if (!names.length) return undefined;

  return names.map((name) => {
    if (hasCjk(name)) return { literal: name };
    const comma = name.indexOf(",");
    if (comma < 0) return { literal: name };
    return { family: name.slice(0, comma).trim(), given: name.slice(comma + 1).trim() };
  });
}

function cslType(html: string): PartialCsl["type"] {
  const badge = innerHtmlOf(html, classOpenTag("paper-type"));
  const text = badge === null ? "" : stripMarkup(badge);
  for (const [needle, type] of TYPE_MAP) if (text.includes(needle)) return type;
  return "article-journal";
}

export const baiduXueshuTranslator: Translator = {
  id: "baidu-xueshu",
  label: "百度学术",
  match: (url) => /(^|\.)xueshu\.baidu\.com$/i.test(host(url)),
  // Three co-occurring class names, all specific to the detail view. `title-wrap`
  // alone appears on search-result cards too.
  detect: ({ html }) =>
    html.includes('class="detail-wrap"') &&
    html.includes('class="title-wrap"') &&
    /class="paper-type/.test(html),
  async extract(ctx): Promise<TranslatorResult> {
    const html = record(ctx.html);
    const primaryTitle = title(html);
    const zh = hasCjk(primaryTitle ?? "");

    const metadata: PartialCsl = { type: cslType(html) };
    if (primaryTitle) metadata.title = primaryTitle;
    if (zh) metadata.language = "zh";

    const author = authors(html);
    if (author?.length) metadata.author = author;

    // `<a class="source">计算机应用研究</a>` — the journal, linked to its Baidu page.
    const source = innerHtmlOf(html, classOpenTag("source", "a"));
    if (source !== null && stripMarkup(source)) metadata["container-title"] = stripMarkup(source);

    const year = Number(rowText(html, "年份：")?.match(/\b(1[5-9]\d{2}|20\d{2})\b/)?.[1]);
    if (Number.isFinite(year)) metadata.issued = { "date-parts": [[year]] };

    const doi = rowText(html, "DOI：")?.match(/\b(10\.\d{4,9}\/\S+)\b/)?.[1];
    if (doi) metadata.DOI = doi.toLowerCase();

    const summary = rowText(html, "摘要：");
    if (summary) metadata.abstract = summary;

    // One anchor holding `深度学习；神经网络；模型` — Baidu never splits them.
    const words = rowText(html, "关键词：")
      ?.split(/[;；]/)
      .map((w) => w.trim())
      .filter(Boolean);
    if (words?.length) metadata.keywords = words;

    // Canonical hint comes from the whole document — `<link rel=canonical>` is in
    // the head, outside the record subtree.
    metadata.URL = canonicalizeUrl(ctx.url, { canonicalHint: extractCanonicalHint(ctx.html) });

    return {
      metadata,
      identifier: metadata.DOI ?? null,
      resolverSource: zh ? "plugin-dom-zh" : "plugin-dom-en",
      attachments: [],
      allowGenericPdfDiscovery: false,
      allowRawHtmlFallback: false,
    };
  },
};
