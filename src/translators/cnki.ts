// CNKI (中国知网) translator.
//
// Strategy:
//   1. Recover dbname/filename from the URL query, the hidden #paramdbname /
//      #paramfilename inputs, or the note link — the filename is the paper's
//      stable accession number and becomes the nativeId work key.
//   2. Scrape bibliographic metadata straight off the rendered abstract page
//      (作者/刊名/年卷期页/DOI/关键词/摘要). The page is server-rendered, so the
//      raw outerHTML the content script hands over already carries it all — no
//      CNKI API is called. The former ShowExport endpoint sits behind a signed
//      dm8/FileToText.enw flow (401 even with an institutional session), and
//      replicating their export API is a legal surface we deliberately avoid.
//   3. Offer full-text attachments in preference order: PDF (a[name=pdfDown],
//      or the li.btn-dlpdf anchor on thesis pages, where every download button
//      is misnamed `cajDown`), then the HTML full-text reader link (li.btn-html
//      a). Both are bar.cnki.net/bar/download/order?id=… links that need the
//      user's login.
//
// All parsing is string/regex based so it runs headless in the MV3 worker and
// is unit-testable without a DOM.

import { canonicalizeUrl, extractCanonicalHint } from "../canonical-url.js";
import type { PartialCsl } from "../metadata-extract.js";
import type { Attachment, Translator, TranslatorResult } from "./types.js";

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Value of an `<input>` whose id matches, regardless of attribute order. */
function inputValueById(html: string, id: string): string | null {
  const tag = html.match(
    new RegExp(`<input\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i"),
  )?.[0];
  if (!tag) return null;
  const value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1];
  return value ? decodeEntities(value.trim()) : null;
}

/** First non-empty `<input>` value among the candidate ids (id spellings drift
 * across CNKI redesigns — e.g. `paramdbname` → `param-dbname`). */
function inputValueByIds(html: string, ids: string[]): string | null {
  for (const id of ids) {
    const value = inputValueById(html, id);
    if (value) return value;
  }
  return null;
}

/** href of an `<a>` carrying attr=value (e.g. name="pdfDown"), order-agnostic. */
function anchorHrefByAttr(html: string, attr: string, value: string): string | null {
  const tag = html.match(
    new RegExp(`<a\\b[^>]*\\b${attr}=["']${value}["'][^>]*>`, "i"),
  )?.[0];
  const href = tag?.match(/\bhref=["']([^"']+)["']/i)?.[1];
  return href ? decodeEntities(href.trim()) : null;
}

/** href of the first `<a>` inside an `<li class="…className…">`. */
function anchorHrefInListItem(html: string, className: string): string | null {
  const block = html.match(
    new RegExp(`<li\\b[^>]*class=["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)<\\/li>`, "i"),
  )?.[1];
  const href = block?.match(/<a\b[^>]*\bhref=["']([^"']+)["']/i)?.[1];
  return href ? decodeEntities(href.trim()) : null;
}

function queryParam(url: string, key: string): string | null {
  try {
    return new URL(url).searchParams.get(key);
  } catch {
    return null;
  }
}

interface CnkiRef {
  dbname: string | null;
  filename: string | null;
}

/** dbname/filename from URL query → hidden inputs → note link.
 *
 * The modern `kcms2/article/abstract?v=<obfuscated>` URL carries no
 * dbname/filename, so recovery leans on the hidden inputs. CNKI has renamed
 * these across redesigns: legacy `paramdbname`/`paramfilename` became
 * `param-dbname`/`param-filename` (verified on kns.cnki.net 2026-07). We try
 * both spellings, then fall back to the 收藏/note link's query params. */
export function extractCnkiRef(input: { url: string; html: string }): CnkiRef {
  const dbname =
    queryParam(input.url, "dbname") ??
    queryParam(input.url, "DbName") ??
    inputValueByIds(input.html, ["param-dbname", "paramdbname"]);
  const filename =
    queryParam(input.url, "filename") ??
    queryParam(input.url, "FileName") ??
    inputValueByIds(input.html, ["param-filename", "paramfilename"]);

  if (dbname && filename) return { dbname, filename };

  // Note link fallback: ...?tablename=<db>&filename=<file>
  const noteHref = anchorHrefInListItem(input.html, "btn-note");
  if (noteHref) {
    return {
      dbname: dbname ?? queryParam(noteHref, "tablename") ?? queryParam(noteHref, "dbname"),
      filename: filename ?? queryParam(noteHref, "filename"),
    };
  }

  return { dbname, filename };
}


function stripTags(fragment: string): string {
  return fragment
    .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Author names from the `#authorpart` heading — a sibling run of anchors, each
 * possibly suffixed with a `<sup>` affiliation-index marker to strip. Thesis
 * pages sometimes render the author as plain text with no anchor at all, so a
 * block without anchors falls back to splitting the stripped text. */
function scrapeAuthors(html: string): PartialCsl["author"] | undefined {
  const block = html.match(
    /<h3\b[^>]*\bid=["']authorpart["'][^>]*>([\s\S]*?)<\/h3>/i,
  )?.[1];
  if (!block) return undefined;
  const names = [...block.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => stripTags(decodeEntities(m[1]!)).trim())
    .filter(Boolean);
  const authors = names.length
    ? names
    : stripTags(decodeEntities(block)).split(/[;；,，、\s]+/).filter(Boolean);
  if (!authors.length) return undefined;
  return authors.map((name) => ({ literal: name }));
}

/** 刊名 / 年 ,卷 (期) / 页码 from the `.top-tip` block. CNKI renders the
 * source line as `<a>城市发展研究 .</a><a>2014 ,21 (01)</a><span>: 10-13</span>`
 * — note the middle anchor packs **year, volume AND issue** (`年 ,卷 (期)`),
 * and volume may be absent (`2015 (01)`). The old parser grabbed only the year
 * and mis-read `,21` so both 卷 and 期 were dropped — GB/T [J] needs 卷(期):页,
 * so an incomplete source line breaks compliance (verified kns.cnki.net,
 * 2026-07). */
function scrapeJournalYearIssuePage(html: string): Pick<
  PartialCsl,
  "container-title" | "issued" | "volume" | "issue" | "page"
> {
  const out: Pick<
    PartialCsl,
    "container-title" | "issued" | "volume" | "issue" | "page"
  > = {};
  // Prefer the block bounded by the following `.other-versions` sibling; fall
  // back to the whole top-tip div when that sibling is absent.
  const block =
    html.match(
      /<div\b[^>]*\bclass=["'][^"']*top-tip[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<div\b[^>]*class=["'][^"']*other-versions/i,
    )?.[1] ??
    html.match(
      /<div\b[^>]*\bclass=["'][^"']*top-tip[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    )?.[1];
  if (!block) return out;

  const anchors = [...block.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => stripTags(decodeEntities(m[1]!)).trim())
    .filter(Boolean);
  if (anchors[0]) out["container-title"] = anchors[0].replace(/\s*\.\s*$/, "").trim();

  // 年 ,卷 (期): year, optional `,volume`, optional `(issue)` — in any anchor.
  const yvi = anchors
    .map((a) => a.match(/(\d{4})\s*(?:,\s*(\d{1,4}))?\s*(?:\(\s*([^)]+?)\s*\))?/))
    .find((m) => m);
  if (yvi) {
    out.issued = { "date-parts": [[Number(yvi[1])]] };
    if (yvi[2]) out.volume = yvi[2];
    if (yvi[3]) out.issue = yvi[3].trim();
  }

  // Page lives in a (possibly attributed) trailing span, e.g. `<span>: 10-13</span>`.
  const page = block.match(
    /<span\b[^>]*>\s*[:：]\s*([\d]+(?:[+\-–—][\d]+)*)\s*<\/span>/i,
  )?.[1];
  if (page) out.page = page.replace(/[–—]/g, "-").trim();

  return out;
}

/** 关键词 anchors inside `<p class="keywords">`. */
function scrapeKeywords(html: string): string[] | undefined {
  const block = html.match(
    /<p\b[^>]*\bclass=["'][^"']*keywords[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
  )?.[1];
  if (!block) return undefined;
  const keywords = [...block.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => stripTags(decodeEntities(m[1]!)).replace(/[;；]\s*$/, "").trim())
    .filter(Boolean);
  return keywords.length ? keywords.slice(0, 12) : undefined;
}

function scrapeAbstract(html: string): string | undefined {
  const value = inputValueById(html, "abstract_text");
  if (value) return value.trim();
  const rendered = html.match(
    /<span\b[^>]*\bid=["']ChDivSummary["'][^>]*>([\s\S]*?)<\/span>/i,
  )?.[1];
  return rendered ? stripTags(decodeEntities(rendered)).trim() : undefined;
}

/**
 * Value of a labeled 知网节 row — `<li|div><span class="rowtit">LABEL：</span>
 * <p>VALUE</p></li|div>` (verified kns.cnki.net 2026-09). Thesis/conference/
 * newspaper pages carry venue + date + DOI in these rows instead of the
 * journal `.top-tip` line.
 */
function scrapeLabeledRow(html: string, label: string): string | null {
  const fragment = html.match(
    new RegExp(
      // The span text may prefix the label (博士/硕士电子期刊出版信息：…).
      `<span\\b[^>]*class=["'][^"']*rowtit[^"']*["'][^>]*>[^<]*${label}\\s*：</span>([\\s\\S]*?)(?:</li>|</div>)`,
      "i",
    ),
  )?.[1];
  if (!fragment) return null;
  return stripTags(decodeEntities(fragment)).replace(/\s+/g, " ").trim() || null;
}

function scrapeDoi(html: string): string | undefined {
  return scrapeLabeledRow(html, "DOI")?.match(/10\.\d{4,9}\/\S+/i)?.[0];
}

/** 学位授予单位 — the organ anchor under wx-tit (`organ/detail` href). */
function scrapeOrgan(html: string): string | undefined {
  const name = html.match(/<a\b[^>]*organ\/detail[^>]*>([\s\S]*?)<\/a>/i)?.[1];
  return name ? stripTags(decodeEntities(name)).trim() || undefined : undefined;
}

/** Thesis pages mark the advisor row `p.supervisor` and the 年期 row
 * `bsdzqkcbxx`/`ssdzqkcbxx` (博士/硕士电子期刊出版信息) — neither exists on
 * journal/conference/newspaper pages. */
function isThesisPage(html: string): boolean {
  return (
    /<p\b[^>]*class=["'][^"']*supervisor[^"']*["']/i.test(html) ||
    /\bid=["'](?:bs|ss)dzqkcbxx["']/i.test(html)
  );
}

/** First 4-digit year in a row value — row date shapes vary (`2025年第12期`,
 * `2026-08-24`, `2026年11月`). */
function yearFromRow(value: string | null): number | undefined {
  const year = value?.match(/\d{4}/)?.[0];
  return year ? Number(year) : undefined;
}

/** Year segment of a CNKI thesis DOI (`10.27159/d.cnki.ghzsu.2025.002987`).
 * Fallback for thesis pages that render no 电子期刊出版信息 row — the DOI row
 * is the one labeled field every thesis page carries (journal DOIs are
 * `j.cnki.…` and never reach this helper). */
function yearFromCnkiThesisDoi(doi: string | undefined): number | undefined {
  const year = doi?.match(/\/d\.cnki\.[^.]+\.(\d{4})\./i)?.[1];
  return year ? Number(year) : undefined;
}

/** Bibliographic metadata scraped off the rendered abstract page. The page is
 * server-rendered, so 作者/刊名/年/期/页码/关键词/摘要 are all in the plain DOM
 * the content script captured — no login, no export flow, no API call. */
function scrapeCnkiMetadata(html: string): PartialCsl {
  const out: PartialCsl = { type: "article-journal", language: "zh" };
  const rawTitle =
    html.match(
      /<div\b[^>]*\bclass=["'][^"']*wx-tit[^"']*["'][^>]*>\s*<h1[^>]*>([\s\S]*?)<\/h1>/i,
    )?.[1] ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
    "";
  const title = stripTags(
    decodeEntities(rawTitle).replace(/<span\b[^>]*\bid=["']corr-video["'][^>]*>[\s\S]*?<\/span>/i, ""),
  )
    .replace(/\s*-\s*中国知网\s*$/, "")
    .trim();
  if (title) out.title = title;

  const authors = scrapeAuthors(html);
  if (authors) out.author = authors;

  // Source line differs per 文献类型 (all shapes live-verified 2026-09): only
  // journals carry the `.top-tip` 刊名/年卷期 line. Thesis pages put 保存单位 in
  // the organ anchor + 年期 in a labeled row and must never grow a journal
  // container-title; conferences use 会议名称/会议时间 rows; newspapers add a
  // 报纸日期 row next to the top-tip paper name.
  const doi = scrapeDoi(html);
  if (doi) out.DOI = doi;

  const thesis = isThesisPage(html);
  const conferenceVenue = thesis ? null : scrapeLabeledRow(html, "会议名称");
  const newspaperDate = thesis || conferenceVenue ? null : scrapeLabeledRow(html, "报纸日期");
  if (thesis) {
    out.type = "thesis";
    const organ = scrapeOrgan(html);
    if (organ) out.publisher = organ;
    // 年份从电子期刊出版信息行抓；部分页面没有这一行，退到 DOI 年份段、
    // 再退到在线公开时间——缺年会把条目判成「题录待补全」。
    const year =
      yearFromRow(scrapeLabeledRow(html, "电子期刊出版信息")) ??
      yearFromCnkiThesisDoi(doi) ??
      yearFromRow(scrapeLabeledRow(html, "在线公开时间"));
    if (year) out.issued = { "date-parts": [[year]] };
  } else if (conferenceVenue) {
    out.type = "paper-conference";
    out["container-title"] = conferenceVenue;
    const year = yearFromRow(scrapeLabeledRow(html, "会议时间"));
    if (year) out.issued = { "date-parts": [[year]] };
  } else {
    Object.assign(out, scrapeJournalYearIssuePage(html));
    if (newspaperDate) out.type = "article-newspaper";
    // 网络首发 journals have no year anchor in top-tip, only 在线公开时间;
    // newspapers date their top-tipped name with 报纸日期 instead.
    if (!out.issued) {
      const year = yearFromRow(newspaperDate ?? scrapeLabeledRow(html, "在线公开时间"));
      if (year) out.issued = { "date-parts": [[year]] };
    }
  }

  const keywords = scrapeKeywords(html);
  if (keywords) out.keywords = keywords;

  const abstract = scrapeAbstract(html);
  if (abstract) out.abstract = abstract;

  return out;
}

function filenameSlug(ref: CnkiRef, title: string | undefined, ext: string): string {
  if (ref.filename) return `${ref.filename}.${ext}`;
  const slug = (title ?? "cnki")
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${slug || "cnki"}.${ext}`;
}

export const cnkiTranslator: Translator = {
  id: "cnki",
  label: "中国知网",
  match: (url) => /(^|\.)cnki\.net$/i.test(host(url)),
  // Content-driven so a WebVPN-proxied page (host `webvpn.<uni>.edu.cn`) is
  // still recognized. The download buttons are absent without an institutional
  // entitlement, so the hidden dbname/filename inputs have to be enough on their
  // own — including CNKI's newer `param-filename` spelling. Missing that spelling
  // dropped logged-out CNKI pages to the generic translator, which scrapes a
  // title and no author/year/venue: no `nativeId`, so the work keyed on the
  // mutable landing-page URL and the same paper landed twice.
  detect: ({ html }) =>
    /\bname=["']pdfDown["']/i.test(html) ||
    /\bid=["']param-?filename["']/i.test(html) ||
    /\bid=["']param-?dbname["']/i.test(html) ||
    /class=["'][^"']*btn-html[^"']*["']/i.test(html) ||
    /class=["'][^"']*btn-dlpdf[^"']*["']/i.test(html),
  async extract(ctx): Promise<TranslatorResult> {
    const ref = extractCnkiRef({ url: ctx.url, html: ctx.html });
    const metadata = scrapeCnkiMetadata(ctx.html);

    // CNKI's accession number (`filename`, e.g. WHYA201501001) is the paper's
    // stable identity — unique per article across databases and, unlike the
    // `kcms2/article/abstract?v=<token>` URL, invariant across visits and WebVPN
    // proxies. Emit it as the work key so re-imports of the same paper dedup
    // (the URL alone minted a fresh work every time). dbname is intentionally
    // excluded: the same article surfaces under different dbnames (CJFDLAST vs
    // CJFDAUTO …) while the filename stays put.
    if (ref.filename && !metadata.nativeId) {
      metadata.nativeId = `cnki:${ref.filename.toLowerCase()}`;
    }

    // Ensure a URL identity so the backend can create/merge a work even without
    // a DOI or native id (upsertGlobalWork's last-resort key).
    if (!metadata.URL) {
      metadata.URL = canonicalizeUrl(ctx.url, {
        canonicalHint: extractCanonicalHint(ctx.html),
      });
    }

    // Thesis pages (CDFD/CMFD, filename `*.nh`) stamp EVERY download anchor
    // `name="cajDown"` — PDF下载/CAJ下载/章节下载 differ only by their `li`
    // class (verified kns.cnki.net 2026-09), so `a[name=pdfDown]` never matches
    // there and the `btn-dlpdf` li is the whole-text PDF anchor's only marker.
    const pdfHref =
      anchorHrefByAttr(ctx.html, "name", "pdfDown") ??
      anchorHrefByAttr(ctx.html, "id", "pdfDown") ??
      anchorHrefInListItem(ctx.html, "btn-dlpdf");
    // The chapter list is not the paper; never file it as the whole-text PDF.
    const chapterless = pdfHref && !/downloaddetail\/chapter/i.test(pdfHref) ? pdfHref : null;
    const htmlHref = anchorHrefInListItem(ctx.html, "btn-html");

    const attachments: Attachment[] = [];
    if (chapterless) {
      attachments.push({
        kind: "pdf",
        url: chapterless,
        mime: "application/pdf",
        filename: filenameSlug(ref, metadata.title, "pdf"),
      });
    }
    if (htmlHref) {
      attachments.push({
        kind: "html",
        url: htmlHref,
        mime: "text/html",
        filename: filenameSlug(ref, metadata.title, "html"),
      });
    }

    return {
      metadata,
      identifier: metadata.DOI ?? null,
      resolverSource: "plugin-dom-zh",
      attachments,
      // We already know CNKI's exact download links; never scrape publisher
      // rules or upload the SPA landing-page shell.
      allowGenericPdfDiscovery: false,
      allowRawHtmlFallback: false,
    };
  },
};
