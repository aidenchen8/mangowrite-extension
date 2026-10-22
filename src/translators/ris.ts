// RIS parser (`TY  - JOUR` …).
//
// **Currently unused.** This module was written on the assumption that CQVIP's
// export endpoint speaks RIS. It does not: despite `styles=RefMan`, it returns
// RefWorks tagged text (`RT Journal Article`), same as CNKI — see refworks.ts.
// Because no line matched, `parseRis` returned an empty record and cqvip.ts
// silently fell back to scraping the page title; the fixture in cqvip.test.ts
// was invented rather than captured, so the tests stayed green. Kept in case a
// real RIS source appears. Pure/string-based, unit-testable without a DOM.

import type { PartialCsl } from "./types.js";

const RIS_TYPE_MAP: Record<string, PartialCsl["type"]> = {
  JOUR: "article-journal",
  CONF: "paper-conference",
  CPAPER: "paper-conference",
  THES: "thesis",
  BOOK: "book",
  CHAP: "chapter",
  RPRT: "report",
  PAT: "patent",
  NEWS: "article-newspaper",
  MGZN: "article-magazine",
  GEN: "article-journal",
};

/** "Family, Given" / "Given Family" / whole Chinese name → CSL author. */
function parseRisAuthor(name: string): NonNullable<PartialCsl["author"]>[number] {
  const trimmed = name.trim();
  // Chinese names don't split reliably on whitespace — keep them whole.
  if (/[一-鿿]/.test(trimmed)) return { literal: trimmed };
  if (trimmed.includes(",")) {
    const [family, given] = trimmed.split(",").map((s) => s.trim());
    return given ? { family, given } : { literal: trimmed };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) return { given: parts.slice(0, -1).join(" "), family: parts.at(-1) };
  return { literal: trimmed };
}

/** Parse RIS/RefMan tagged text into partial CSL. */
export function parseRis(raw: string): PartialCsl {
  const text = raw.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, "");
  const fields = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    // `TY  - JOUR`, `AU  - x`, tolerant of 0–2 spaces around the dash.
    const m = line.match(/^([A-Z][A-Z0-9])\s{0,3}-\s?(.*)$/);
    if (!m) continue;
    const value = (m[2] ?? "").trim();
    if (!value) continue;
    const list = fields.get(m[1]!) ?? [];
    list.push(value);
    fields.set(m[1]!, list);
  }

  const first = (tag: string): string | undefined => fields.get(tag)?.[0];
  const out: PartialCsl = { type: "article-journal", language: "zh" };

  const ty = first("TY");
  if (ty) out.type = RIS_TYPE_MAP[ty.toUpperCase()] ?? out.type;

  out.title = first("TI") ?? first("T1") ?? first("CT");

  const authors = fields.get("AU") ?? fields.get("A1");
  if (authors?.length) out.author = authors.map(parseRisAuthor);

  out["container-title"] = first("JO") ?? first("JF") ?? first("T2") ?? first("J2") ?? undefined;
  if (first("VL")) out.volume = first("VL");
  if (first("IS")) out.issue = first("IS");

  const sp = first("SP");
  const ep = first("EP");
  if (sp && ep) out.page = `${sp}-${ep}`;
  else if (sp) out.page = sp;

  const yearRaw = first("PY") ?? first("Y1") ?? first("DA") ?? "";
  const year = Number(yearRaw.match(/\d{4}/)?.[0]);
  if (Number.isFinite(year) && year > 1000) out.issued = { "date-parts": [[year]] };

  const doi = (first("DO") ?? first("DI") ?? first("M3") ?? "").match(
    /10\.\d{4,}(?:\.\d+)*\/\S+/i,
  )?.[0];
  if (doi) out.DOI = doi.toLowerCase();

  if (first("AB") ?? first("N2")) out.abstract = first("AB") ?? first("N2");
  if (first("PB")) out.publisher = first("PB");
  if (first("UR") ?? first("L1")) out.URL = first("UR") ?? first("L1");

  const la = first("LA");
  if (la) out.language = /chi|zh|中/i.test(la) ? "zh" : la.toLowerCase();
  // Heuristic: an all-Latin title with no explicit language tag is English.
  else if (out.title && !/[一-鿿]/.test(out.title)) out.language = "en";

  return out;
}
