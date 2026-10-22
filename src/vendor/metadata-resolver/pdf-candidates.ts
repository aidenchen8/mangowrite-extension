// Vendored from MangoWrite's internal metadata-resolver package at export v0.1.18 - edit upstream, not here.
// PDF 下载候选规则 —— 按页面 HTML 提取可下载的 PDF 候选列表。
//
// 站点规则按 hostname 命中出版商（sciencedirect / nature / springer / ieee /
// arxiv / DSpace），通用规则（citation_pdf_url 等 meta、data-pdf-url 属性）
// 不看 hostname。产出按「先命中先排」的顺序去重，调用方按序尝试下载。
//
// 全仓只有这一份实现：apps/api（import/origin.ts 的 /import/plugin/pdf-candidates）
// 与 apps/extension 共用。纯字符串计算、无 IO，可在 MV3 worker 里跑。

import { readMetaContents, scanTags, tagAttr } from "./html-tag.js";

export interface PluginPdfCandidate {
  url: string;
  strategy: string;
  publisher: string;
}

export function extractPluginPdfCandidates(input: {
  pageUrl: string;
  html: string;
}): PluginPdfCandidate[] {
  const candidates = new Map<string, PluginPdfCandidate>();
  // meta/属性值是 HTML 转义过的：bepress 的 viewcontent URL 全带 `&amp;`，
  // 不解码会拼出 `amp;context=` 这样的坏参数。
  const add = (value: string| null, strategy: string, publisher: string) => {
    const normalized = normalizeCandidateUrl(decodeAttrEntities(value), input.pageUrl);
    if (!normalized || candidates.has(normalized)) return;
    candidates.set(normalized, { url: normalized, strategy, publisher });
  };

  for (const name of [
    "citation_pdf_url",
    "bepress_citation_pdf_url",
    "wkhealth_pdf_url",
    "eprints.document_url",
    "dc.identifier.pdf",
  ]) {
    add(readMetaContents(input.html, name)[0] ?? null, `meta:${name}`, "generic-meta");
  }

  // Attribute order and quote style vary by publisher (ACL Anthology emits
  // `<meta content=… name=citation_pdf_url>`), so anchors are scanned tag-by-tag
  // instead of one anchored regex per site.
  const anchors = scanTags(input.html, "a");
  const anchorHrefs = (match: (tag: string) => boolean): string[] =>
    anchors
      .filter(match)
      .map((tag) => tagAttr(tag, "href"))
      .filter((href): href is string => Boolean(href));

  for (const href of anchorHrefs((tag) => tagAttr(tag, "data-pdf-url") != null)) {
    add(href, "attr:data-pdf-url", "highwire");
  }

  const hostname = new URL(input.pageUrl).hostname;
  if (/sciencedirect\.com$/i.test(hostname)) {
    for (const href of anchorHrefs((tag) => tag.includes("pdf-download-btn-link"))) {
      add(href, "sciencedirect:download-link", "sciencedirect");
    }
  }

  if (/(\.|^)nature\.com$/i.test(hostname)) {
    for (const href of anchorHrefs(
      (tag) => tagAttr(tag, "data-track-action")?.toLowerCase() === "download pdf",
    )) {
      add(href, "nature:download-link", "nature");
    }
  }

  if (/(\.|^)springer\.com$/i.test(hostname)) {
    for (const href of anchorHrefs(
      (tag) =>
        tagAttr(tag, "data-test") === "pdf-link" &&
        (tagAttr(tag, "href") ?? "").includes("/content/pdf/"),
    )) {
      add(href, "springer:content-pdf-link", "springer");
    }
  }

  if (/ieeexplore\.ieee\.org$/i.test(hostname)) {
    for (const href of anchorHrefs(
      (tag) =>
        tag.includes("stats-document-lh-action-downloadPdf") &&
        (tagAttr(tag, "href") ?? "").includes("stamp/stamp.jsp"),
    )) {
      add(href, "ieee:stamp-link", "ieee");
    }
  }

  if (/arxiv\.org$/i.test(hostname)) {
    const arxivId = input.pageUrl.match(/\/abs\/([^/?#]+)/)?.[1] ?? null;
    add(arxivId ? `/pdf/${arxivId}.pdf` : null, "arxiv:abs-to-pdf", "arxiv");
  }

  // DSpace 7 的 /bitstreams/<uuid>/download 在部分部署（GSU、Arizona，2026-09
  // 巡检）只回 Angular SPA 壳；底下的 REST content 端点仍出真文件，补成同
  // uuid 的兜底候选，排在原候选之后。
  for (const candidate of [...candidates.values()]) {
    const rest = dspaceRestContentUrl(candidate.url);
    if (rest && !candidates.has(rest)) {
      candidates.set(rest, { url: rest, strategy: "dspace:rest-content", publisher: "dspace" });
    }
  }

  return Array.from(candidates.values());
}

function normalizeCandidateUrl(value: string| null, pageUrl: string): string | null {
  if (!value) return null;
  try {
    return new URL(value, pageUrl).toString();
  } catch {
    return null;
  }
}

/** URL/属性值只需这几种实体；全量解码是题录字段的事，不在这条路径上。 */
function decodeAttrEntities(value: string | null): string | null {
  if (!value) return null;
  return value
    .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) =>
      safeFromCodePoint(parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec: string) => safeFromCodePoint(Number(dec), m))
    .replace(/&(amp|lt|gt|quot|apos);/gi, (m, name: string) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name.toLowerCase()] ?? m);
}

function safeFromCodePoint(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/**
 * DSpace 7 bitstream download → REST content 端点。扩展侧 publisher-pdf.ts 仍
 * 有一份刻意重复的同名实现，改为从本包 import 后即可删。
 */
export function dspaceRestContentUrl(pdfUrl: string): string | null {
  try {
    const url = new URL(pdfUrl);
    const uuid = url.pathname.match(/^\/bitstreams\/([0-9a-f-]+)\/download$/i)?.[1];
    if (!uuid) return null;
    url.pathname = `/server/api/core/bitstreams/${uuid}/content`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
