// DSpace 7 translator.
//
// DSpace 7 deployments (GSU ScholarWorks, Arizona Campus Repository, …) serve
// an Angular CSR shell: the server HTML carries NO citation_*/DC/JSON-LD at
// all — every scholarly signal the generic translator needs is missing. The
// canonical record lives behind the site's own REST API, which the Angular app
// itself reads, so a same-origin credentialed fetch reaches it exactly when
// the page rendered (bot walls like Arizona's 403-on-curl don't apply).
//
// Item landing routes: /items/<uuid> and /entities/<type>/<uuid>. Older
// /handle/<prefix>/<suffix> links resolve through an extra pid lookup and are
// not covered here yet.

import type { PartialCsl } from "../metadata-extract.js";
import { parseAuthors } from "../metadata-extract.js";
import type { Attachment, Translator, TranslatorResult } from "./types.js";

/** Item landing pages carry the item uuid as the last path segment. */
export function itemUuidFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    const m = path.match(/\/(?:items|entities\/[a-z-]+)\/([0-9a-f-]{36})$/i);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The Angular mount tag — present in every DSpace 7 shell, SSR or CSR. */
function isDspaceShell(html: string): boolean {
  return /<ds-app[\s>]/i.test(html);
}

type DcEntry = { value?: string };

interface DspaceItem {
  name?: string;
  handle?: string;
  metadata?: Record<string, DcEntry[] | undefined>;
  _links?: { bundles?: { href?: string } };
}

interface DspaceBundle {
  name?: string;
  _links?: { bitstreams?: { href?: string } };
}

interface DspaceBitstream {
  name?: string;
  mimeType?: string;
  _links?: { content?: { href?: string } };
}

function first(md: Record<string, DcEntry[] | undefined>, key: string): string | undefined {
  const value = md[key]?.[0]?.value;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function all(md: Record<string, DcEntry[] | undefined>, key: string): string[] {
  return (md[key] ?? [])
    .map((entry) => entry.value?.trim())
    .filter((v): v is string => Boolean(v));
}

const DOI_RE = /\b(10\.\d{4,}(?:\.\d+)*\/[^\s"'<>]+)/i;

function stripInlineHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function cslType(md: Record<string, DcEntry[] | undefined>): PartialCsl["type"] {
  // ETDs: many repositories leave dc.type empty and only fill dc.description.degree.
  const degree = first(md, "dc.description.degree");
  const dcType = `${first(md, "dc.type") ?? ""} ${degree ?? ""}`.toLowerCase();
  if (degree || /thesis|dissertation/.test(dcType)) return "thesis";
  if (/conference|proceedings/.test(dcType)) return "paper-conference";
  if (/\bbook\b/.test(dcType)) return "book";
  return "article-journal";
}

function toCsl(item: DspaceItem): PartialCsl {
  const md = item.metadata ?? {};
  const out: PartialCsl = { type: cslType(md) };

  out.title = first(md, "dc.title") ?? item.name;
  const authors = parseAuthors(all(md, "dc.contributor.author")) ?? [];
  if (authors.length) out.author = authors;
  out.publisher = first(md, "dc.publisher");
  out.language = first(md, "dc.language.iso");

  const abstract = first(md, "dc.description.abstract");
  if (abstract) out.abstract = stripInlineHtml(abstract);

  // "2022-05-13" and bare years both occur; keep what the field gives.
  const issued = first(md, "dc.date.issued");
  const ymd = issued?.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (ymd?.[1]) {
    const parts = [Number(ymd[1])];
    if (ymd[2]) parts.push(Number(ymd[2]));
    if (ymd[3]) parts.push(Number(ymd[3]));
    out.issued = { "date-parts": [parts] };
  }

  const doi = first(md, "dc.identifier.doi")?.match(DOI_RE)?.[1];
  if (doi) out.DOI = doi.toLowerCase();

  const keywords = all(md, "dc.subject");
  if (keywords.length) out.keywords = keywords.slice(0, 12);

  return out;
}

/** Absolute REST hrefs in responses → origin-relative, so WebVPN rewrites keep working. */
function relativeApi(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return `${url.pathname}${url.search}`;
  } catch {
    return href.startsWith("/") ? href : `/${href}`;
  }
}

async function fetchJson(ctx: { fetchText: (url: string, init?: RequestInit) => Promise<string> }, url: string): Promise<unknown> {
  const raw = await ctx.fetchText(url, { headers: { Accept: "application/json" } });
  return JSON.parse(raw);
}

/** ORIGINAL bundle = the deposit's own files (TEXT/THUMBNAIL are derivates). */
async function findPdfAttachment(
  ctx: { fetchText: (url: string, init?: RequestInit) => Promise<string> },
  itemUuid: string,
  fallbackName: string,
): Promise<Attachment | null> {
  try {
    const bundlesUrl = relativeApi(`/server/api/core/items/${itemUuid}/bundles`);
    const bundles = (await fetchJson(ctx, bundlesUrl!)) as { _embedded?: { bundles?: DspaceBundle[] } };
    const original = bundles._embedded?.bundles?.find((bundle) => bundle.name === "ORIGINAL");
    const listUrl = relativeApi(original?._links?.bitstreams?.href);
    if (!listUrl) return null;

    const list = (await fetchJson(ctx, listUrl)) as { _embedded?: { bitstreams?: DspaceBitstream[] } };
    const bitstreams = list._embedded?.bitstreams ?? [];
    const pdf =
      bitstreams.find(
        (b) => b.mimeType?.toLowerCase().includes("pdf") || /\.pdf$/i.test(b.name ?? ""),
      ) ?? null;
    if (!pdf) return null;

    const contentHref = pdf._links?.content?.href;
    if (!contentHref) return null;
    // 附件交给 background 下载，必须给绝对 URL；上面的列表请求走相对路径是
    // 为了 WebVPN，这里的 href 用 REST 响应原样值。
    return {
      kind: "pdf",
      url: contentHref,
      mime: "application/pdf",
      filename: pdf.name || fallbackName,
    };
  } catch {
    // Metadata matters more than the file — a bundles failure degrades to a
    // metadata-only import instead of failing the whole capture.
    return null;
  }
}

export const dspaceTranslator: Translator = {
  id: "dspace",
  label: "DSpace 仓库",
  match: () => true,
  detect: ({ url, html }) => isDspaceShell(html) && itemUuidFromUrl(url) !== null,
  async extract(ctx): Promise<TranslatorResult> {
    const itemUuid = itemUuidFromUrl(ctx.url)!;
    // No item record → nothing worth importing; let the caller fail loudly
    // rather than file an empty shell as a paper.
    const item = (await fetchJson(ctx, `/server/api/core/items/${itemUuid}`)) as DspaceItem;
    const metadata = toCsl(item);

    const fallbackName = `${(metadata.title ?? itemUuid).slice(0, 60).replace(/[^\w一-鿿-]+/gi, "-")}.pdf`;
    const attachments: Attachment[] = [];
    const pdf = await findPdfAttachment(ctx, itemUuid, fallbackName);
    if (pdf) attachments.push(pdf);

    return {
      metadata,
      identifier: metadata.DOI ?? null,
      resolverSource: "plugin-dom-en",
      attachments,
      // The bitstream link above is already the repository's canonical file.
      allowGenericPdfDiscovery: false,
      allowRawHtmlFallback: false,
    };
  },
};
