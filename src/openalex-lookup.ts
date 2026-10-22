// - plugin-side OpenAlex DOI lookup for English-track works.
//
// The server's OpenAlex budget is $1/day (≈1000 search/天) and would cap the
// whole product as users grow. The extension instead queries OpenAlex from
// the user's own IP (anonymous $0.10/day pool) during a manual capture and
// hands the result to the server; the server skips its own OpenAlex fallback
// when the plugin already did the lookup (resolverSource="plugin-openalex").
//
// Only invoked on the English track with a DOI - the Chinese track's DOI is
// untrusted (D1) and the plugin's DOM scrape already has 卷期页 the API lacks.
// Anonymous (no api_key, no mailto) - keeps the user's email out of OpenAlex
// logs at the cost of a tighter rate limit, which a single per-import call
// never hits.

import type { PartialCsl } from "./metadata-extract.js";

const OPENALEX_BASE = "https://api.openalex.org/works";
const OPENALEX_TIMEOUT_MS = 10_000;

export interface OpenAlexLookupOptions {
  /** Fetch override (test injection). */
  fetchFn?: typeof fetch;
  /** Timeout override (test injection). */
  timeoutMs?: number;
}

/**
 * Look up a single DOI on OpenAlex from the user's browser. Returns the CSL
 * fields OpenAlex is authoritative for (title/container/volume/issue/page/
 * issued/author/DOI), or null on any failure - the caller proceeds without
 * enrichment and the server falls back to its own OpenAlex.
 *
 * One HTTP call, anonymous, 10s timeout. Never throws.
 */
export async function lookupOpenAlexByDoi(
  doi: string,
  opts: OpenAlexLookupOptions = {},
): Promise<PartialCsl | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  const cleanDoi = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim();
  if (!cleanDoi) return null;

  const url = `${OPENALEX_BASE}/doi:${encodeURIComponent(cleanDoi)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? OPENALEX_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as unknown;
    if (!data || typeof data !== "object" || (data as Record<string, unknown>)["error"]) {
      return null;
    }

    return openAlexToPartialCsl(data as Record<string, unknown>);
  } catch {
    // Abort (timeout) / network error / JSON parse failure - silent degradation.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Map the OpenAlex work payload to the PartialCsl fields the field-level merge
 * cares about. Mirrors `openAlexToCsl` in packages/metadata-resolver - kept
 * duplicated (not imported) so the extension bundle stays self-contained for
 * store distribution.
 */
function openAlexToPartialCsl(data: Record<string, unknown>): PartialCsl {
  const out: PartialCsl = { type: "article-journal" };
  const pick = <T>(key: string): T | undefined => data[key] as T | undefined;

  out.title = pick<string>("display_name");
  const doi = pick<string>("doi");
  if (doi) out.DOI = doi;

  const openAccess = pick<Record<string, unknown>>("open_access");
  if (openAccess) {
    const oaUrl = openAccess["oa_url"] as string | undefined;
    if (oaUrl) out.URL = oaUrl;
  }

  const authorships = pick<Array<{ author?: { display_name?: string } }>>("authorships");
  if (Array.isArray(authorships)) {
    out.author = authorships.map((a) => {
      const name = a.author?.display_name ?? "";
      const parts = name.split(" ");
      if (parts.length >= 2) {
        return { given: parts.slice(0, -1).join(" "), family: parts.at(-1) };
      }
      return { literal: name };
    });
  }

  const host =
    pick<Record<string, unknown>>("primary_location") ??
    pick<Record<string, unknown>>("host_venue");
  if (host) {
    const displayName = host["display_name"] as string | undefined;
    if (displayName) out["container-title"] = displayName;
  }

  const biblio = pick<Record<string, unknown>>("biblio");
  if (biblio) {
    out.volume = (biblio["volume"] as string | undefined) ?? undefined;
    out.issue = (biblio["issue"] as string | undefined) ?? undefined;
    const firstPage = biblio["first_page"] as string | undefined;
    const lastPage = biblio["last_page"] as string | undefined;
    if (firstPage || lastPage) {
      const page = `${firstPage ?? ""}-${lastPage ?? ""}`;
      out.page = page === "-" ? undefined : page;
    }
  }

  const pubYear = pick<number>("publication_year");
  if (pubYear) {
    out.issued = { "date-parts": [[pubYear]] };
  }

  const concepts = pick<Array<{ display_name?: string }>>("concepts");
  if (Array.isArray(concepts)) {
    out.keywords = concepts
      .map((c) => c.display_name)
      .filter((s): s is string => Boolean(s));
  }

  return out;
}
