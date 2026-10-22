import { describe, expect, it } from "vitest";

import { dspaceRestContentUrl } from "../vendor/metadata-resolver/pdf-candidates";

import { resolvePublisherPdf } from "./publisher-pdf.js";

describe("resolvePublisherPdf", () => {
  it("arXiv abs → pdf", () => {
    expect(resolvePublisherPdf({ url: "https://arxiv.org/abs/2401.01234", doi: null })).toBe(
      "https://arxiv.org/pdf/2401.01234",
    );
  });

  it("bioRxiv content path → .full.pdf", () => {
    expect(
      resolvePublisherPdf({
        url: "https://www.biorxiv.org/content/10.1101/2020.01.01.123456v2",
        doi: null,
      }),
    ).toBe("https://www.biorxiv.org/content/10.1101/2020.01.01.123456v2.full.pdf");
  });

  it("Springer/Wiley/T&F build from DOI", () => {
    expect(
      resolvePublisherPdf({ url: "https://link.springer.com/article/10.1007/s00330-021-08050-1", doi: "10.1007/s00330-021-08050-1" }),
    ).toBe("https://link.springer.com/content/pdf/10.1007/s00330-021-08050-1.pdf");
    expect(
      resolvePublisherPdf({ url: "https://onlinelibrary.wiley.com/doi/10.1002/adma.202100001", doi: "10.1002/adma.202100001" }),
    ).toBe("https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/adma.202100001");
    expect(
      resolvePublisherPdf({ url: "https://www.tandfonline.com/doi/full/10.1080/00000000.2020.1", doi: "10.1080/00000000.2020.1" }),
    ).toBe("https://www.tandfonline.com/doi/pdf/10.1080/00000000.2020.1");
  });

  it("Nature-hosted journals build .pdf from the /articles/<id> path", () => {
    expect(
      resolvePublisherPdf({
        url: "https://www.nature.com/articles/s41599-026-07166-3#Abs1",
        doi: "10.1057/s41599-026-07166-3",
      }),
    ).toBe("https://www.nature.com/articles/s41599-026-07166-3.pdf");
    // Falls back to the DOI suffix when the URL isn't the article page.
    expect(
      resolvePublisherPdf({ url: "https://www.nature.com/", doi: "10.1038/s41586-024-00001-2" }),
    ).toBe("https://www.nature.com/articles/s41586-024-00001-2.pdf");
  });

  it("Atypon platforms + ACM build /doi/pdf/<doi> off the page origin", () => {
    expect(
      resolvePublisherPdf({ url: "https://www.science.org/doi/10.1126/science.adp8882", doi: "10.1126/science.adp8882" }),
    ).toBe("https://www.science.org/doi/pdf/10.1126/science.adp8882");
    expect(
      resolvePublisherPdf({ url: "https://pubs.acs.org/doi/full/10.1021/acsguide.10503", doi: "10.1021/acsguide.10503" }),
    ).toBe("https://pubs.acs.org/doi/pdf/10.1021/acsguide.10503");
    expect(
      resolvePublisherPdf({ url: "https://journals.sagepub.com/doi/10.1177/21582440231158562", doi: "10.1177/21582440231158562" }),
    ).toBe("https://journals.sagepub.com/doi/pdf/10.1177/21582440231158562");
    expect(
      resolvePublisherPdf({ url: "https://dl.acm.org/doi/10.1145/3576915.3616631", doi: "10.1145/3576915.3616631" }),
    ).toBe("https://dl.acm.org/doi/pdf/10.1145/3576915.3616631");
  });

  it("MDPI appends /pdf to the article path (and only to article pages)", () => {
    expect(resolvePublisherPdf({ url: "https://www.mdpi.com/2076-3417/13/12/7260", doi: null })).toBe(
      "https://www.mdpi.com/2076-3417/13/12/7260/pdf",
    );
    expect(
      resolvePublisherPdf({ url: "https://www.mdpi.com/2076-3417/13/12/7260/htm", doi: null }),
    ).toBe("https://www.mdpi.com/2076-3417/13/12/7260/pdf");
    // Non-article pages (search/toc) get no PDF.
    expect(resolvePublisherPdf({ url: "https://www.mdpi.com/search?q=ai", doi: null })).toBeNull();
  });

  it("PLOS builds the printable file endpoint from the journal slug + DOI", () => {
    expect(
      resolvePublisherPdf({
        url: "https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0230134",
        doi: "10.1371/journal.pone.0230134",
      }),
    ).toBe("https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0230134&type=printable");
  });

  it("Frontiers builds /articles/<doi>/pdf (from DOI or the URL path)", () => {
    expect(
      resolvePublisherPdf({
        url: "https://www.frontiersin.org/articles/10.3389/fpsyg.2020.00001/full",
        doi: "10.3389/fpsyg.2020.00001",
      }),
    ).toBe("https://www.frontiersin.org/articles/10.3389/fpsyg.2020.00001/pdf");
    // Falls back to the DOI embedded in the article path when doi is absent.
    expect(
      resolvePublisherPdf({
        url: "https://www.frontiersin.org/articles/10.3389/fpsyg.2020.00001/full",
        doi: null,
      }),
    ).toBe("https://www.frontiersin.org/articles/10.3389/fpsyg.2020.00001/pdf");
  });

  it("returns null for unknown hosts and for DOI-based publishers without a DOI", () => {
    expect(resolvePublisherPdf({ url: "https://example.org/a", doi: "10.1/x" })).toBeNull();
    expect(resolvePublisherPdf({ url: "https://link.springer.com/article/x", doi: null })).toBeNull();
  });
});

// GSU / Arizona 的 DSpace 7 从 /bitstreams/<uuid>/download 只回 SPA 壳
// （2026-09 实站复盘），REST content 端点才出真文件。
describe("dspaceRestContentUrl", () => {
  it("rewrites a DSpace 7 bitstream download URL to the REST content endpoint", () => {
    expect(
      dspaceRestContentUrl(
        "https://scholarworks.gsu.edu/bitstreams/f59db07f-e9fa-48df-8dbe-e6ef41071f2f/download",
      ),
    ).toBe(
      "https://scholarworks.gsu.edu/server/api/core/bitstreams/f59db07f-e9fa-48df-8dbe-e6ef41071f2f/content",
    );
    expect(
      dspaceRestContentUrl(
        "https://repository.arizona.edu/bitstreams/e22c081e-db31-4eb2-beb0-d476033fc852/download",
      ),
    ).toBe(
      "https://repository.arizona.edu/server/api/core/bitstreams/e22c081e-db31-4eb2-beb0-d476033fc852/content",
    );
  });

  it("strips query/hash and leaves non-bitstream URLs alone", () => {
    expect(
      dspaceRestContentUrl("https://dspace.mit.edu/bitstreams/f949889d-1609-4121-bc86-d523235b1464/download?sequence=1"),
    ).toBe("https://dspace.mit.edu/server/api/core/bitstreams/f949889d-1609-4121-bc86-d523235b1464/content");
    expect(dspaceRestContentUrl("https://dspace.mit.edu/pdf/thesis.pdf")).toBeNull();
    expect(dspaceRestContentUrl("https://example.org/bitstreams/notauuid/download")).toBeNull();
    expect(dspaceRestContentUrl("not a url")).toBeNull();
  });
});
