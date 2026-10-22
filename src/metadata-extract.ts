// two-track metadata extraction in the extension.
//
// English publishers expose clean meta tags (Highwire citation_*, Dublin Core,
// JSON-LD) → trust them, but canonicalize via DOI server-side. Chinese sites
// (CNKI/Wanfang/CQVIP) have poor meta tags but render 卷/期/页 as visible text →
// per-publisher adapters scrape the rendered markup. The router picks a track by
// host, then CJK content. All string/regex based so it runs in the MV3 worker
// and is unit-testable without a DOM.
//
// 中文首页题录（文章编号/页眉/CN 号/ISSN…）与服务端共用同一份实现：
// @mango-write/metadata-resolver/zh-frontmatter。公开导出面不得出现第二份实现。

import {
  extractChineseFrontmatter,
  type ChineseFrontmatter,
} from "./vendor/metadata-resolver/zh-frontmatter";
import { readMetaContents } from "./vendor/metadata-resolver/html-tag";

export interface PartialCsl {
  type?: string;
  title?: string;
  author?: Array<{ family?: string; given?: string; literal?: string }>;
  "container-title"?: string;
  volume?: string;
  issue?: string;
  page?: string;
  issued?: { "date-parts": number[][] };
  DOI?: string;
  ISSN?: string[];
  URL?: string;
  /** Site-native accession id, namespaced by source (e.g. `cnki:whya201501001`).
   * A stable work key for sources whose landing-page URL mutates per visit. */
  nativeId?: string;
  language?: string;
  abstract?: string;
  publisher?: string;
  /** Paper keywords (关键词) — scraped from meta tags; highest-trust source. */
  keywords?: string[];
}

export interface ExtractResult {
  metadata: PartialCsl;
  pdfUrl: string | null;
  track: "en" | "zh";
  publisher: string | null;
}

/**
 * Paper keywords from meta tags — `citation_keywords`/`keywords`/`dc.subject`,
 * whether given as repeated tags or a single delimited value. De-duped, capped.
 */
export function extractKeywordsFromHtml(html: string): string[] {
  const raw = [
    ...metaAll(html, "citation_keywords"),
    ...metaAll(html, "keywords"),
    ...metaAll(html, "dc.subject"),
    ...metaAll(html, "prism.keyword"),
    ...metaAll(html, "bepress_citation_keywords"),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    for (const part of value.split(/[;；,，、]/)) {
      const kw = part.trim();
      const key = kw.toLowerCase();
      if (kw.length >= 2 && kw.length <= 30 && !seen.has(key)) {
        seen.add(key);
        out.push(kw);
      }
    }
  }
  return out.slice(0, 12);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function codePoint(value: number, fallback: string): string {
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}

/**
 * Meta `content` arrives HTML-escaped ("AI &amp; SOCIETY"). Decode before the
 * value reaches CSL, or the raw entity is stored and resurfaces in citations.
 */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) => codePoint(parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec: string) => codePoint(Number(dec), m))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function meta(html: string, name: string): string | null {
  const raw = readMetaContents(html, name)[0]?.trim();
  return raw ? decodeEntities(raw) : null;
}

function metaAll(html: string, name: string): string[] {
  return readMetaContents(html, name)
    .map((value) => value.trim())
    .filter(Boolean)
    .map(decodeEntities);
}

/** Case-insensitive, order-preserving de-dupe. */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = v.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Author names across both Highwire shapes: repeated `citation_author` tags, or
 * a single semicolon-delimited `citation_authors` (PubMed). Semantic Scholar
 * emits the same author under both `name=` and `property=`, hence the de-dupe.
 * Digital Commons (bepress) ships only the `bepress_citation_author` variant.
 */
function authorNames(html: string): string[] {
  const repeated = dedupe(metaAll(html, "citation_author"));
  if (repeated.length) return repeated;

  const joined = meta(html, "citation_authors");
  if (joined) {
    // Split on ";" only — a lone "Smith, John" is one author, not two.
    const parts = joined
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) return dedupe(parts);
  }

  const bepress = dedupe(metaAll(html, "bepress_citation_author"));
  if (bepress.length) return bepress;

  return dedupe(metaAll(html, "dc.creator"));
}

function escapeRegex(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DOI_RE = /\b(10\.\d{4,}(?:\.\d+)*\/[^\s"'<>]+)/i;

export function extractPdfUrl(html: string): string | null {
  return meta(html, "citation_pdf_url") ?? meta(html, "bepress_citation_pdf_url");
}

/**
 * arXiv identifier off an abs/pdf page. arXiv exposes `citation_arxiv_id` but
 * NO `citation_doi`, so the DOI-only identifier path yields null there — the
 * capture then can't key its global work and the same preprint lands in the
 * library twice (once metadata-only via import-by-identifier, once from the
 * plugin). Meta tag first, then the page URL.
 */
export function extractArxivId(input: { url: string; html: string }): string | null {
  const fromMeta = meta(input.html, "citation_arxiv_id");
  const metaMatch = fromMeta?.match(/^(\d{4}\.\d{4,5})(?:v\d+)?$/i);
  if (metaMatch?.[1]) return metaMatch[1];

  const urlMatch = input.url.match(
    /(?:^|\/\/)(?:www\.)?arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/i,
  );
  return urlMatch?.[1] ?? null;
}

/** Shared by the DSpace translator — repository records use the same shapes. */
export function parseAuthors(names: string[]): PartialCsl["author"] {
  return names.map((name) => {
    // Highwire citation_author is usually "Family, Given" or "Given Family".
    if (name.includes(",")) {
      const [family, given] = name.split(",").map((s) => s.trim());
      return { family, given };
    }
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      // PubMed/Europe PMC style "Nonaka H" / "Kariya KI": the trailing token is
      // bare initials, so the *leading* tokens are the family name. A real
      // surname ("DUPONT") is longer than 3 chars and stays in the else branch.
      const last = parts.at(-1)!;
      if (/^[A-Z]{1,3}$/.test(last)) {
        return { family: parts.slice(0, -1).join(" "), given: last };
      }
      return { given: parts.slice(0, -1).join(" "), family: last };
    }
    return { literal: name.trim() };
  });
}

/** Normalize ISSN surface forms to canonical XXXX-XXXX, de-duped; drops junk. */
function normalizeIssns(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const compact = value.replace(/[^0-9xX]/g, "").toUpperCase();
    if (compact.length !== 8) continue;
    const issn = `${compact.slice(0, 4)}-${compact.slice(4)}`;
    if (!seen.has(issn)) {
      seen.add(issn);
      out.push(issn);
    }
  }
  return out;
}

/**
 * Year out of any of the shapes publishers ship: "2020", "2020-07-21",
 * "2020/07/21", and PubMed's US-ordered "07/21/2020" — which a leading-4-char
 * slice would read as NaN.
 */
function yearFrom(dateStr: string | null): PartialCsl["issued"] | undefined {
  if (!dateStr) return undefined;
  const y = Number(dateStr.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/)?.[1]);
  return Number.isFinite(y) ? { "date-parts": [[y]] } : undefined;
}

/**
 * ACM's `og:title` is a verbatim copy of the browser-tab title:
 * "Point Cloud Analysis … | Proceedings of the 2023 ACM SIGSAC Conference …".
 * Taking it whole stores the venue inside the article title.
 *
 * Three guards keep this from eating real titles:
 *   * `og:title` must be byte-identical to `<title>` — a publisher that bothered
 *     to set a distinct `og:title` meant the value it gave.
 *   * The separator is " | " only. Hyphens are common inside real titles.
 *   * There must be exactly one separator. A tab title is "Article | Venue";
 *     two pipes means we cannot tell which one divides them, so leave it alone.
 *
 * The tail is the containing venue, so hand it back for `container-title` too.
 */
function splitTabTitle(html: string, ogTitle: string): { title: string; container?: string } {
  const docTitle = decodeEntities(
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "",
  ).trim();
  if (docTitle !== ogTitle.trim()) return { title: ogTitle };

  const parts = ogTitle.split(" | ");
  if (parts.length !== 2) return { title: ogTitle };
  return { title: parts[0]!.trim(), container: parts[1]!.trim() };
}

/** English track: Highwire citation_* → Dublin Core → JSON-LD → OpenGraph.
 * Digital Commons (bepress) pages carry none of those — only `bepress_citation_*`
 * variants — so each field falls back to its bepress name. */
export function extractEnglishMetadata(html: string): PartialCsl {
  const out: PartialCsl = { type: "article-journal" };

  let ogContainer: string | undefined;
  const ogTitle = meta(html, "og:title");
  out.title =
    meta(html, "citation_title") ??
    meta(html, "dc.title") ??
    meta(html, "bepress_citation_title") ??
    undefined;
  if (!out.title && ogTitle) {
    const split = splitTabTitle(html, ogTitle);
    out.title = split.title;
    ogContainer = split.container;
  }

  const names = authorNames(html);
  if (names.length) out.author = parseAuthors(names);

  out["container-title"] =
    meta(html, "citation_journal_title") ??
    meta(html, "prism.publicationName") ??
    meta(html, "bepress_citation_journal_title") ??
    ogContainer ??
    undefined;
  out.volume = meta(html, "citation_volume") ?? meta(html, "bepress_citation_volume") ?? undefined;
  out.issue = meta(html, "citation_issue") ?? meta(html, "bepress_citation_issue") ?? undefined;
  const first =
    meta(html, "citation_firstpage") ?? meta(html, "bepress_citation_firstpage");
  const last = meta(html, "citation_lastpage") ?? meta(html, "bepress_citation_lastpage");
  if (first) out.page = last ? `${first}-${last}` : first;

  // Scan every candidate rather than trusting the first: ACM emits two
  // `dc.Identifier` tags and the ACM-internal id comes before the DOI.
  const normDoi = [
    ...metaAll(html, "citation_doi"),
    ...metaAll(html, "dc.identifier"),
    ...metaAll(html, "prism.doi"),
    ...metaAll(html, "bepress_citation_doi"),
  ]
    .map((v) => v.match(DOI_RE)?.[1])
    .find(Boolean)
    ?.toLowerCase();
  if (normDoi) out.DOI = normDoi;

  // ISSN — lets journal-quality badges match straight off the DOM (ISSN-first
  // ladder), no DOI round-trip needed. Highwire/PRISM expose it on most OA
  // publishers (MDPI, PLOS, Frontiers, SAGE, …).
  const issns = normalizeIssns([
    ...metaAll(html, "citation_issn"),
    ...metaAll(html, "prism.issn"),
    ...metaAll(html, "prism.eIssn"),
    ...metaAll(html, "bepress_citation_issn"),
  ]);
  if (issns.length) out.ISSN = issns;

  out.issued =
    yearFrom(meta(html, "citation_publication_date")) ??
    yearFrom(meta(html, "citation_date")) ??
    yearFrom(meta(html, "bepress_citation_date")) ??
    yearFrom(meta(html, "bepress_citation_publication_date")) ??
    yearFrom(meta(html, "dc.date"));

  const keywords = extractKeywordsFromHtml(html);
  if (keywords.length) out.keywords = keywords;

  // JSON-LD fallback for title/journal if meta tags were thin.
  if (!out.title || !out["container-title"]) {
    const ld = extractJsonLd(html);
    if (ld) {
      out.title ??= typeof ld.name === "string" ? ld.name : (ld.headline as string | undefined);
      const journal = (ld.isPartOf as { name?: string } | undefined)?.name;
      if (journal && !out["container-title"]) out["container-title"] = journal;
    }
  }

  return out;
}

function extractJsonLd(html: string): Record<string, unknown> | null {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]!.trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const article = arr.find(
        (x) => typeof x?.["@type"] === "string" && /Article/i.test(x["@type"]),
      );
      if (article) return article as Record<string, unknown>;
    } catch {
      // skip malformed block
    }
  }
  return null;
}

// ── Chinese per-publisher adapters

export interface PublisherAdapter {
  name: string;
  match: (url: string) => boolean;
  extract: (html: string) => PartialCsl;
}

/**
 * 中文首页题录 → PartialCsl 映射。DOM meta 标签已有的字段优先（citation_* 是
 * 站点结构化声明），抽取器只补位——卷/期/页/ISSN/CN 号/年/刊名/DOI。
 * 抽取器吃纯文本；调用方先 stripTags。
 */
function frontmatterToPartialCsl(fm: ChineseFrontmatter, out: PartialCsl): void {
  if (fm.volume) out.volume ??= fm.volume;
  if (fm.issue) out.issue ??= fm.issue;
  if (fm.page) out.page ??= fm.page;
  if (fm.issn) out.ISSN = [...new Set([...(out.ISSN ?? []), fm.issn])];
  if (fm.containerTitle) out["container-title"] ??= fm.containerTitle;
  if (fm.year && !out.issued) out.issued = { "date-parts": [[fm.year]] };
  if (fm.doi && !out.DOI) out.DOI = fm.doi;
}

function chineseCommonExtract(html: string): PartialCsl {
  const out: PartialCsl = { type: "article-journal", language: "zh" };
  const htmlTitle = stripTags(
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "",
  ).trim();
  out.title =
    meta(html, "citation_title") ??
    meta(html, "og:title") ??
    (htmlTitle || undefined);
  const names = authorNames(html);
  if (names.length) out.author = parseAuthors(names);
  out["container-title"] =
    meta(html, "citation_journal_title") ?? undefined;
  const keywords = extractKeywordsFromHtml(html);
  if (keywords.length) out.keywords = keywords;
  frontmatterToPartialCsl(extractChineseFrontmatter(stripTags(html)), out);
  return out;
}

const CHINESE_ADAPTERS: PublisherAdapter[] = [
  { name: "cnki", match: (u) => /(?:^|\.)cnki\.net/i.test(host(u)), extract: chineseCommonExtract },
  { name: "wanfang", match: (u) => /wanfangdata\.com\.cn/i.test(host(u)), extract: chineseCommonExtract },
  { name: "cqvip", match: (u) => /cqvip\.com/i.test(host(u)), extract: chineseCommonExtract },
];

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function cjkRatio(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = cjk + latin;
  return total === 0 ? 0 : cjk / total;
}

/** router: pick a publisher adapter, else CJK content → zh, else en. */
export function extractMetadata(input: { url: string; html: string }): ExtractResult {
  const adapter = CHINESE_ADAPTERS.find((a) => a.match(input.url));
  const pdfUrl = extractPdfUrl(input.html);

  if (adapter) {
    return { metadata: adapter.extract(input.html), pdfUrl, track: "zh", publisher: adapter.name };
  }

  const title = meta(input.html, "citation_title") ?? meta(input.html, "og:title") ?? "";
  if (cjkRatio(title) > 0.3) {
    return { metadata: chineseCommonExtract(input.html), pdfUrl, track: "zh", publisher: null };
  }

  return { metadata: extractEnglishMetadata(input.html), pdfUrl, track: "en", publisher: null };
}
