import { describe, expect, it } from "vitest";

import { documentKindFromContentType, looksLikePdfBytes, urlPathnameLooksLikePdf } from "./pdf-detect.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("looksLikePdfBytes", () => {
  it("accepts a normal PDF header", () => {
    expect(looksLikePdfBytes(enc("%PDF-1.7\n%âãÏÓ\n1 0 obj"))).toBe(true);
  });

  it("accepts a header preceded by leading junk (within 1KB)", () => {
    expect(looksLikePdfBytes(enc(" ".repeat(200) + "%PDF-1.4"))).toBe(true);
  });

  it("rejects an HTML login/paywall page served at a .pdf URL", () => {
    expect(looksLikePdfBytes(enc("<!DOCTYPE html><html><head><title>Sign in"))).toBe(false);
  });

  it("rejects empty / too-short input", () => {
    expect(looksLikePdfBytes(new Uint8Array())).toBe(false);
    expect(looksLikePdfBytes(enc("%PD"))).toBe(false);
  });
});

describe("documentKindFromContentType", () => {
  it("classifies application/pdf (with or without parameters) as pdf", () => {
    expect(documentKindFromContentType("application/pdf")).toBe("pdf");
    expect(documentKindFromContentType("application/pdf; charset=utf-8")).toBe("pdf");
    expect(documentKindFromContentType("  APPLICATION/PDF ")).toBe("pdf");
  });

  it("classifies HTML-ish documents as html", () => {
    expect(documentKindFromContentType("text/html")).toBe("html");
    expect(documentKindFromContentType("text/html; charset=gbk")).toBe("html");
    expect(documentKindFromContentType("application/xhtml+xml")).toBe("html");
    expect(documentKindFromContentType("text/plain")).toBe("html");
  });

  it("keeps download-ish / missing types unknown for the heuristics to arbitrate", () => {
    expect(documentKindFromContentType("application/octet-stream")).toBe("unknown");
    expect(documentKindFromContentType("")).toBe("unknown");
    expect(documentKindFromContentType(null)).toBe("unknown");
    expect(documentKindFromContentType(undefined)).toBe("unknown");
  });
});

describe("urlPathnameLooksLikePdf", () => {
  it("matches .pdf pathnames, case-insensitively, query excluded", () => {
    expect(urlPathnameLooksLikePdf("https://darwin-online.org.uk/converted/pdf/1879_Bary_Symbiose_A3450.pdf")).toBe(true);
    expect(urlPathnameLooksLikePdf("https://a.org/files/paper.PDF")).toBe(true);
    // DSpace 式带查询串的 .pdf 链接：pathname 不含 query，应当命中。
    expect(urlPathnameLooksLikePdf("https://a.org/bitstream/handle/1/2/paper.pdf?sequence=1&isAllowed=y")).toBe(true);
  });

  it("rejects non-pdf pathnames and non-http(s) schemes", () => {
    // arXiv 的下载路径没有扩展名——URL 启发式覆盖不了它，只能靠 Content-Type 事实。
    expect(urlPathnameLooksLikePdf("https://arxiv.org/pdf/2401.01234")).toBe(false);
    expect(urlPathnameLooksLikePdf("https://a.org/paper.pdf.html")).toBe(false);
    expect(urlPathnameLooksLikePdf("file:///D:/docs/paper.pdf")).toBe(false);
    expect(urlPathnameLooksLikePdf(null)).toBe(false);
  });
});
