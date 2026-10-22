// Vendored from MangoWrite's internal metadata-resolver package at export v0.1.18 - edit upstream, not here.
// HTML 标签属性读取 —— 单条锚定正则读不了「属性顺序/引号风格」都随出版商变的
// meta 标签（ACL Anthology 发 `<meta content=… name=citation_pdf_url>`：content
// 在前、name 不带引号）。先扫标签、再逐属性取值，顺序与引号就都无关了。
//
// 全仓只有这一份实现：apps/api（import/origin.ts 的 PDF 候选规则）与
// apps/extension（metadata-extract.ts 的题录抽取）共用。纯函数、无 IO。

/** All opening tags `tagName` in document order, e.g. `scanTags(html, "meta")`. */
export function scanTags(html: string, tagName: string): string[] {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "gi");
  return html.match(re) ?? [];
}

/**
 * One attribute's value off a raw tag string, or null when absent. Attribute
 * order is free; values may be double-quoted, single-quoted, or bare HTML5.
 */
export function tagAttr(tag: string, attr: string): string | null {
  const m = tag.match(new RegExp(`\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'<>\\\`]+))`, "i"));
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? "";
}

/**
 * `content` values of every meta tag keyed by `name`/`property` equal to
 * `name` (case-insensitive), in document order. Empty contents are dropped.
 * Values are raw — entity decoding stays with the caller, as before.
 */
export function readMetaContents(html: string, name: string): string[] {
  const wanted = name.toLowerCase();
  const out: string[] = [];
  for (const tag of scanTags(html, "meta")) {
    const key = tagAttr(tag, "name") ?? tagAttr(tag, "property");
    if (key?.toLowerCase() !== wanted) continue;
    const content = tagAttr(tag, "content");
    if (content != null && content.trim()) out.push(content);
  }
  return out;
}
