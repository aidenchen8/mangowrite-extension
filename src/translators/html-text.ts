// Depth-aware text extraction from a raw HTML string.
//
// Translators are pure string functions with no DOM (see types.ts), yet the
// index sites all render their record into *nested* elements: WoS wraps a
// search-matched DOI in `<mark>`, ncpssd appends an `<i>` type badge inside the
// `<h1>` title, Baidu 学术 hangs every author off an `<a><span>`. A regex that
// stops at the first `<` returns "" for each of them, so we walk the tag stream
// and track depth instead.
//
// `stripMarkup` joins across tags with **no** separator, because these are
// Chinese pages: `<font>先前经验</font><font>资源</font>` must not become
// "先前经验 资源" for a caller that wanted one keyword. Callers that need a
// boundary (e.g. the `<br>` between ncpssd's Chinese and English author lines)
// split the inner HTML on that tag *before* stripping.

import { decodeEntities } from "../metadata-extract.js";

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * Raw inner HTML of the element whose open tag ends at `openTagEnd` (the index
 * just past its `>`). Returns "" when the element is never closed.
 */
export function innerHtmlAt(html: string, openTagEnd: number): string {
  // Constructed per call: a shared /g regex would have its `lastIndex` clobbered
  // by a nested call from inside a caller's own match loop.
  const tag = /<!--[\s\S]*?-->|<\/?([a-z][\w-]*)[^>]*>/gi;
  tag.lastIndex = openTagEnd;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(html))) {
    if (m[0].startsWith("<!--")) continue;
    if (m[0].startsWith("</")) {
      if (depth === 0) return html.slice(openTagEnd, m.index);
      depth--;
    } else if (!m[0].endsWith("/>") && !VOID_TAGS.has(m[1]!.toLowerCase())) {
      depth++;
    }
  }
  return "";
}

/** Tags out, entities decoded, whitespace collapsed. */
export function stripMarkup(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** Inner text of the element whose open tag ends at `openTagEnd`. */
export function innerTextAt(html: string, openTagEnd: number): string {
  return stripMarkup(innerHtmlAt(html, openTagEnd));
}

/**
 * Inner HTML of the first element whose open tag matches `openTag`. The regex
 * must match the whole `<tag …>`, so that the element's content starts right
 * after the match.
 */
export function innerHtmlOf(html: string, openTag: RegExp): string | null {
  const m = html.match(openTag);
  if (!m || m.index === undefined) return null;
  return innerHtmlAt(html, m.index + m[0].length);
}

/** Inner HTML of the element carrying `id`, or null. */
export function innerHtmlById(html: string, id: string): string | null {
  return innerHtmlOf(
    html,
    new RegExp(`<[a-z][\\w-]*\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i"),
  );
}

/** Inner text of the element carrying `id`, or null when absent/empty. */
export function innerTextById(html: string, id: string): string | null {
  const inner = innerHtmlById(html, id);
  if (inner === null) return null;
  return stripMarkup(inner) || null;
}

/** Matches an open tag whose `class` attribute contains `name` as a whole token. */
export function classOpenTag(name: string, tag = "[a-z][\\w-]*"): RegExp {
  return new RegExp(
    `<${tag}\\b[^>]*\\bclass=["'](?:[^"']*\\s)?${name}(?:\\s[^"']*)?["'][^>]*>`,
    "i",
  );
}

/** Inner text of the first element whose class list contains `name`. */
export function innerTextByClass(html: string, name: string): string | null {
  const inner = innerHtmlOf(html, classOpenTag(name));
  if (inner === null) return null;
  return stripMarkup(inner) || null;
}
