import { describe, expect, it, vi } from "vitest";

import { cqvipTranslator, extractCqvipId } from "./cqvip.js";

const URL = "https://www.cqvip.com/doc/journal/1234567";
const HTML = `<html><head>
  <meta property="og:title" content="某研究论文 - 维普期刊">
  <link rel="stylesheet" href="https://www.cqvip.com/app.css">
</head><body>
  <script>window.__NUXT__=(function(a){return {state:{detail:{id:"vipdc:1234567"}}}})()</script>
  <a class="btn-down" href="https://www.cqvip.com/doc/download/1234567.pdf">PDF下载</a>
</body></html>`;

// Captured verbatim from
//   /newsite/literature/base/ref/export?ids=50158710&types=1&styles=RefMan
// on 2026-07-10. Despite the `RefMan` style name the payload is *RefWorks*
// tagged text, not RIS. The previous fixture here invented `TY  - JOUR` lines,
// so these tests passed green while the live translator parsed nothing and
// silently degraded to scraping the page title.
const REFMAN = JSON.stringify({
  data: [
    {
      refText: [
        "RT Journal Article",
        "T1 深度学习研究进展",
        "JF 计算机应用研究",
        "YR 2014",
        "VO 31",
        "IS 7",
        "OP 1921-1930+1942",
        "AB 鉴于深度学习的重要性,综述了深度学习的研究进展。",
        "UL https://www.cqvip.com/doc/journal/50158710",
        "A1 刘建伟;刘媛;罗雄麟",
        "AD 中国石油大学自动化研究所,null",
        "SN 1001-3695",
        "CN 51-1196/TP",
        "K1 深度学习;神经网络;模型",
        "DS 重庆维普资讯有限公司",
        "",
      ].join("\n"),
    },
  ],
});

describe("extractCqvipId", () => {
  it("reads the id from the /doc/ URL", () => {
    expect(extractCqvipId({ url: URL, html: "" })).toBe("1234567");
  });
  it("falls back to the vipdc: marker in NUXT state", () => {
    expect(extractCqvipId({ url: "https://www.cqvip.com/", html: HTML })).toBe("1234567");
  });
});

describe("cqvipTranslator", () => {
  it("matches cqvip.com and detects an article page", () => {
    expect(cqvipTranslator.match(URL)).toBe(true);
    expect(cqvipTranslator.detect({ url: URL, html: HTML })).toBe(true);
    // A /doc/x/123 path on an unrelated host must NOT be misread as CQVIP.
    expect(cqvipTranslator.detect({ url: "https://other.com/doc/x/9", html: "<html></html>" })).toBe(
      false,
    );
  });

  it("uses the RefMan export endpoint and offers a PDF attachment", async () => {
    const fetchText = vi.fn().mockResolvedValue(REFMAN);
    const result = await cqvipTranslator.extract({ url: URL, html: HTML, fetchText });

    expect(fetchText).toHaveBeenCalledWith(
      "https://www.cqvip.com/newsite/literature/base/ref/export?ids=1234567&types=1&styles=RefMan",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(result.metadata.title).toBe("深度学习研究进展");
    expect(result.metadata["container-title"]).toBe("计算机应用研究");
    expect(result.metadata.author).toEqual([
      { literal: "刘建伟" },
      { literal: "刘媛" },
      { literal: "罗雄麟" },
    ]);
    expect(result.metadata.volume).toBe("31");
    expect(result.metadata.issue).toBe("7");
    // 断页 notation: pages 1921–1930 plus a stray 1942. Dropping the tail would
    // lose a page the paper actually occupies, so it is carried through as-is.
    expect(result.metadata.page).toBe("1921-1930+1942");
    expect(result.metadata.ISSN).toEqual(["1001-3695"]);
    // CQVIP records carry no DOI at all — the field must stay absent, not empty.
    expect(result.metadata.DOI).toBeUndefined();
    expect(result.resolverSource).toBe("plugin-dom-zh");
    expect(result.attachments[0]).toMatchObject({
      kind: "pdf",
      url: "https://www.cqvip.com/doc/download/1234567.pdf",
    });
    expect(result.allowRawHtmlFallback).toBe(false);
  });

  it("degrades to the page title when the export API fails", async () => {
    const fetchText = vi.fn().mockRejectedValue(new Error("401"));
    const result = await cqvipTranslator.extract({ url: URL, html: HTML, fetchText });
    expect(result.metadata.title).toBe("某研究论文");
    expect(result.metadata.URL).toBeTruthy();
  });
});

describe("cqvipTranslator — stable work key", () => {
  // CQVIP records rarely carry a DOI, so without a native id the work keyed on
  // the landing-page URL and moved with the WebVPN host prefix.
  it("emits the doc id as nativeId", async () => {
    const result = await cqvipTranslator.extract({
      url: URL,
      html: HTML,
      fetchText: vi.fn().mockRejectedValue(new Error("export unavailable")),
    });
    expect(result.metadata.nativeId).toBe("cqvip:1234567");
  });

  it("yields the same nativeId through a WebVPN proxy, where the URL differs", async () => {
    const vpnUrl =
      "https://webvpn.ccnu.edu.cn/https/77726476706e69737468656265737421e5ff408e/doc/journal/1234567";
    const fetchText = vi.fn().mockRejectedValue(new Error("export unavailable"));
    const direct = await cqvipTranslator.extract({ url: URL, html: HTML, fetchText });
    const proxied = await cqvipTranslator.extract({ url: vpnUrl, html: HTML, fetchText });

    expect(proxied.metadata.nativeId).toBe(direct.metadata.nativeId);
    expect(proxied.metadata.nativeId).toBe("cqvip:1234567");
  });
});
