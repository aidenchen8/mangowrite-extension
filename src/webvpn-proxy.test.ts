import { describe, expect, it } from "vitest";

import {
  parseProxiedPageUrl,
  plainOriginFromHtml,
  proxyMappingFromPage,
  toProxiedUrl,
} from "./webvpn-proxy.js";

// 复现自真实抓取（Nature 经 webvpn.ccnu.edu.cn）：页面 URL 与 citation_pdf_url
// 的 host 前缀同源同 host，meta 未被改写。
const PAGE_URL =
  "https://webvpn.ccnu.edu.cn/https/77726476706e69737468656265737421e7e056d229317c456c0dc7af9758/articles/s41586-025-09922-y";
const NATURE_HEXPREFIX = "77726476706e69737468656265737421e7e056d229317c456c0dc7af9758";
const PAGE_HTML = `
  <html><head>
    <meta property="og:url" content="https://www.nature.com/articles/s41586-025-09922-y">
    <meta name="citation_pdf_url" content="https://www.nature.com/articles/s41586-025-09922-y.pdf">
  </head><body></body></html>
`;

describe("parseProxiedPageUrl", () => {
  it("recognizes the webvpn https/<hex>/path form", () => {
    expect(parseProxiedPageUrl(PAGE_URL)).toEqual({
      proxyOrigin: "https://webvpn.ccnu.edu.cn",
      hostPrefix: NATURE_HEXPREFIX,
    });
  });

  it("accepts an http scheme segment", () => {
    expect(
      parseProxiedPageUrl(`https://webvpn.uni.edu.cn/http/${NATURE_HEXPREFIX}/a/b`),
    ).not.toBeNull();
  });

  it("rejects plain publisher URLs", () => {
    expect(parseProxiedPageUrl("https://www.nature.com/articles/x")).toBeNull();
  });

  it("rejects paths whose first segments are not scheme/hex", () => {
    expect(parseProxiedPageUrl("https://webvpn.ccnu.edu.cn/login")).toBeNull();
    expect(parseProxiedPageUrl("https://webvpn.ccnu.edu.cn/https/articles/x")).toBeNull();
  });
});

describe("plainOriginFromHtml", () => {
  it("reads the publisher origin from og:url", () => {
    expect(plainOriginFromHtml(PAGE_HTML)).toBe("https://www.nature.com");
  });

  it("falls back to citation_pdf_url when og:url is absent", () => {
    const html = `<meta name="citation_pdf_url" content="https://link.springer.com/content/pdf/10.1.pdf">`;
    expect(plainOriginFromHtml(html)).toBe("https://link.springer.com");
  });

  it("returns null when no absolute declaration exists", () => {
    expect(plainOriginFromHtml("<meta property=\"og:url\" content=\"/relative\">")).toBeNull();
    expect(plainOriginFromHtml("<p>no metas</p>")).toBeNull();
  });
});

describe("proxyMappingFromPage", () => {
  it("pairs the page's proxy prefix with the declared plain origin", () => {
    expect(proxyMappingFromPage(PAGE_URL, PAGE_HTML)).toEqual({
      proxyOrigin: "https://webvpn.ccnu.edu.cn",
      hostPrefix: NATURE_HEXPREFIX,
      plainOrigin: "https://www.nature.com",
    });
  });

  it("is null for a non-proxied page even when metas exist", () => {
    expect(
      proxyMappingFromPage("https://www.nature.com/articles/x", PAGE_HTML),
    ).toBeNull();
  });

  it("is null when the page declares no plain origin", () => {
    expect(proxyMappingFromPage(PAGE_URL, "<p>empty</p>")).toBeNull();
  });
});

describe("toProxiedUrl", () => {
  const mapping = proxyMappingFromPage(PAGE_URL, PAGE_HTML)!;

  it("rewrites a same-host publisher URL into the page-origin proxy form", () => {
    expect(toProxiedUrl(mapping, "https://www.nature.com/articles/s41586-025-09922-y.pdf")).toBe(
      `https://webvpn.ccnu.edu.cn/https/${NATURE_HEXPREFIX}/articles/s41586-025-09922-y.pdf`,
    );
  });

  it("keeps query strings and drops fragments", () => {
    expect(
      toProxiedUrl(mapping, "https://www.nature.com/articles/x.pdf?download=true#page1"),
    ).toBe(`https://webvpn.ccnu.edu.cn/https/${NATURE_HEXPREFIX}/articles/x.pdf?download=true`);
  });

  it("passes through URLs already on the proxy origin", () => {
    const already = `https://webvpn.ccnu.edu.cn/https/${NATURE_HEXPREFIX}/articles/x.pdf`;
    expect(toProxiedUrl(mapping, already)).toBe(already);
  });

  it("returns null for unrelated hosts (their hex prefixes are unknown)", () => {
    expect(toProxiedUrl(mapping, "https://static.content-server.com/paper.pdf")).toBeNull();
    expect(toProxiedUrl(mapping, "not a url")).toBeNull();
  });
});
