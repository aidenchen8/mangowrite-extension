// Wanfang Data (万方数据) translator.
//
// The maintained community translator (l0o0/translators_CN) fetches Wanfang
// metadata over gRPC-web + protobuf (Detail/Export services) — impractical to
// reproduce in this pure-string, DOM-free worker. So we degrade metadata to a
// page scrape (og / citation_* / embedded JSON) and construct the full-text PDF
// URL from the article id, which the community translator does deterministically:
//   https://oss.wanfangdata.com.cn/www/<title>.ashx?type=<type>&resourceId=<id>
// (or a `fulltextpath` embedded in the page). The download is login/anti-leech
// gated — the background worker supplies the Referer (see background.ts).
//
// Pure/string-based → runs headless in the MV3 worker, unit-testable w/o a DOM.

import { canonicalizeUrl, extractCanonicalHint } from "../canonical-url.js";
import { decodeEntities } from "../metadata-extract.js";
import type { PartialCsl } from "../metadata-extract.js";
import type { Attachment, Translator, TranslatorResult } from "./types.js";

const TYPE_MAP: Record<string, PartialCsl["type"]> = {
  periodical: "article-journal",
  thesis: "thesis",
  degree: "thesis",
  conference: "paper-conference",
  patent: "patent",
  standard: "report",
  nstr: "report",
  claw: "report",
};

const WANFANG_TYPES = Object.keys(TYPE_MAP);

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function metaContent(html: string, key: string): string | null {
  const tag = html.match(
    new RegExp(
      `<meta\\b[^>]*\\b(?:name|property)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`,
      "i",
    ),
  )?.[0];
  const content = tag?.match(/\bcontent=["']([^"']*)["']/i)?.[1];
  return content ? decodeEntities(content).trim() : null;
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Wanfang's detail page is a Vue SPA with hashed `data-v-*` attributes, so we
 * anchor on the stable class name and read a bounded window *after* the class
 * attribute (never including it).
 */
function domWindow(html: string, className: string, window: number): string | null {
  const m = html.match(new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`, "i"));
  if (m?.index === undefined) return null;
  return html.slice(m.index + m[0].length, m.index + m[0].length + window);
}

/** Flattened text of that window — for fields read out of a label+value blob. */
function domSection(html: string, className: string, window = 400): string | null {
  const slice = domWindow(html, className, window);
  return slice === null ? null : stripTags(slice);
}

/**
 * First non-empty text node inside that element — for fields where the window
 * would otherwise swallow sibling elements (刊名 sits next to 核心 badges).
 */
function domFirstText(html: string, className: string, window = 400): string | null {
  const slice = domWindow(html, className, window);
  const text = slice?.match(/>\s*([^<>]*[^\s<>][^<>]*?)\s*</)?.[1];
  return text ? decodeEntities(text).replace(/\s+/g, " ").trim() : null;
}

interface WanfangRef {
  type: string | null;
  id: string | null;
}

/** type/id from the og:url meta (authoritative on the SPA) → page URL path. */
export function extractWanfangRef(input: { url: string; html: string }): WanfangRef {
  const ogUrl = metaContent(input.html, "og:url");
  for (const candidate of [ogUrl, input.url]) {
    if (!candidate) continue;
    try {
      const parts = new URL(candidate, "https://d.wanfangdata.com.cn").pathname
        .split("/")
        .filter(Boolean);
      const type = parts[0]?.toLowerCase();
      if (type && WANFANG_TYPES.includes(type) && parts[1]) {
        return { type, id: decodeURIComponent(parts[1]) };
      }
    } catch {
      // try the next candidate
    }
  }
  return { type: null, id: null };
}

function parseAuthorName(name: string): NonNullable<PartialCsl["author"]>[number] {
  if (/[一-鿿]/.test(name)) return { literal: name }; // keep Chinese names whole
  if (name.includes(",")) {
    const [family, given] = name.split(",").map((s) => s.trim());
    return given ? { family, given } : { literal: name };
  }
  return { literal: name };
}

/**
 * Wanfang ships *no* `citation_*` tags. Its SPA injects OpenGraph
 * (`og:article:author`, `og:article:published_time`, `og:article:tag`) once the
 * detail view renders, and leaves journal / DOI / ISSN / 年卷期 / 页码 only in
 * the markup — hence the OG-then-DOM ladder. `citation_*` is still tried first
 * so this keeps working if Wanfang ever emits it.
 */
function scrapeWanfangMetadata(html: string, ref: WanfangRef): PartialCsl {
  const out: PartialCsl = {
    type: (ref.type && TYPE_MAP[ref.type]) || "article-journal",
    language: "zh",
  };

  const rawTitle =
    metaContent(html, "citation_title") ??
    metaContent(html, "og:title") ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
    "";
  const title = rawTitle.replace(/\s*[-—]\s*(?:期刊|学位论文|会议论文)?\s*[-—]?\s*万方.*$/, "").trim();
  if (title) out.title = title;

  const tagged = [...html.matchAll(/<meta\b[^>]*\bname=["']citation_author["'][^>]*>/gi)]
    .map((m) => m[0].match(/\bcontent=["']([^"']+)["']/i)?.[1]?.trim())
    .filter((v): v is string => Boolean(v));
  const authors = tagged.length
    ? tagged
    : (metaContent(html, "og:article:author") ?? "")
        .split(/[,，;；、]/)
        .map((s) => s.trim())
        .filter(Boolean);
  if (authors.length) out.author = authors.map(parseAuthorName);

  const journal =
    metaContent(html, "citation_journal_title") ??
    metaContent(html, "citation_conference_title") ??
    domFirstText(html, "periodicalName", 300);
  if (journal) out["container-title"] = journal;

  // "年,卷(期)：" renders as <span>2026</span><span>,44</span><span>(3)</span>.
  const publish = domSection(html, "publishData", 700) ?? "";
  const yearVolIssue = publish.match(/(\d{4})\s*,?\s*(\d{1,4})?\s*(?:\(\s*(\d{1,3})\s*\))?/);

  out.volume = metaContent(html, "citation_volume") ?? yearVolIssue?.[2] ?? undefined;
  out.issue = metaContent(html, "citation_issue") ?? yearVolIssue?.[3] ?? undefined;

  const fp = metaContent(html, "citation_firstpage");
  const lp = metaContent(html, "citation_lastpage");
  if (fp && lp) out.page = `${fp}-${lp}`;
  else if (fp) out.page = fp;
  else {
    // "页数：12 ( 82-93 )" — the parenthesized span is the page range.
    const pages = domSection(html, "pages", 400)?.match(/(\d{1,6})\s*[-–—]\s*(\d{1,6})/);
    if (pages) out.page = `${pages[1]}-${pages[2]}`;
  }

  const year = Number(
    (
      metaContent(html, "citation_publication_date") ??
      metaContent(html, "citation_date") ??
      metaContent(html, "og:article:published_time") ??
      yearVolIssue?.[1] ??
      ""
    ).match(/\d{4}/)?.[0],
  );
  if (Number.isFinite(year) && year > 1000) out.issued = { "date-parts": [[year]] };

  const doi = (
    metaContent(html, "citation_doi") ??
    domSection(html, "doiStyle", 200)?.replace(/^\s*DOI\s*[:：]?\s*/i, "") ??
    ""
  ).match(/10\.\d{4,}(?:\.\d+)*\/\S+/i)?.[0];
  if (doi) out.DOI = doi.toLowerCase();

  const issn = domSection(html, "periodicalDataItem", 200)?.match(
    /ISSN\s*[:：]\s*(\d{4}-\d{3}[\dXx])/i,
  )?.[1];
  if (issn) out.ISSN = [issn.toUpperCase()];

  const keywords = (metaContent(html, "og:article:tag") ?? "")
    .split(/[,，;；、]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (keywords.length) out.keywords = keywords.slice(0, 12);

  return out;
}

/**
 * Full-text PDF URL. Prefer an explicit `fulltextpath` embedded in the page;
 * otherwise construct the oss.wanfangdata endpoint from the id + type, matching
 * the community translator.
 */
function wanfangPdfUrl(html: string, ref: WanfangRef, title: string | undefined): string | null {
  const embedded = html.match(/"fulltextpath"\s*:\s*"([^"]+)"/i)?.[1];
  if (embedded) return embedded.replace(/\\u002F/gi, "/").replace(/\\\//g, "/");

  if (!ref.id) return null;
  const name = (title || ref.id).replace(/[\\/:*?"<>|]+/g, " ").trim() || ref.id;
  return encodeURI(
    `https://oss.wanfangdata.com.cn/www/${name}.ashx?type=${ref.type ?? "perio"}&resourceId=${ref.id}`,
  );
}

export const wanfangTranslator: Translator = {
  id: "wanfang",
  label: "万方数据",
  match: (url) => /(^|\.)wanfangdata\.com\.cn$/i.test(host(url)),
  detect: ({ url, html }) => {
    // A recognizable Wanfang detail URL (via og:url or the page URL) is the
    // signal; gate on a wanfangdata origin marker so it doesn't fire elsewhere.
    const ref = extractWanfangRef({ url, html });
    if (!ref.id) return false;
    return /wanfangdata\.com\.cn/i.test(url) || /wanfangdata/i.test(html);
  },
  async extract(ctx): Promise<TranslatorResult> {
    const ref = extractWanfangRef({ url: ctx.url, html: ctx.html });
    const metadata = scrapeWanfangMetadata(ctx.html, ref);

    // Wanfang's `<type>/<id>` accession pair is the article's stable identity and
    // most Chinese journals here carry no DOI. Without it the work keys on the
    // landing-page URL, which moves with the WebVPN host prefix and SPA query —
    // so the same paper minted a fresh work on every import (same failure CNKI
    // had). Type is part of the key: ids are only unique within a type.
    if (ref.type && ref.id && !metadata.nativeId) {
      metadata.nativeId = `wanfang:${ref.type}/${ref.id}`.toLowerCase();
    }

    if (!metadata.URL) {
      metadata.URL = canonicalizeUrl(ctx.url, {
        canonicalHint: extractCanonicalHint(ctx.html),
      });
    }

    const pdfUrl = wanfangPdfUrl(ctx.html, ref, metadata.title);
    const attachments: Attachment[] = [];
    if (pdfUrl) {
      attachments.push({
        kind: "pdf",
        url: pdfUrl,
        mime: "application/pdf",
        filename: `${ref.id ?? "wanfang"}.pdf`,
      });
    }

    return {
      metadata,
      identifier: metadata.DOI ?? null,
      resolverSource: "plugin-dom-zh",
      attachments,
      // Metadata is scraped from this very page; its HTML is a SPA shell, so
      // don't snapshot it or let server-side discovery scrape it.
      allowGenericPdfDiscovery: false,
      allowRawHtmlFallback: false,
    };
  },
};
