import { describe, expect, it, vi } from "vitest";

import { extractWanfangRef, wanfangTranslator } from "./wanfang.js";

const URL = "https://d.wanfangdata.com.cn/periodical/xbszyysgc201404019";
const HTML = `<html><head>
  <meta property="og:url" content="https://d.wanfangdata.com.cn/periodical/xbszyysgc201404019">
  <meta name="citation_title" content="基于TRMM数据的云南降水监测">
  <meta name="citation_author" content="张三">
  <meta name="citation_author" content="李四">
  <meta name="citation_journal_title" content="西北水资源与水工程">
  <meta name="citation_volume" content="25">
  <meta name="citation_issue" content="4">
  <meta name="citation_firstpage" content="19">
  <meta name="citation_lastpage" content="24">
  <meta name="citation_publication_date" content="2014">
</head><body>万方数据</body></html>`;

describe("extractWanfangRef", () => {
  it("reads type/id from og:url", () => {
    expect(extractWanfangRef({ url: "https://x/", html: HTML })).toEqual({
      type: "periodical",
      id: "xbszyysgc201404019",
    });
  });
  it("falls back to the page URL path", () => {
    expect(extractWanfangRef({ url: URL, html: "<html></html>" })).toEqual({
      type: "periodical",
      id: "xbszyysgc201404019",
    });
  });
});

describe("wanfangTranslator", () => {
  it("detects a wanfang detail page, rejects unrelated hosts", () => {
    expect(wanfangTranslator.detect({ url: URL, html: HTML })).toBe(true);
    expect(
      wanfangTranslator.detect({ url: "https://other.com/periodical/abc", html: "<html></html>" }),
    ).toBe(false);
  });

  it("scrapes citation_* metadata and constructs an oss PDF url", async () => {
    const fetchText = vi.fn();
    const result = await wanfangTranslator.extract({ url: URL, html: HTML, fetchText });

    // No network call — metadata comes from the page (protobuf is out of scope).
    expect(fetchText).not.toHaveBeenCalled();
    expect(result.metadata.title).toBe("基于TRMM数据的云南降水监测");
    expect(result.metadata["container-title"]).toBe("西北水资源与水工程");
    expect(result.metadata.page).toBe("19-24");
    expect(result.metadata.author).toEqual([{ literal: "张三" }, { literal: "李四" }]);
    expect(result.resolverSource).toBe("plugin-dom-zh");

    const pdf = result.attachments[0]!;
    expect(pdf.kind).toBe("pdf");
    expect(pdf.url).toContain("oss.wanfangdata.com.cn/www/");
    expect(pdf.url).toContain("resourceId=xbszyysgc201404019");
    expect(pdf.url).toContain("type=periodical");
  });

  it("prefers an embedded fulltextpath when present", async () => {
    const html =
      HTML.replace("</body>", "") +
      `<script>{"hasfulltext":true,"fulltextpath":"https://oss.wanfangdata.com.cn/direct/abc.pdf"}</script></body></html>`;
    const result = await wanfangTranslator.extract({ url: URL, html, fetchText: vi.fn() });
    expect(result.attachments[0]!.url).toBe("https://oss.wanfangdata.com.cn/direct/abc.pdf");
  });
});

// The live Wanfang detail page ships **no** citation_* tags: its SPA injects
// OpenGraph, and leaves journal / DOI / ISSN / 年卷期 / 页数 only in markup.
// Fragment lifted from d.wanfangdata.com.cn/periodical/hbmzdxxb-zxsh202603009.
const OG_DOM_HTML = `<html><head>
  <meta property="og:url" content="https://d.wanfangdata.com.cn/Periodical/hbmzdxxb-zxsh202603009">
  <meta property="og:title" content="非物质文化遗产的美学批判">
  <meta property="og:article:author" content="牛乐">
  <meta property="og:article:published_time" content="2026-05-10 00:00:00">
  <meta property="og:article:tag" content="非物质文化遗产,美学,审美,社会批判">
</head><body>
  <div data-v-2cd30a8a="" class="doiStyle"> DOI: <a data-v-2cd30a8a="">10.3969/j.issn.2096-7586.2026.03.009</a></div>
  <div data-v-be2ba486="" class="periodicalName"><a data-v-be2ba486="" target="_blank" href="https://c.wanfangdata.com.cn/magazine/hbmzdxxb-zxsh"> 湖北民族大学学报（哲学社会科学版） </a></div>
  <div data-v-be2ba486="" class="coreContainer Mcore"><span class="core-periodical-item"> 北大核心 </span></div>
  <div data-v-be2ba486="" class="periodicalDataItem M10">ISSN：2096-7586</div>
  <div data-v-be2ba486="" class="publishData MCD"><span class="item">年,卷(期)：</span><a href="https://c.wanfangdata.com.cn/magazine/x?publishYear=2026&amp;issueNum=3"><span>2026</span><span>,44</span><span>(3)</span></a></div>
  <div class="pages list"><span class="item">页数：</span><div class="itemUrl">12 <span class="canReadOnline"><span>(</span> 82-93 <span>)</span></span></div></div>
</body></html>`;

describe("wanfangTranslator on the live OG + DOM page shape", () => {
  const ctx = {
    url: "https://d.wanfangdata.com.cn/periodical/hbmzdxxb-zxsh202603009",
    html: OG_DOM_HTML,
    fetchText: vi.fn(),
  };

  it("takes author/year/keywords from og:article:*", async () => {
    const { metadata } = await wanfangTranslator.extract(ctx);
    expect(metadata.title).toBe("非物质文化遗产的美学批判");
    expect(metadata.author).toEqual([{ literal: "牛乐" }]);
    expect(metadata.issued).toEqual({ "date-parts": [[2026]] });
    expect(metadata.keywords).toEqual(["非物质文化遗产", "美学", "审美", "社会批判"]);
  });

  it("scrapes journal/DOI/ISSN/年卷期/页码 out of the markup", async () => {
    const { metadata } = await wanfangTranslator.extract(ctx);
    // Must not swallow the adjacent 核心 badge.
    expect(metadata["container-title"]).toBe("湖北民族大学学报（哲学社会科学版）");
    expect(metadata.DOI).toBe("10.3969/j.issn.2096-7586.2026.03.009");
    expect(metadata.ISSN).toEqual(["2096-7586"]);
    expect(metadata.volume).toBe("44");
    expect(metadata.issue).toBe("3");
    expect(metadata.page).toBe("82-93");
  });
});

describe("wanfangTranslator — stable work key", () => {
  // Wanfang records often carry no DOI. Without a native id the work keyed on
  // the landing-page URL, which changes with a WebVPN prefix and SPA query, so
  // re-importing the same paper minted a second work — the failure CNKI had.
  it("emits the <type>/<id> accession pair as nativeId", async () => {
    const result = await wanfangTranslator.extract({ url: URL, html: HTML, fetchText: vi.fn() });
    expect(result.metadata.nativeId).toBe("wanfang:periodical/xbszyysgc201404019");
  });

  it("yields the same nativeId through a WebVPN proxy, where the URL differs", async () => {
    const vpnUrl =
      "https://webvpn.ccnu.edu.cn/https/77726476706e69737468656265737421e5ff408e/periodical/xbszyysgc201404019?utm_source=x";
    const direct = await wanfangTranslator.extract({ url: URL, html: HTML, fetchText: vi.fn() });
    const proxied = await wanfangTranslator.extract({ url: vpnUrl, html: HTML, fetchText: vi.fn() });

    expect(proxied.metadata.nativeId).toBe(direct.metadata.nativeId);
    expect(proxied.metadata.nativeId).toBeTruthy();
  });
});
