import { describe, expect, it } from "vitest";

import { baiduXueshuTranslator } from "./baidu-xueshu.js";

const URL = "https://xueshu.baidu.com/ndscholar/browse/detail?paperid=787e6995";

/**
 * Lifted from the 2026-07-10 capture of paperid=787e6995…, with the scoped-style
 * hashes deliberately changed (`data-v-deadbeef`) to prove we never key on them:
 * Baidu regenerates those on every CSS edit.
 *
 * A recommendation card follows the record and reuses `title-wrap` / `source`.
 */
const PAGE = `
<div data-v-deadbeef="" class="detail-wrap">
  <div data-v-deadbeef="" class="title-wrap"><a data-v-deadbeef="" href="https://wenku.baidu.com/view/5f2d.html" class="title"><span data-v-deadbeef="">深度学习研究进展</span></a><!----></div>
  <div data-v-deadbeef="" class="tips">
    <span data-v-deadbeef="" class="paper-type paper-type-1">期刊</span>
    <a data-v-deadbeef="" href="/usercenter/data/journal?wd=journaluri" class="source">计算机应用研究</a>
    <div data-v-deadbeef="" class="views"> 阅读量：25114</div>
  </div>
  <div data-v-deadbeef="" class="info-wrap">
    <div data-v-deadbeef="" class="item"><div data-v-deadbeef="" class="label">作者：</div><div data-v-deadbeef="" class="atomic-line-collapse detail"><div class="atomic-line-collapse-container"><div data-v-deadbeef="" class="detail-author"><div class="author-wrap"><a href="//xueshu.baidu.com/usercenter/data/author?wd=a" class="detail-link"><span>刘建伟</span></a><span>、</span></div><div class="author-wrap"><a href="//xueshu.baidu.com/usercenter/data/author?wd=b" class="detail-link"><span>刘媛</span></a><!----></div></div></div><div class="fold-btn"><span class="text">展开</span><!----></div></div></div>
    <div data-v-deadbeef="" class="item"><div data-v-deadbeef="" class="label">摘要：</div><div data-v-deadbeef="" class="atomic-line-collapse detail"><div class="atomic-line-collapse-container"><div data-v-deadbeef="">鉴于深度学习的重要性,综述了深度学习的研究进展。</div></div><div class="fold-btn"><span class="text">展开</span><!----></div></div></div>
    <div data-v-deadbeef="" class="item"><div data-v-deadbeef="" class="label">关键词：</div><div data-v-deadbeef="" class="atomic-line-collapse detail"><div class="atomic-line-collapse-container"><div><a class="detail-link">深度学习；神经网络；模型</a></div></div><div class="fold-btn"><span class="text">展开</span><!----></div></div></div>
    <div data-v-deadbeef="" class="item"><div data-v-deadbeef="" class="label">DOI：</div><div data-v-deadbeef="" class="detail" fold-text="展开,"><div data-v-deadbeef="">10.3969/J.ISSN.1001-3695.2014.07.001</div></div></div>
    <div data-v-deadbeef="" class="item"><div data-v-deadbeef="" class="label">被引量：</div><div data-v-deadbeef="" class="detail"><div><a class="detail-link">681</a></div></div></div>
    <div data-v-deadbeef="" class="item"><div data-v-deadbeef="" class="label">年份：</div><div data-v-deadbeef="" class="detail"><div>2014</div></div></div>
  </div>
</div>
<div class="recommend">
  <div class="title-wrap"><a class="title"><span>教育领域深度学习研究进展与前瞻</span></a></div>
  <a class="source">电化教育研究</a>
</div>
`;

async function extract(html: string, url = URL) {
  return baiduXueshuTranslator.extract({ url, html, fetchText: async () => "" });
}

describe("baiduXueshuTranslator", () => {
  it("detects a detail page by three co-occurring class hooks", () => {
    expect(baiduXueshuTranslator.detect({ url: URL, html: PAGE })).toBe(true);
  });

  it("does not claim a search-results page, which has title-wrap but no record", () => {
    const results = `<div class="title-wrap"><a class="title"><span>深度学习</span></a></div>`;
    expect(baiduXueshuTranslator.detect({ url: URL, html: results })).toBe(false);
  });

  it("reads the record, not the recommendation card below it", async () => {
    const r = await extract(PAGE);
    expect(r.metadata.title).toBe("深度学习研究进展");
    expect(r.metadata["container-title"]).toBe("计算机应用研究");
  });

  it("takes each author from its own link, dropping the 、 separators", async () => {
    const r = await extract(PAGE);
    expect(r.metadata.author).toEqual([{ literal: "刘建伟" }, { literal: "刘媛" }]);
  });

  // The "展开" fold button is a *child* of the value container.
  it("keeps the fold button's label out of the abstract", async () => {
    const r = await extract(PAGE);
    expect(r.metadata.abstract).toBe("鉴于深度学习的重要性,综述了深度学习的研究进展。");
    expect(r.metadata.abstract).not.toContain("展开");
  });

  it("splits the single keyword anchor on the full-width semicolons", async () => {
    const r = await extract(PAGE);
    expect(r.metadata.keywords).toEqual(["深度学习", "神经网络", "模型"]);
  });

  it("finds each field by its Chinese label, not by row position", async () => {
    const r = await extract(PAGE);
    expect(r.metadata.DOI).toBe("10.3969/j.issn.1001-3695.2014.07.001");
    expect(r.metadata.issued).toEqual({ "date-parts": [[2014]] });
    // 被引量 sits between DOI and 年份 and must not be mistaken for either.
    expect(r.metadata.issued).not.toEqual({ "date-parts": [[681]] });
  });

  it("emits no attachment: Baidu links out to wherever it found the text", async () => {
    const r = await extract(PAGE);
    expect(r.attachments).toEqual([]);
    expect(r.allowGenericPdfDiscovery).toBe(false);
    expect(r.allowRawHtmlFallback).toBe(false);
    expect(r.resolverSource).toBe("plugin-dom-zh");
  });

  it("survives a record with no DOI row", async () => {
    const noDoi = PAGE.replace(/<div [^>]*class="item"><div [^>]*class="label">DOI：[\s\S]*?<\/div><\/div><\/div>/, "");
    const r = await extract(noDoi);
    expect(r.metadata.DOI).toBeUndefined();
    expect(r.identifier).toBeNull();
    expect(r.metadata.issued).toEqual({ "date-parts": [[2014]] });
  });

  it("maps the 学位论文 badge onto a thesis", async () => {
    const thesis = PAGE.replace('class="paper-type paper-type-1">期刊', 'class="paper-type paper-type-3">学位论文');
    expect((await extract(thesis)).metadata.type).toBe("thesis");
  });

  it("leaves an English record untagged and routes it to the en track", async () => {
    const english = PAGE.replace("深度学习研究进展", "Deep Learning Advances").replace(
      "计算机应用研究",
      "Computer Applications",
    );
    const r = await extract(english);
    expect(r.metadata.language).toBeUndefined();
    expect(r.resolverSource).toBe("plugin-dom-en");
  });
});
