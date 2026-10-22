import { describe, expect, it } from "vitest";

import { ncpssdTranslator } from "./ncpssd.js";

const URL =
  "https://www.ncpssd.cn/Literature/articleinfo?id=KYGL2023003015&type=journalArticle&typename=%E4%B8%AD%E6%96%87%E6%9C%9F%E5%88%8A%E6%96%87%E7%AB%A0";

// Lifted verbatim from the 2026-07-10 capture of KYGL2023003015, keeping the
// full-width label colons (作　　者：) and the `[1]` affiliation markers.
const RECORD = `
<input type="hidden" id="ftl_urlId" value="KYGL2023003015">
<input type="hidden" id="ftl_urlType" value="journalArticle">
<input type="hidden" id="ftl_urlTypename" value="中文期刊文章">
<h1 id="h2_title_c" class="H2Style">先前经验对新产品开发绩效的影响机制<i>中文期刊文章</i></h1>
<h3 id="h3_title_e" class="color-gray">Influence mechanism of prior experiences on new product development performance</h3>
<p id="p_creator" class="literature"><strong>作　　者：</strong>李艳妮[1];徐兰香[2]<br>Li Yanni[1];Xu Lanxiang[2]</p>
<p id="p_media" class="literature"><strong>出 版 物：</strong><a href="/journal/secure/details?params=K3o0" class="chuchu_style">《科研管理》 (Science Research Management)</a></p>
<p id="p_year" class="literature"><strong>年  卷  期：</strong>2023年第044卷第3期</p>
<p id="p_remark" class="literature"><strong>摘　　要：</strong>创业者先前经验是影响新产品开发绩效的重要因素。</p>
<p id="p_remarke" class="literature">With the increasingly fierce competition in the market.</p>
<p id="p_page" class="literature"><strong>页　　码：</strong>142-150页</p>
<p id="p_keyword" class="literature"><strong>主  题  词：</strong><font style="margin-right: 5px;">先前经验</font><font style="margin-right: 5px;">资源保存启发式</font><br> prior experience ; resource-induced coping heuristic</p>
`;

async function extract(html: string, url = URL) {
  return ncpssdTranslator.extract({ url, html, fetchText: async () => "" });
}

describe("ncpssdTranslator", () => {
  it("detects an article by its title id, not by host", () => {
    expect(ncpssdTranslator.detect({ url: "https://webvpn.x.edu.cn/y", html: RECORD })).toBe(true);
  });

  it("rejects the pre-render shell, where the title element is empty", () => {
    const shell = `<h1 id="h2_title_c" class="H2Style"></h1><input type="hidden" id="ftl_urlId" value="">`;
    expect(ncpssdTranslator.detect({ url: URL, html: shell })).toBe(false);
  });

  it("rejects a search page that has no title element at all", () => {
    expect(ncpssdTranslator.detect({ url: URL, html: `<div id="p_qk">全部期刊</div>` })).toBe(false);
  });

  it("strips the <i> document-type badge out of the title", async () => {
    const r = await extract(RECORD);
    expect(r.metadata.title).toBe("先前经验对新产品开发绩效的影响机制");
  });

  it("keeps the Chinese author line and drops its affiliation markers", async () => {
    const r = await extract(RECORD);
    expect(r.metadata.author).toEqual([{ literal: "李艳妮" }, { literal: "徐兰香" }]);
  });

  it("unwraps the journal name from 《》, dropping the English rendering", async () => {
    const r = await extract(RECORD);
    expect(r.metadata["container-title"]).toBe("科研管理");
  });

  it("reads 年/卷/期/页, dropping the zero padding on the volume", async () => {
    const r = await extract(RECORD);
    expect(r.metadata.issued).toEqual({ "date-parts": [[2023]] });
    expect(r.metadata.volume).toBe("44");
    expect(r.metadata.issue).toBe("3");
    expect(r.metadata.page).toBe("142-150");
  });

  it("takes keywords from the <font>s, not the English tail after the <br>", async () => {
    const r = await extract(RECORD);
    expect(r.metadata.keywords).toEqual(["先前经验", "资源保存启发式"]);
  });

  it("picks the abstract that matches the record's own language", async () => {
    const r = await extract(RECORD);
    expect(r.metadata.abstract).toBe("创业者先前经验是影响新产品开发绩效的重要因素。");
    expect(r.metadata.language).toBe("zh");
    expect(r.resolverSource).toBe("plugin-dom-zh");
  });

  // ncpssd shows no DOI on any record, and its download link is a bare
  // <a id="a_down"> whose href is filled in by an authenticated click handler.
  it("offers no identifier, no attachment and no fallback", async () => {
    const r = await extract(RECORD);
    expect(r.identifier).toBeNull();
    expect(r.attachments).toEqual([]);
    expect(r.allowGenericPdfDiscovery).toBe(false);
    expect(r.allowRawHtmlFallback).toBe(false);
  });

  // On a 外文期刊文章 the record's own language is English, so `p_remarke`'s
  // id suffix no longer marks "the translation".
  it("switches to the English author line and abstract on a foreign-language record", async () => {
    const foreign = `
      <input type="hidden" id="ftl_urlType" value="journalArticle">
      <input type="hidden" id="ftl_urlTypename" value="外文期刊文章">
      <h1 id="h2_title_c" class="H2Style">Prior experience and new product development<i>外文期刊文章</i></h1>
      <p id="p_creator"><strong>作　　者：</strong>Li, Yanni[1];Xu, Lanxiang[2]</p>
      <p id="p_remark">Prior experience shapes new product development performance.</p>
      <p id="p_remarke">先前经验影响新产品开发绩效。</p>
    `;
    const r = await extract(foreign);
    expect(r.metadata.language).toBeUndefined();
    expect(r.metadata.author).toEqual([
      { family: "Li", given: "Yanni" },
      { family: "Xu", given: "Lanxiang" },
    ]);
    expect(r.metadata.abstract).toBe("Prior experience shapes new product development performance.");
    expect(r.resolverSource).toBe("plugin-dom-en");
  });

  it("maps the ncpssd document type onto a CSL type", async () => {
    const thesis = `
      <input type="hidden" id="ftl_urlType" value="thesis">
      <h1 id="h2_title_c">先前经验研究<i>学位论文</i></h1>
    `;
    expect((await extract(thesis)).metadata.type).toBe("thesis");
  });

  it("survives a sparse record with no 页码 and no keywords", async () => {
    const sparse = `<h1 id="h2_title_c">短评<i>中文期刊文章</i></h1><p id="p_year"><strong>年  卷  期：</strong>2019年第3期</p>`;
    const r = await extract(sparse);
    expect(r.metadata.title).toBe("短评");
    expect(r.metadata.issue).toBe("3");
    expect(r.metadata.volume).toBeUndefined();
    expect(r.metadata.page).toBeUndefined();
    expect(r.metadata.keywords).toBeUndefined();
  });
});
