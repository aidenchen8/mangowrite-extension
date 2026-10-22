import { describe, expect, it } from "vitest";

import { pickTranslator } from "./registry.js";

const CNKI_PAGE = `<html><body>
  <input id="paramfilename" value="X202401001">
  <li class="btn-dlpdf"><a id="pdfDown" name="pdfDown" href="https://bar.cnki.net/bar/download/order?id=X"></a></li>
</body></html>`;

const SCHOLARLY_PAGE = `<html><head>
  <meta name="citation_title" content="Attention Is All You Need">
  <meta name="citation_pdf_url" content="https://example.org/paper.pdf">
</head><body>…</body></html>`;

const PLAIN_PAGE = `<html><head><title>某新闻门户 - 今日头条</title>
  <meta property="og:title" content="今天发生了什么"></head><body><p>普通网页</p></body></html>`;

describe("pickTranslator (content-driven recognition)", () => {
  it("recognizes a CNKI page by DOM markers regardless of host (WebVPN)", () => {
    const t = pickTranslator({
      url: "https://webvpn.ccnu.edu.cn/https/abc/kcms2/article/abstract?v=1",
      html: CNKI_PAGE,
    });
    expect(t?.id).toBe("cnki");
  });

  it("recognizes a generic scholarly page via citation meta", () => {
    const t = pickTranslator({ url: "https://example.org/a", html: SCHOLARLY_PAGE });
    expect(t?.id).toBe("generic");
  });

  it("recognizes a scholarly page whose citation metas are content-first and unquoted (ACL Anthology)", () => {
    const t = pickTranslator({
      url: "https://aclanthology.org/N19-1423/",
      html: `<html><head>
        <meta content="BERT: Pre-training of Deep Bidirectional Transformers" name=citation_title>
        <meta content="https://aclanthology.org/N19-1423.pdf" name=citation_pdf_url>
      </head><body>…</body></html>`,
    });
    expect(t?.id).toBe("generic");
  });

  it("returns null for a plain web page (no paper recognized)", () => {
    const t = pickTranslator({ url: "https://news.example.com/x", html: PLAIN_PAGE });
    expect(t).toBeNull();
  });

  // News pages carry NewsArticle JSON-LD (often only after client hydration)
  // and og:type=article — neither is a scholarly signal. Recognizing them as
  // papers files a metadata-only entry with no attainable full text; they must
  // fall through to the webpage snapshot path instead. (10jqka news incident.)
  it("returns null for a news article page (NewsArticle JSON-LD + og:type=article)", () => {
    const NEWS_PAGE = `<html><head><title>未来10天华南或成降水最多区域</title>
      <meta property="og:type" content="article" />
      <meta property="og:title" content="未来10天华南或成降水最多区域" />
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"未来10天华南或成降水最多区域"}</script>
      </head><body><p>正文</p></body></html>`;
    const t = pickTranslator({ url: "https://news.10jqka.com.cn/20260815/c678983546.shtml", html: NEWS_PAGE });
    expect(t).toBeNull();
  });

  it("recognizes a generic scholarly page via ScholarlyArticle JSON-LD", () => {
    const SCHOLARLY_JSONLD_PAGE = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"ScholarlyArticle","headline":"A Study"}</script>
      </head><body>…</body></html>`;
    const t = pickTranslator({ url: "https://journal.example.org/a", html: SCHOLARLY_JSONLD_PAGE });
    expect(t?.id).toBe("generic");
  });

  // Xplore's only meta tag is a useless og:title, so generic would reject it.
  it("recognizes an IEEE Xplore page by its embedded metadata assignment", () => {
    const t = pickTranslator({
      url: "https://ieeexplore.ieee.org/document/9156697",
      html: `<html><head><meta property="og:title" content="IEEE Xplore"></head>
        <body><script>xplGlobal.document.metadata = {"title":"ECA-Net","doi":"10.1109/x"};</script></body></html>`,
    });
    expect(t?.id).toBe("ieee");
  });

  // DSpace 7 CSR shells carry zero meta tags and no JSON-LD — generic has
  // nothing to see (GSU/Arizona, 2026-09 实测).
  it("recognizes a DSpace 7 CSR item shell that generic can't see", () => {
    const t = pickTranslator({
      url: "https://scholarworks.gsu.edu/items/71dfb819-4230-479c-a862-eafe9cde787d",
      html: `<html><head><base href="/"><title>DSpace</title></head>
        <body><ds-app></ds-app><script src="main.js" type="module"></script></body></html>`,
    });
    expect(t?.id).toBe("dspace");
  });

  // WoS ships a single `viewport` meta — generic sees no scholarly signal at all.
  it("recognizes a Web of Science full record by its data-ta hook", () => {
    const t = pickTranslator({
      url: "https://webofscience.clarivate.cn/wos/woscc/full-record/WOS:000571285200009",
      html: `<html><head><meta name="viewport" content="width=device-width"></head>
        <body><app-wos><h2 data-ta="FullRTa-fullRecordtitle-0">Array programming with NumPy</h2></app-wos></body></html>`,
    });
    expect(t?.id).toBe("wos");
  });

  // ncpssd's only `author` meta names the library that runs the site. Were
  // generic to win here, it would file 中国社会科学院图书馆 as the paper's author.
  it("recognizes an ncpssd article before generic can claim its site-wide metas", () => {
    const t = pickTranslator({
      url: "https://www.ncpssd.cn/Literature/articleinfo?id=KYGL2023003015",
      html: `<html><head><title>国家哲学社会科学文献中心</title>
        <meta name="author" content="中国社会科学院图书馆"></head>
        <body><h1 id="h2_title_c">先前经验对新产品开发绩效的影响机制<i>中文期刊文章</i></h1></body></html>`,
    });
    expect(t?.id).toBe("ncpssd");
  });

  // GitHub blob PDF pages: og:type=object, no citation meta, PDF preview is a
  // client-side viewscreen URL — generic and embedded-pdf both miss them.
  it("recognizes a GitHub blob PDF page", () => {
    const t = pickTranslator({
      url: "https://github.com/cordiverse/paper/blob/main/paper.pdf",
      html: `<html><head><meta property="og:type" content="object" /></head>
        <body><script type="application/json">{"payload":{"blob":{"rawBlobUrl":"https://github.com/cordiverse/paper/raw/refs/heads/main/paper.pdf"}}}</script></body></html>`,
    });
    expect(t?.id).toBe("hosted-pdf");
  });

  // Baidu 学术 renders client-side: two metas, and a Nuxt payload that says so.
  it("recognizes a 百度学术 detail page by its record class hooks", () => {
    const t = pickTranslator({
      url: "https://xueshu.baidu.com/ndscholar/browse/detail?paperid=787e6995",
      html: `<html><head><meta charset="utf-8"><title>深度学习研究进展 - 百度学术</title></head>
        <body><div class="detail-wrap"><div class="title-wrap"><a class="title"><span>深度学习研究进展</span></a></div>
        <span class="paper-type paper-type-1">期刊</span></div></body></html>`,
    });
    expect(t?.id).toBe("baidu-xueshu");
  });

  // DSpace 7 站点（GSU、Arizona）的 citation_pdf_url 指向 /bitstreams/<uuid>/
  // download，部分部署从该路由只回 SPA 壳——通用 translator 必须把 REST
  // content 端点排成第二顺位附件，第一顺位失败时才有真文件可拿。
  it("queues the DSpace REST content endpoint as a fallback attachment", async () => {
    const DSPACE_PAGE = `<html><head>
      <meta name="citation_title" content="A Port and Its Hinterland">
      <meta name="citation_author" content="Inal, Onur">
      <meta name="citation_pdf_url" content="https://repository.arizona.edu/bitstreams/e22c081e-db31-4eb2-beb0-d476033fc852/download">
    </head><body>…</body></html>`;
    const translator = pickTranslator({
      url: "https://repository.arizona.edu/items/0cadb8d5-9ee4-4941-afbc-7deafdb13346",
      html: DSPACE_PAGE,
    });
    expect(translator?.id).toBe("generic");
    const result = await translator!.extract({
      url: "https://repository.arizona.edu/items/0cadb8d5-9ee4-4941-afbc-7deafdb13346",
      html: DSPACE_PAGE,
      fetchText: async () => "",
    });
    expect(result.attachments.map((a) => a.url)).toEqual([
      "https://repository.arizona.edu/bitstreams/e22c081e-db31-4eb2-beb0-d476033fc852/download",
      "https://repository.arizona.edu/server/api/core/bitstreams/e22c081e-db31-4eb2-beb0-d476033fc852/content",
    ]);
  });
});
