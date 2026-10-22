import { describe, expect, it } from "vitest";

import { embeddedPdfTranslator, findEmbeddedPdfUrl } from "./embedded-pdf.js";

const noopFetch = async () => "";

describe("findEmbeddedPdfUrl", () => {
  it("extracts an IEEE stamp.jsp iframe PDF (absolute, signed query)", () => {
    const html =
      '<html><body><iframe src="https://ieeexplore.ieee.org/ielx8/6287639/10820123/10849561.pdf?tp=&arnumber=10849561&ref=aHR0cHM=" frameborder="0"></iframe></body></html>';
    expect(findEmbeddedPdfUrl(html, "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=10849561")).toBe(
      "https://ieeexplore.ieee.org/ielx8/6287639/10820123/10849561.pdf?tp=&arnumber=10849561&ref=aHR0cHM=",
    );
  });

  it("resolves a relative embed src against the page URL", () => {
    const html = '<embed type="application/pdf" src="/files/paper.pdf#page=2">';
    expect(findEmbeddedPdfUrl(html, "https://example.org/view/123")).toBe(
      "https://example.org/files/paper.pdf#page=2",
    );
  });

  it("reads <object data=...>", () => {
    const html = "<object data='doc.pdf?v=3'></object>";
    expect(findEmbeddedPdfUrl(html, "https://example.org/a/b")).toBe("https://example.org/a/doc.pdf?v=3");
  });

  it("ignores non-pdf iframes (ads, players)", () => {
    const html = '<iframe src="https://www.youtube.com/embed/xyz"></iframe><iframe src="/ad.html"></iframe>';
    expect(findEmbeddedPdfUrl(html, "https://example.org/")).toBeNull();
  });

  it("returns null when there is no embed at all", () => {
    expect(findEmbeddedPdfUrl("<html><body><p>hi</p></body></html>", "https://example.org/")).toBeNull();
  });
});

describe("embeddedPdfTranslator", () => {
  const stampHtml =
    '<html><head><title>IEEE Xplore Full-Text PDF:</title></head><body><iframe src="https://ieeexplore.ieee.org/ielx8/6287639/10820123/10849561.pdf?tp=&arnumber=10849561" frameborder="0"></iframe></body></html>';
  const stampUrl = "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=10849561";

  it("detects a PDF-viewer shell", () => {
    expect(embeddedPdfTranslator.detect({ url: stampUrl, html: stampHtml })).toBe(true);
  });

  it("does NOT steal a metadata-rich article page that also embeds a PDF", () => {
    const html =
      '<html><head><meta name="citation_title" content="A Paper"><meta name="citation_doi" content="10.1/x"></head>' +
      '<body><iframe src="/preview.pdf"></iframe></body></html>';
    expect(embeddedPdfTranslator.detect({ url: "https://pub.example/article/1", html })).toBe(false);
  });

  it("emits the embedded PDF as the sole attachment, no metadata", async () => {
    const result = await embeddedPdfTranslator.extract({
      url: stampUrl,
      html: stampHtml,
      fetchText: noopFetch,
    });
    expect(result.identifier).toBeNull();
    expect(result.metadata).toEqual({});
    expect(result.resolverSource).toBe("plugin-pdf-embed");
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      kind: "pdf",
      url: "https://ieeexplore.ieee.org/ielx8/6287639/10820123/10849561.pdf?tp=&arnumber=10849561",
      mime: "application/pdf",
      filename: "10849561.pdf",
    });
    expect(result.allowGenericPdfDiscovery).toBe(false);
    expect(result.allowRawHtmlFallback).toBe(false);
  });
});
