// Vendored from MangoWrite's internal metadata-resolver package at export v0.1.18 - edit upstream, not here.
import { describe, expect, it } from "vitest";

import { extractPluginPdfCandidates } from "./pdf-candidates.js";

describe("extractPluginPdfCandidates", () => {
  it("extracts generic citation_pdf_url metadata", () => {
    expect(
      extractPluginPdfCandidates({
        pageUrl: "https://publisher.example/article",
        html: '<meta name="citation_pdf_url" content="/paper.pdf">',
      }),
    ).toEqual([
      {
        url: "https://publisher.example/paper.pdf",
        strategy: "meta:citation_pdf_url",
        publisher: "generic-meta",
      },
    ]);
  });

  it("extracts citation_pdf_url written content-first with an unquoted name (ACL Anthology)", () => {
    expect(
      extractPluginPdfCandidates({
        pageUrl: "https://aclanthology.org/N19-1423/",
        html: '<meta content="https://aclanthology.org/N19-1423.pdf" name=citation_pdf_url>',
      }),
    ).toEqual([
      {
        url: "https://aclanthology.org/N19-1423.pdf",
        strategy: "meta:citation_pdf_url",
        publisher: "generic-meta",
      },
    ]);
  });

  it("matches Springer pdf-link anchors whatever the attribute order", () => {
    expect(
      extractPluginPdfCandidates({
        pageUrl: "https://link.springer.com/article/10.1007/s13042-024-02443-6",
        html: '<a href="/content/pdf/10.1007/s13042-024-02443-6.pdf" data-test="pdf-link">Download PDF</a>',
      }),
    ).toContainEqual({
      url: "https://link.springer.com/content/pdf/10.1007/s13042-024-02443-6.pdf",
      strategy: "springer:content-pdf-link",
      publisher: "springer",
    });
  });

  it("adds publisher-specific arXiv PDF candidates", () => {
    expect(
      extractPluginPdfCandidates({
        pageUrl: "https://arxiv.org/abs/1406.2661",
        html: "<html></html>",
      }),
    ).toEqual([
      {
        url: "https://arxiv.org/pdf/1406.2661.pdf",
        strategy: "arxiv:abs-to-pdf",
        publisher: "arxiv",
      },
    ]);
  });

  it("extracts Nature PDF links from article pages", () => {
    expect(
      extractPluginPdfCandidates({
        pageUrl: "https://www.nature.com/articles/s41586-024-12345-6",
        html: '<a data-track-action="download pdf" href="/articles/s41586-024-12345-6.pdf">Download PDF</a>',
      }),
    ).toContainEqual({
      url: "https://www.nature.com/articles/s41586-024-12345-6.pdf",
      strategy: "nature:download-link",
      publisher: "nature",
    });
  });

  it("extracts Springer PDF links from content/pdf paths", () => {
    expect(
      extractPluginPdfCandidates({
        pageUrl: "https://link.springer.com/article/10.1007/s00134-024-12345-6",
        html: '<a data-test="pdf-link" href="/content/pdf/10.1007%2Fs00134-024-12345-6.pdf">Download PDF</a>',
      }),
    ).toContainEqual({
      url: "https://link.springer.com/content/pdf/10.1007%2Fs00134-024-12345-6.pdf",
      strategy: "springer:content-pdf-link",
      publisher: "springer",
    });
  });

  it("extracts IEEE stamp PDF links", () => {
    expect(
      extractPluginPdfCandidates({
        pageUrl: "https://ieeexplore.ieee.org/document/1234567",
        html: '<a class="stats-document-lh-action-downloadPdf" href="/stamp/stamp.jsp?tp=&arnumber=1234567">PDF</a>',
      }),
    ).toContainEqual({
      url: "https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=1234567",
      strategy: "ieee:stamp-link",
      publisher: "ieee",
    });
  });

  it("extracts bepress_citation_pdf_url (Digital Commons)", () => {
    expect(
      extractPluginPdfCandidates({
        pageUrl: "https://docs.lib.purdue.edu/clcweb/vol27/iss1/13/",
        html: '<meta name="bepress_citation_pdf_url" content="https://docs.lib.purdue.edu/cgi/viewcontent.cgi?article=5180&amp;context=clcweb">',
      }),
    ).toEqual([
      {
        url: "https://docs.lib.purdue.edu/cgi/viewcontent.cgi?article=5180&context=clcweb",
        strategy: "meta:bepress_citation_pdf_url",
        publisher: "generic-meta",
      },
    ]);
  });

  // DSpace 7 站点（GSU、Arizona）的 /bitstreams/<uuid>/download 只回 SPA 壳，
  // REST content 端点才是真文件——download 失败后按序兜底。
  it("pairs a DSpace bitstream download candidate with the REST content endpoint", () => {
    const candidates = extractPluginPdfCandidates({
      pageUrl: "https://repository.arizona.edu/items/0cadb8d5-9ee4-4941-afbc-7deafdb13346",
      html: '<meta name="citation_pdf_url" content="https://repository.arizona.edu/bitstreams/e22c081e-db31-4eb2-beb0-d476033fc852/download">',
    });
    expect(candidates.map((candidate) => [candidate.strategy, candidate.url])).toEqual([
      [
        "meta:citation_pdf_url",
        "https://repository.arizona.edu/bitstreams/e22c081e-db31-4eb2-beb0-d476033fc852/download",
      ],
      [
        "dspace:rest-content",
        "https://repository.arizona.edu/server/api/core/bitstreams/e22c081e-db31-4eb2-beb0-d476033fc852/content",
      ],
    ]);
  });
});
