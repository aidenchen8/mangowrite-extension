// Per-publisher PDF-URL hints for the generic (embedded-metadata) translator.
//
// Most English journals expose `citation_pdf_url`, which the generic translator
// already turns into a direct PDF attachment — that one meta tag is why Zotero's
// "Embedded Metadata" translator covers thousands of sites. But a few big
// publishers omit it on the article landing page while still serving the PDF at
// a *deterministic* URL derived from the DOI or an id in the page URL. This
// table fills that gap. It is consulted ONLY when `citation_pdf_url` is absent,
// so it never overrides a publisher's own declared link.
//
// Login/paywall still applies at download time — a deterministic URL isn't a
// bypass; it just gives the background worker the right link to try (with the
// page as Referer). Publishers whose PDF URL needs opaque tokens (ScienceDirect,
// IEEE) are intentionally absent — the server-side discovery fallback handles
// those. Pure/string-based and unit-testable without a DOM.
//
// DSpace REST 兜底不在这张表里：它已并入共享包
// @mango-write/metadata-resolver/pdf-candidates 的单实现。

interface PublisherRule {
  id: string;
  test: (host: string) => boolean;
  resolve: (input: { url: string; doi: string | null }) => string | null;
}

function encodeDoiPath(doi: string): string {
  // DOIs are used raw in these paths; only the reserved characters that would
  // break the URL need escaping.
  return doi.replace(/#/g, "%23").replace(/\?/g, "%3F");
}

/** Origin (scheme + host) of a page URL, or null if it doesn't parse. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const RULES: PublisherRule[] = [
  {
    id: "arxiv",
    test: (h) => /(^|\.)arxiv\.org$/i.test(h),
    resolve: ({ url }) => {
      const id = url.match(/arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?(?:[?#]|$)/i)?.[1];
      return id ? `https://arxiv.org/pdf/${id}` : null;
    },
  },
  {
    id: "biorxiv",
    // bioRxiv & medRxiv share the same content path shape.
    test: (h) => /(^|\.)(bio|med)rxiv\.org$/i.test(h),
    resolve: ({ url }) => {
      // …/content/10.1101/2020.01.01.123456v2(.full) → append .full.pdf
      const m = url.match(/\/content\/([^?#]+?)(?:\.full)?(?:\.pdf)?(?:[?#]|$)/i)?.[1];
      if (!m) return null;
      try {
        return `${new URL(url).origin}/content/${m}.full.pdf`;
      } catch {
        return null;
      }
    },
  },
  {
    id: "springer",
    test: (h) => /(^|\.)link\.springer\.com$/i.test(h),
    resolve: ({ doi }) =>
      doi ? `https://link.springer.com/content/pdf/${encodeDoiPath(doi)}.pdf` : null,
  },
  {
    id: "nature",
    // Nature-hosted journals (Nature, Scientific Reports, HSSC, …) omit
    // citation_pdf_url on many templates but serve the PDF at
    // /articles/<id>.pdf. <id> is the article slug in the landing-page path
    // (= the DOI suffix), e.g. …/articles/s41599-026-07166-3 → …​.pdf. The
    // download bounces through idp.nature.com to set the access cookie; the
    // background worker follows that with the user's session.
    test: (h) => /(^|\.)nature\.com$/i.test(h),
    resolve: ({ url, doi }) => {
      const fromPath = url.match(/\/articles\/([^/?#]+?)(?:\.pdf)?(?:[?#]|$)/i)?.[1];
      const id = fromPath ?? (doi ? doi.split("/").pop() : null);
      if (!id) return null;
      try {
        return `${new URL(url).origin}/articles/${id}.pdf`;
      } catch {
        return null;
      }
    },
  },
  {
    id: "wiley",
    test: (h) => /(^|\.)onlinelibrary\.wiley\.com$/i.test(h),
    resolve: ({ doi }) =>
      doi ? `https://onlinelibrary.wiley.com/doi/pdfdirect/${encodeDoiPath(doi)}` : null,
  },
  {
    id: "tandf",
    test: (h) => /(^|\.)tandfonline\.com$/i.test(h),
    resolve: ({ doi }) =>
      doi ? `https://www.tandfonline.com/doi/pdf/${encodeDoiPath(doi)}` : null,
  },
  {
    // Atypon-hosted platforms (Science/AAAS, ACS, SAGE — T&F above shares the
    // shape) plus ACM DL all serve the article PDF at the canonical
    // /doi/pdf/<doi> path off the same origin as the landing page. Entitlement
    // still applies at fetch; the deterministic link just points the download.
    id: "doi-pdf-path",
    test: (h) =>
      /(^|\.)science\.org$/i.test(h) ||
      /(^|\.)pubs\.acs\.org$/i.test(h) ||
      /(^|\.)journals\.sagepub\.com$/i.test(h) ||
      /(^|\.)dl\.acm\.org$/i.test(h),
    resolve: ({ url, doi }) => {
      const origin = originOf(url);
      return doi && origin ? `${origin}/doi/pdf/${encodeDoiPath(doi)}` : null;
    },
  },
  {
    // MDPI (fully OA): the article landing page /<issn>/<vol>/<issue>/<art>
    // serves its PDF by appending /pdf. Guard the article-path shape so we don't
    // hand back /pdf for a search or toc page.
    id: "mdpi",
    test: (h) => /(^|\.)mdpi\.com$/i.test(h),
    resolve: ({ url }) => {
      const origin = originOf(url);
      if (!origin) return null;
      try {
        const path = new URL(url).pathname.replace(/\/(pdf|htm|xml)$/i, "").replace(/\/+$/, "");
        if (!/^\/\d{4}-\d{3}[\dxX]\/\d+\/\d+\/[^/]+/.test(path)) return null;
        return `${origin}${path}/pdf`;
      } catch {
        return null;
      }
    },
  },
  {
    // PLOS (fully OA): PDF is served from the printable file endpoint, keyed by
    // DOI. The journal slug is the first path segment (plosone, plosbiology, …).
    id: "plos",
    test: (h) => /(^|\.)plos\.org$/i.test(h),
    resolve: ({ url, doi }) => {
      const origin = originOf(url);
      if (!doi || !origin) return null;
      try {
        const slug = new URL(url).pathname.split("/").filter(Boolean)[0];
        if (!slug) return null;
        return `${origin}/${slug}/article/file?id=${encodeDoiPath(doi)}&type=printable`;
      } catch {
        return null;
      }
    },
  },
  {
    // Frontiers (fully OA): /articles/<doi>/pdf 301-redirects to the current
    // /journals/<subject>/articles/<doi>/pdf path — the worker follows it.
    id: "frontiers",
    test: (h) => /(^|\.)frontiersin\.org$/i.test(h),
    resolve: ({ url, doi }) => {
      const d = doi ?? url.match(/\/articles\/(10\.\d{4,}\/[^/?#]+)/i)?.[1] ?? null;
      return d ? `https://www.frontiersin.org/articles/${encodeDoiPath(d)}/pdf` : null;
    },
  },
];

/** Deterministic PDF URL for a known publisher, or null if none applies. */
export function resolvePublisherPdf(input: { url: string; doi: string | null }): string | null {
  let host: string;
  try {
    host = new URL(input.url).hostname;
  } catch {
    return null;
  }
  for (const rule of RULES) {
    if (!rule.test(host)) continue;
    const pdf = rule.resolve(input);
    if (pdf) return pdf;
  }
  return null;
}
