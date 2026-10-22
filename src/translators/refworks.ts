// Shared RefWorks tagged-text parser.
//
// Both CNKI's ShowExport and CQVIP's `ref/export?styles=RefMan` return this
// format despite the endpoint's name: two-letter tags separated from the value
// by a *space*, not RIS's ` - `. Getting that wrong is silent — no line matches,
// the record comes back empty, and the translator falls through to scraping.

import type { PartialCsl } from "./types.js";

const REFWORKS_TYPE_MAP: Record<string, PartialCsl["type"]> = {
  "Journal Article": "article-journal",
  "Conference Proceeding": "paper-conference",
  Dissertation: "thesis",
  Thesis: "thesis",
  Book: "book",
  "Newspaper Article": "article-newspaper",
  Patent: "patent",
};

/**
 * CNKI writes `RT Conference Proceeding`; CQVIP writes `RT Conference Proceeding
 * Article` for the same thing, and `RT Dissertation Article` for a thesis. Match
 * the longest key the value starts with, so a suffix the two never agreed on
 * can't silently demote a conference paper to a journal article.
 */
function refworksType(rt: string): PartialCsl["type"] | undefined {
  const value = rt.trim();
  const exact = REFWORKS_TYPE_MAP[value];
  if (exact) return exact;
  const prefix = Object.keys(REFWORKS_TYPE_MAP)
    .filter((key) => value.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? REFWORKS_TYPE_MAP[prefix] : undefined;
}

function parseRefworksAuthors(values: string[]): PartialCsl["author"] {
  const names = values.flatMap((v) => v.split(/[;；]/)).map((s) => s.trim()).filter(Boolean);
  return names.map((name) => {
    // Chinese names don't split reliably on whitespace — keep them whole.
    if (/[一-鿿]/.test(name)) return { literal: name };
    if (name.includes(",")) {
      const [family, given] = name.split(",").map((s) => s.trim());
      return { family, given };
    }
    const parts = name.split(/\s+/);
    if (parts.length >= 2) return { given: parts.slice(0, -1).join(" "), family: parts.at(-1) };
    return { literal: name };
  });
}

/** Parse the RefWorks text CNKI's ShowExport returns into partial CSL. */
export function parseRefworks(raw: string): PartialCsl {
  // ShowExport sometimes wraps records in markup; keep only tagged lines.
  const text = raw.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, "");
  const fields = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9])\s(.*)$/);
    if (!m) continue;
    const [, tag, value] = m;
    const trimmed = (value ?? "").trim();
    if (!trimmed) continue;
    const list = fields.get(tag!) ?? [];
    list.push(trimmed);
    fields.set(tag!, list);
  }

  const first = (tag: string): string | undefined => fields.get(tag)?.[0];
  const out: PartialCsl = { type: "article-journal", language: "zh" };

  const rt = first("RT");
  if (rt) out.type = refworksType(rt) ?? out.type;
  if (first("T1")) out.title = first("T1");
  const authors = fields.get("A1");
  if (authors?.length) out.author = parseRefworksAuthors(authors);
  out["container-title"] = first("JF") ?? first("JO") ?? undefined;
  if (first("VO")) out.volume = first("VO");
  if (first("IS")) out.issue = first("IS");
  const sp = first("SP");
  const op = first("OP");
  if (sp && op) out.page = `${sp}-${op}`;
  else if (sp) out.page = sp;
  else if (op) out.page = op;
  const year = Number((first("YR") ?? first("FD") ?? "").slice(0, 4));
  if (Number.isFinite(year) && year > 1000) out.issued = { "date-parts": [[year]] };
  const doi = (first("DO") ?? first("DI") ?? "").match(/10\.\d{4,}(?:\.\d+)*\/\S+/i)?.[0];
  if (doi) out.DOI = doi.toLowerCase();
  if (first("AB")) out.abstract = first("AB");
  // K1 = 关键词 (RefWorks): usually one keyword per line, sometimes delimited.
  const k1 = fields.get("K1");
  if (k1?.length) {
    const seen = new Set<string>();
    const keywords: string[] = [];
    for (const value of k1) {
      for (const part of value.split(/[;；,，、]/)) {
        const kw = part.trim();
        const key = kw.toLowerCase();
        if (kw.length >= 2 && kw.length <= 30 && !seen.has(key)) {
          seen.add(key);
          keywords.push(kw);
        }
      }
    }
    if (keywords.length) out.keywords = keywords.slice(0, 12);
  }
  if (first("PB")) out.publisher = first("PB");
  if (first("LK")) out.URL = first("LK");
  const issn = first("SN");
  if (issn) out.ISSN = [issn];
  const la = first("LA");
  if (la) out.language = /chi|zh|中/i.test(la) ? "zh" : la.toLowerCase();

  return out;
}
