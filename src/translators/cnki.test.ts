import { describe, expect, it, vi } from "vitest";

import { cnkiTranslator, extractCnkiRef } from "./cnki.js";

// The operate-btn block copied from a real CNKI abstract page.
const OPERATE_BTN = `
<ul class="operate-btn">
  <div class="extend-btns">
    <li class="btn-cnki-ai"><a target="_blank" href="https://ai.cnki.net/study?cid=abc&amp;mimetype=XML"><i></i>CNKI AI阅读</a></li>
    <li class="btn-html"><a target="_blank" href="https://bar.cnki.net/bar/download/order?id=HTML_ID_123"><i></i>HTML阅读</a></li>
    <li class="btn-yb-reader"><a target="_blank" href="https://bar.cnki.net/bar/download/order?id=READER_ID"><i></i>原版阅读</a></li>
  </div>
  <div class="download-btns">
    <li class="btn-dlcaj"><a onclick="WriteKrsDownLog()" target="_blank" id="cajDown" name="cajDown" href="https://bar.cnki.net/bar/download/order?id=CAJ_ID"><i></i>CAJ下载</a></li>
    <li class="btn-dlpdf"><a onclick="WriteKrsDownLog()" target="_blank" id="pdfDown" name="pdfDown" href="https://bar.cnki.net/bar/download/order?id=PDF_ID_456"><i></i>PDF下载</a></li>
  </div>
</ul>`;

// Fragments below are trimmed from a real kns.cnki.net abstract page
// (2026-07-09 compat check) — the shape the modern混淆 `?v=` URL renders.
// Metadata comes from scraping this markup; the translator never calls a
// CNKI API (see cnki.ts header).
const BRIEF = `
<div class="brief">
  <div class="wx-tit">
    <h1> 面向下一代人工智能的三代模糊系统的发展与展望
      <span id="corr-video" class="type" style="display: none">附视频</span>
    </h1>
    <h3 class="author" id="authorpart">
      <span><a target="_blank" href="https://kns.cnki.net/kcms2/author/detail?v=abc">张三<sup>1,2</sup></a></span>
    </h3>
    <h3 class="author">
      <span><a target="_blank" href="https://kns.cnki.net/kcms2/organ/detail?v=abc">1.某大学</a></span>
    </h3>
  </div>
</div>
<input type="hidden" id="abstract_text" value="本文回顾了模糊系统的发展。">
<div class="row"><span class="rowtit">摘要：</span>
  <span id="ChDivSummary" name="ChDivSummary" class="abstract-text">本文回顾了模糊系统的发展。</span>
</div>
<div class="row"><span class="rowtit">关键词：</span>
  <p class="keywords">
    <a target="_blank" href="https://kns.cnki.net/kcms2/keyword/detail?v=abc">模糊系统;</a><a target="_blank" href="https://kns.cnki.net/kcms2/keyword/detail?v=def">人工智能;</a>
  </p>
</div>`;

// Modern source line: the middle anchor packs `年 ,卷 (期)` (year, volume,
// issue) — verified on kns.cnki.net, 2026-07.
const TOP_TIP = `
<div class="top-tip">
  <span>
    <a target="_blank" href="https://navi.cnki.net/knavi/detail?p=abc">自动化学报 .
    </a>
    <a target="_blank" href="https://navi.cnki.net/knavi/detail?p=def">
       2024 ,50 (03)
   </a>
    <span>: 456-468</span>
  </span>
</div>
<div class="other-versions"></div>`;

// The modern abstract page renames the hidden ref inputs
// (paramdbname → param-dbname, paramfilename → param-filename) and adds
// param-dbcode — verified on kns.cnki.net, 2026-07.
const PAGE = `<html><head><title>面向下一代人工智能的三代模糊系统的发展与展望 - 中国知网</title></head>
<body>
<input type="hidden" id="param-dbcode" value="CJFQ">
<input type="hidden" id="param-dbname" value="CJFDLAST2024">
<input type="hidden" id="param-filename" value="MOTO202401001">
${OPERATE_BTN}
${BRIEF}
${TOP_TIP}
</body></html>`;

const URL = "https://kns.cnki.net/kcms2/article/abstract?v=xxxx&uniplatform=NZKPT&language=CHS";

// Live CNKI thesis download block (西南大学博士论文 CDFD `*.nh`, kns.cnki.net
// 2026-09-02): the thesis template stamps EVERY download anchor `name="cajDown"`
// — PDF下载 / CAJ下载 / 章节下载 differ only by their `li` class, so the
// journal-style `pdfDown` name never appears on these pages.
const THESIS_OPERATE_BTN = `
<ul class="operate-btn">
  <div class="extend-btns">
    <li class="btn-cnki-ai"><a target="_blank" href="https://ai.cnki.net/trans?path=study&amp;cid=ABC&amp;mimetype=PDF&amp;srid=kcms"><i></i>CNKI AI阅读</a></li>
    <li class="btn-yb-reader"><a target="_blank" href="https://bar.cnki.net/bar/download/order?id=READER_ID"><i></i>原版阅读</a></li>
  </div>
  <div class="download-btns">
    <li class="btn-dlcaj"><a onclick="WriteKrsDownLog()" target="_blank" id="cajDown" name="cajDown" href="https://bar.cnki.net/bar/download/order?id=CAJ_ID"><i></i>CAJ下载</a></li>
    <li class="btn-dlpdf"><a onclick="WriteKrsDownLog()" target="_blank" id="cajDown" name="cajDown" href="https://bar.cnki.net/bar/download/order?id=PDF_ID_456"><i></i>PDF下载</a></li>
    <li class="btn-dlcaj"><a target="_blank" id="cajDown" name="cajDown" class="chapterDown" href="../downloaddetail/chapter?v=CHAPTER_TOKEN&amp;uniplatform=NZKPT"><i></i>章节下载</a></li>
    <li class="btn-grcg"><a target="_blank" href="https://au.cnki.net/author/workbench/myAchievement?platform=kns"><i></i>我是作者，免费下载</a></li>
  </div>
</ul>`;

const THESIS_URL =
  "https://webvpn.ccnu.edu.cn/https/77726476706e69737468656265737421fbf952d2243e635930068cb8/kcms2/article/abstract?v=tok&uniplatform=NZKPT&language=CHS";
// Metadata blocks shaped after the live thesis page (kns.cnki.net 2026-09-02):
// advisor row `p.supervisor`, 年期 row `bsdzqkcbxx`, institution organ anchor,
// DOI row — and NO `.top-tip` journal line.
const THESIS_PAGE = `<html><head><title>超重/肥胖成人的大脑动态特征：基于隐马尔科夫模型 - 中国知网</title></head>
<body>
<input type="hidden" id="param-filename" value="1025826382.nh">
<div class="wx-tit">
  <h1>超重/肥胖成人的大脑动态特征：基于隐马尔科夫模型</h1>
  <h3 class="author" id="authorpart"><span><a>韩金凤</a></span></h3>
  <h3 class="author"><span><a href="https://kns.cnki.net/kcms2/organ/detail?v=abc">西南大学</a></span></h3>
</div>
<div class="row"><span class="rowtit">摘要：</span><span id="ChDivSummary">本文研究超重/肥胖成人的大脑动态特征。</span></div>
<div class="row"><span class="rowtit">关键词：</span><p class="keywords"><a>超重/肥胖;</a><a>大脑状态;</a></p></div>
<li class="top-space"><span class="rowtit">DOI：</span><p>10.27684/d.cnki.gxndx.2025.000049</p></li>
<div class="row"><span class="rowtit">导师：</span><p class="supervisor">陈红</p></div>
<div class="row" id="bsdzqkcbxx"><span class="rowtit">博士电子期刊出版信息：</span><p class="year-qi"><span>年期：2025年第12期</span><span id="ndate">网络出版时间：2025-11-16—2025-12-15</span></p></div>
${THESIS_OPERATE_BTN}
</body></html>`;

// Conference page (CPFD): no top-tip — venue/year live in 会议名称/会议时间
// rows; the journal-style pdfDown anchor is present.
const CONFERENCE_URL =
  "https://kns.cnki.net/kcms2/article/abstract?v=conf&uniplatform=NZKPT&language=CHS";
const CONFERENCE_PAGE = `<html><head><title>深度学习在电气自动化生产故障预测中的应用 - 中国知网</title></head>
<body>
<input type="hidden" id="param-filename" value="ZBQK202608001151">
<div class="wx-tit">
  <h1>深度学习在电气自动化生产故障预测中的应用</h1>
  <h3 class="author" id="authorpart"><span><a>吕鑫</a></span></h3>
</div>
<div class="row"><span class="rowtit">摘要：</span><span id="ChDivSummary">本文提出一种故障预测方法。</span></div>
<div class="row"><span class="rowtit">关键词：</span><p class="keywords"><a>深度学习;</a><a>故障预测;</a></p></div>
<div class="row"><span class="rowtit">会议名称：</span><p>新质生产力驱动第二产业发展与招标采购创新论坛</p></div>
<div class="row"><span class="rowtit">会议时间：</span><p>2026年4月25日—27日</p></div>
<li class="top-space"><span class="rowtit">DOI：</span><p>10.26914/c.cnkihy.2026.048629</p></li>
${OPERATE_BTN}
</body></html>`;

// Newspaper page (CCND): top-tip names the paper, 报纸日期 row carries the date.
const NEWSPAPER_URL =
  "https://kns.cnki.net/kcms2/article/abstract?v=news&uniplatform=NZKPT&language=CHS";
const NEWSPAPER_PAGE = `<html><head><title>全力推动全民阅读与终身学习体系深度融合 - 中国知网</title></head>
<body>
<input type="hidden" id="param-filename" value="XWCB20260824T010">
<div class="wx-tit">
  <h1>全力推动全民阅读与终身学习体系深度融合</h1>
  <h3 class="author" id="authorpart"><span><a>张三</a></span></h3>
</div>
<div class="top-tip">
  <span>
    <a>中国新闻出版广电报 .</a>
    <a>中央级</a>
  </span>
</div>
<div class="row"><span class="rowtit">报纸日期：</span><p>2026-08-24</p></div>
<div class="row"><span class="rowtit">摘要：</span><span id="ChDivSummary">全民阅读……</span></div>
${OPERATE_BTN}
</body></html>`;

describe("extractCnkiRef", () => {
  it("reads dbname/filename from the modern param-dbname/param-filename inputs", () => {
    expect(extractCnkiRef({ url: URL, html: PAGE })).toEqual({
      dbname: "CJFDLAST2024",
      filename: "MOTO202401001",
    });
  });

  it("still reads the legacy paramdbname/paramfilename inputs", () => {
    const legacy = `<input type="hidden" id="paramdbname" value="CJFDLAST2024">
      <input type="hidden" id="paramfilename" value="MOTO202401001">`;
    expect(extractCnkiRef({ url: URL, html: legacy })).toEqual({
      dbname: "CJFDLAST2024",
      filename: "MOTO202401001",
    });
  });
});

describe("cnkiTranslator", () => {
  it("matches cnki.net hosts and detects article pages", () => {
    expect(cnkiTranslator.match(URL)).toBe(true);
    expect(cnkiTranslator.match("https://arxiv.org/abs/2401.00001")).toBe(false);
    expect(cnkiTranslator.detect({ url: URL, html: PAGE })).toBe(true);
  });

  it("scrapes metadata off the page and offers PDF-first, HTML-fallback attachments — no CNKI API call", async () => {
    const fetchText = vi.fn().mockRejectedValue(new Error("network"));
    const result = await cnkiTranslator.extract({ url: URL, html: PAGE, fetchText });

    // The translator is scrape-only: any network call would be a regression
    // (the old ShowExport endpoint is both dead and a legal surface to avoid).
    expect(fetchText).not.toHaveBeenCalled();

    expect(result.metadata.title).toBe("面向下一代人工智能的三代模糊系统的发展与展望");
    expect(result.resolverSource).toBe("plugin-dom-zh");
    expect(result.metadata.URL).toBeTruthy(); // URL identity for the work
    // Stable work key from the accession number, invariant across visits/proxies.
    expect(result.metadata.nativeId).toBe("cnki:moto202401001");

    expect(result.attachments.map((a) => ({ kind: a.kind, url: a.url }))).toEqual([
      { kind: "pdf", url: "https://bar.cnki.net/bar/download/order?id=PDF_ID_456" },
      { kind: "html", url: "https://bar.cnki.net/bar/download/order?id=HTML_ID_123" },
    ]);
    expect(result.allowGenericPdfDiscovery).toBe(false);
    expect(result.allowRawHtmlFallback).toBe(false);
  });

  it("works through a WebVPN proxy (host is not cnki.net)", async () => {    const vpnBase =
      "https://webvpn.ccnu.edu.cn/https/77726476706e69737468656265737421f2f653d2243e635930068cb8";
    const vpnPage =
      "https://webvpn.ccnu.edu.cn/https/77726476706e69737468656265737421f1fe0f9f293b611e700d9d/kcms2/article/abstract?v=abc&uniplatform=NZKPT";
    const html = `<html><head><title>三代模糊系统 - 中国知网</title></head><body>
      <input type="hidden" id="paramdbname" value="CJFDLAST2024">
      <input type="hidden" id="paramfilename" value="MOTO202401001">
      <ul class="operate-btn"><div class="download-btns">
        <li class="btn-dlpdf"><a onclick="eval(vpn_rewrite_js(...))" id="pdfDown" name="pdfDown" href="${vpnBase}/bar/download/order?id=PDF_VPN"><i></i>PDF下载</a></li>
      </div><div class="extend-btns">
        <li class="btn-html"><a target="_blank" href="${vpnBase}/bar/download/order?id=HTML_VPN">HTML阅读</a></li>
      </div></ul></body></html>`;

    expect(cnkiTranslator.detect({ url: vpnPage, html })).toBe(true);

    const fetchText = vi.fn().mockRejectedValue(new Error("network"));
    const result = await cnkiTranslator.extract({ url: vpnPage, html, fetchText });
    expect(fetchText).not.toHaveBeenCalled();

    // Download links are the already-proxied absolute URLs from the DOM.
    expect(result.attachments.map((a) => a.url)).toEqual([
      `${vpnBase}/bar/download/order?id=PDF_VPN`,
      `${vpnBase}/bar/download/order?id=HTML_VPN`,
    ]);
  });

  it("scrapes full metadata from the abstract page", async () => {
    const fetchText = vi.fn().mockRejectedValue(new Error("network"));
    const result = await cnkiTranslator.extract({ url: URL, html: PAGE, fetchText });
    expect(result.metadata.title).toBe(
      "面向下一代人工智能的三代模糊系统的发展与展望",
    );
    // Author names come from #authorpart, stripped of <sup> affiliation markers
    // — the sibling institution <h3> blocks are not mistaken for more authors.
    expect(result.metadata.author).toEqual([{ literal: "张三" }]);
    expect(result.metadata["container-title"]).toBe("自动化学报");
    expect(result.metadata.issued).toEqual({ "date-parts": [[2024]] });
    // 年 ,卷 (期) — volume (50) must not be dropped, GB/T [J] needs 卷(期):页.
    expect(result.metadata.volume).toBe("50");
    expect(result.metadata.issue).toBe("03");
    expect(result.metadata.page).toBe("456-468");
    expect(result.metadata.keywords).toEqual(["模糊系统", "人工智能"]);
    expect(result.metadata.abstract).toBe("本文回顾了模糊系统的发展。");
    expect(result.attachments[0]?.kind).toBe("pdf");
  });

  it("scrapes issue-only source lines that carry no volume", async () => {
    const noVolume = PAGE.replace("2024 ,50 (03)", "2015 (01)").replace(
      "<span>: 456-468</span>",
      "<span>: 1-10+157</span>",
    );
    const fetchText = vi.fn().mockRejectedValue(new Error("network"));
    const result = await cnkiTranslator.extract({ url: URL, html: noVolume, fetchText });
    expect(result.metadata.issued).toEqual({ "date-parts": [[2015]] });
    expect(result.metadata.volume).toBeUndefined();
    expect(result.metadata.issue).toBe("01");
    expect(result.metadata.page).toBe("1-10+157");
  });
});

describe("cnkiTranslator — 学位论文/会议/报纸 source lines", () => {
  it("detects a thesis page via its download block even without hidden inputs", () => {
    const noInputs = THESIS_PAGE.replace(
      /<input type="hidden" id="param-filename" value="1025826382.nh">/,
      "",
    );
    expect(cnkiTranslator.detect({ url: THESIS_URL, html: THESIS_PAGE })).toBe(true);
    expect(cnkiTranslator.detect({ url: THESIS_URL, html: noInputs })).toBe(true);
  });

  it("offers the PDF下载 anchor (named cajDown!) from the btn-dlpdf li", async () => {
    const fetchText = vi.fn().mockRejectedValue(new Error("network"));
    const result = await cnkiTranslator.extract({ url: THESIS_URL, html: THESIS_PAGE, fetchText });

    // dbname input is absent on thesis pages → scrape only, no network call.
    expect(fetchText).not.toHaveBeenCalled();
    expect(result.metadata.nativeId).toBe("cnki:1025826382.nh");

    // The whole-text PDF order link — NOT the CAJ link (not PDF bytes), NOT
    // the 章节下载 list page, NOT 原版阅读 (unverified byte format).
    expect(result.attachments.map((a) => ({ kind: a.kind, url: a.url }))).toEqual([
      { kind: "pdf", url: "https://bar.cnki.net/bar/download/order?id=PDF_ID_456" },
    ]);
  });

  it("never files the 章节下载 page as the whole-text PDF", async () => {
    const chapterOnly = THESIS_PAGE.replace(
      /https:\/\/bar\.cnki\.net\/bar\/download\/order\?id=PDF_ID_456/,
      "../downloaddetail/chapter?v=CHAPTER_TOKEN&uniplatform=NZKPT",
    );
    const fetchText = vi.fn().mockRejectedValue(new Error("network"));
    const result = await cnkiTranslator.extract({ url: THESIS_URL, html: chapterOnly, fetchText });
    expect(result.attachments).toEqual([]);
  });

  it("scrapes thesis metadata: type, institution publisher, 年期 year, DOI", async () => {
    const fetchText = vi.fn().mockRejectedValue(new Error("network"));
    const result = await cnkiTranslator.extract({ url: THESIS_URL, html: THESIS_PAGE, fetchText });
    const meta = result.metadata;

    // GB/T [D] needs 学位授予单位 as publisher — never a journal container-title.
    expect(meta.type).toBe("thesis");
    expect(meta.publisher).toBe("西南大学");
    expect(meta["container-title"]).toBeUndefined();
    expect(meta.issued).toEqual({ "date-parts": [[2025]] });
    expect(meta.DOI).toBe("10.27684/d.cnki.gxndx.2025.000049");
    expect(meta.title).toBe("超重/肥胖成人的大脑动态特征：基于隐马尔科夫模型");
    expect(meta.author).toEqual([{ literal: "韩金凤" }]);
  });

  // WebVPN-proxied thesis page variants seen in the wild (2026-09): no
  // 电子期刊出版信息 row, and/or the author rendered as plain text without an
  // anchor. Either gap alone strands the entry as 题录待补全.
  it("falls back to the DOI year segment when the 电子期刊出版信息 row is absent", async () => {
    const noYearRow = THESIS_PAGE.replace(
      /<div class="row" id="bsdzqkcbxx">[\s\S]*?<\/div>\s*/,
      "",
    );
    expect(noYearRow).toContain("10.27684/d.cnki.gxndx.2025.000049");
    const fetchText = vi.fn().mockRejectedValue(new Error("network"));
    const result = await cnkiTranslator.extract({ url: THESIS_URL, html: noYearRow, fetchText });
    expect(result.metadata.issued).toEqual({ "date-parts": [[2025]] });
  });

  it("scrapes an anchor-less authorpart (plain-text author)", async () => {
    const plainAuthor = THESIS_PAGE.replace(
      '<h3 class="author" id="authorpart"><span><a>韩金凤</a></span></h3>',
      '<h3 class="author" id="authorpart"><span>韩金凤</span></h3>',
    );
    const fetchText = vi.fn().mockRejectedValue(new Error("network"));
    const result = await cnkiTranslator.extract({ url: THESIS_URL, html: plainAuthor, fetchText });
    expect(result.metadata.author).toEqual([{ literal: "韩金凤" }]);
  });

  it("scrapes conference metadata: venue from 会议名称, year from 会议时间", async () => {
    const fetchText = vi.fn().mockRejectedValue(new Error("network"));
    const result = await cnkiTranslator.extract({
      url: CONFERENCE_URL,
      html: CONFERENCE_PAGE,
      fetchText,
    });
    const meta = result.metadata;

    expect(meta.type).toBe("paper-conference");
    expect(meta["container-title"]).toBe("新质生产力驱动第二产业发展与招标采购创新论坛");
    expect(meta.issued).toEqual({ "date-parts": [[2026]] });
    expect(meta.DOI).toBe("10.26914/c.cnkihy.2026.048629");
    expect(meta.nativeId).toBe("cnki:zbqk202608001151");
  });

  it("scrapes newspaper metadata: type + year from 报纸日期, venue from top-tip", async () => {
    const fetchText = vi.fn().mockRejectedValue(new Error("network"));
    const result = await cnkiTranslator.extract({
      url: NEWSPAPER_URL,
      html: NEWSPAPER_PAGE,
      fetchText,
    });
    const meta = result.metadata;

    expect(meta.type).toBe("article-newspaper");
    expect(meta["container-title"]).toBe("中国新闻出版广电报");
    expect(meta.issued).toEqual({ "date-parts": [[2026]] });
  });

  it("falls back to 在线公开时间 for the year on 网络首发 journal pages", async () => {
    const onlineFirst = PAGE.replace("2024 ,50 (03)", "").replace(
      "<div class=\"other-versions\"></div>",
      "<div class=\"other-versions\"></div>" +
        `<li class="top-space"><span class="rowtit">在线公开时间：</span><p>2026-03-12（知网平台在线公开时间，不代表文献的发表时间）</p></li>`,
    );
    const fetchText = vi.fn().mockRejectedValue(new Error("network"));
    const result = await cnkiTranslator.extract({
      url: URL,
      html: onlineFirst,
      fetchText,
    });
    expect(result.metadata["container-title"]).toBe("自动化学报");
    expect(result.metadata.issued).toEqual({ "date-parts": [[2026]] });
    expect(result.metadata.type).toBe("article-journal");
  });
});

describe("cnkiTranslator.detect — entitlement-free pages", () => {
  // Without an institutional entitlement CNKI renders no PDF/HTML download
  // buttons, so the hidden inputs are the only signal left. Missing the newer
  // `param-filename` spelling dropped these pages to the generic translator,
  // which scrapes a title and no author/year/venue — no nativeId, so the work
  // keyed on the mutable landing-page URL and the paper duplicated on re-import.
  const bare = (inputId: string) =>
    `<html><head><title>迈向第三代人工智能 - 中国知网</title></head><body>
      <input type="hidden" id="${inputId}" value="PZKX202009002"></body></html>`;

  it("detects a page carrying only the modern param-filename input", () => {
    expect(cnkiTranslator.detect({ url: URL, html: bare("param-filename") })).toBe(true);
  });

  it("detects a page carrying only the legacy paramfilename input", () => {
    expect(cnkiTranslator.detect({ url: URL, html: bare("paramfilename") })).toBe(true);
  });

  it("detects a page carrying only a dbname input", () => {
    expect(cnkiTranslator.detect({ url: URL, html: bare("param-dbname") })).toBe(true);
    expect(cnkiTranslator.detect({ url: URL, html: bare("paramdbname") })).toBe(true);
  });

  it("still refuses a page with no CNKI signal at all", () => {
    expect(
      cnkiTranslator.detect({ url: URL, html: "<html><body>随便一个网页</body></html>" }),
    ).toBe(false);
  });

  it("keys the work on the accession number even with no download buttons", async () => {
    // The dedup payoff: a webvpn/logged-out capture of 迈向第三代人工智能 now yields
    // the same nativeId as a direct kns.cnki.net capture, so both land on one work.
    const vpnUrl =
      "https://webvpn.ccnu.edu.cn/https/77726476706e69737468656265737421fbf952d2243e635930068cb8/kcms2/article/abstract?v=tok&uniplatform=NZKPT";
    const fetchText = vi.fn().mockRejectedValue(new Error("network"));
    const result = await cnkiTranslator.extract({
      url: vpnUrl,
      html: bare("param-filename"),
      fetchText,
    });

    expect(result.metadata.nativeId).toBe("cnki:pzkx202009002");
    expect(result.attachments).toEqual([]); // no full text available — metadata-only
    expect(result.allowRawHtmlFallback).toBe(false); // never snapshot the landing page
  });
});
