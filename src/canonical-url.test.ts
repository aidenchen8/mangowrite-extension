import { describe, expect, it } from "vitest";

import {
  canonicalizeUrl,
  extractCanonicalHint,
  normalizeObservedUrl,
  sanitizeOriginUrl,
} from "./canonical-url.js";

describe("normalizeObservedUrl", () => {
  it("upgrades http→https, lowercases host, drops fragment", () => {
    expect(normalizeObservedUrl("http://Example.com/a#top")).toBe(
      "https://example.com/a",
    );
  });

  it("strips tracking params but keeps meaningful ones", () => {
    expect(
      normalizeObservedUrl("https://x.com/read?id=123&utm_source=weibo&fbclid=zz"),
    ).toBe("https://x.com/read?id=123");
  });

  it("drops a trailing slash but keeps the root slash", () => {
    expect(normalizeObservedUrl("https://x.com/article/")).toBe("https://x.com/article");
    expect(normalizeObservedUrl("https://x.com/")).toBe("https://x.com/");
  });

  it("normalizes query parameter order", () => {
    expect(normalizeObservedUrl("https://example.com/article?b=2&a=1")).toBe(
      "https://example.com/article?a=1&b=2",
    );
  });

  // `m.` 曾经被无条件剥掉，那会把 m.media-amazon.com 这类**域名本身**以 m. 开头
  // 的站点改写成另一个主机。移动版与桌面版的归并改由页面声明的 canonical 负责。
  it("leaves host prefixes alone — `m.` can be part of the domain itself", () => {
    expect(normalizeObservedUrl("https://m.example.com/article")).toBe(
      "https://m.example.com/article",
    );
    expect(normalizeObservedUrl("https://m.media-amazon.com/images/x")).toBe(
      "https://m.media-amazon.com/images/x",
    );
  });

  it("keeps `ref` — it is a real parameter on GitHub/Amazon, not tracking junk", () => {
    expect(normalizeObservedUrl("https://github.com/o/r/blob/main/f.ts?ref=main")).toBe(
      "https://github.com/o/r/blob/main/f.ts?ref=main",
    );
  });

  it("still drops the tracking params it is meant to drop", () => {
    expect(normalizeObservedUrl("https://example.com/p?utm_source=x&fbclid=y&id=7")).toBe(
      "https://example.com/p?id=7",
    );
  });
});

describe("sanitizeOriginUrl", () => {
  it("normalizes parseable URLs", () => {
    expect(sanitizeOriginUrl("https://kns.cnki.net/article?id=abc")).toBe(
      "https://kns.cnki.net/article?id=abc",
    );
  });

  it("returns the original URL when parsing fails", () => {
    expect(sanitizeOriginUrl("not-a-url")).toBe("not-a-url");
  });
});

describe("extractCanonicalHint + canonicalizeUrl", () => {
  it("reads <link rel=canonical>", () => {
    const html = `<link rel="canonical" href="https://x.com/canonical">`;
    expect(extractCanonicalHint(html)).toBe("https://x.com/canonical");
  });

  it("reads canonical link attributes in either order", () => {
    const html = `<link href="https://x.com/canonical" rel="canonical">`;
    expect(extractCanonicalHint(html)).toBe("https://x.com/canonical");
  });

  it("reads og:url", () => {
    const html = `<meta property="og:url" content="https://x.com/og">`;
    expect(extractCanonicalHint(html)).toBe("https://x.com/og");
  });

  it("reads og:url attributes in either order", () => {
    const html = `<meta content="https://x.com/og" property="og:url">`;
    expect(extractCanonicalHint(html)).toBe("https://x.com/og");
  });

  it("prefers the declared canonical over the observed URL", () => {
    expect(
      canonicalizeUrl("https://m.x.com/read?utm_source=z", {
        canonicalHint: "https://x.com/read",
      }),
    ).toBe("https://x.com/read");
  });

  it("two messy URLs for the same page collapse to one identity", () => {
    const a = canonicalizeUrl("http://x.com/p?utm_source=a&id=9");
    const b = canonicalizeUrl("https://x.com/p?id=9&fbclid=b#x");
    expect(a).toBe(b);
  });

  it("uses a reordered canonical link to key the webpage", () => {
    const hint = extractCanonicalHint(
      `<link href="https://example.com/article?id=9" rel="canonical">`,
    );
    expect(
      canonicalizeUrl("https://m.example.com/amp?id=9", { canonicalHint: hint }),
    ).toBe("https://example.com/article?id=9");
  });
});
