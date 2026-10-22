import { describe, expect, it } from "vitest";

import {
  extractArxivId,
  extractEnglishMetadata,
  extractMetadata,
  extractPdfUrl,
} from "./metadata-extract.js";

const ENGLISH_HTML = `
<meta name="citation_title" content="Attention Is All You Need">
<meta name="citation_author" content="Vaswani, Ashish">
<meta name="citation_author" content="Shazeer, Noam">
<meta name="citation_journal_title" content="NeurIPS">
<meta name="citation_volume" content="30">
<meta name="citation_firstpage" content="5998">
<meta name="citation_lastpage" content="6008">
<meta name="citation_doi" content="10.5555/3295222.3295349">
<meta name="citation_publication_date" content="2017/12/01">
<meta name="citation_pdf_url" content="https://x.com/paper.pdf">
`;

const CNKI_HTML = `
<title>基于深度学习的图像识别方法研究 - 中国知网</title>
<meta property="og:title" content="基于深度学习的图像识别方法研究">
<div class="rowtit">计算机学报, 2021, 44(3): 156-168</div>
`;

describe("extractEnglishMetadata", () => {
  it("reads Highwire citation_* into CSL", () => {
    const m = extractEnglishMetadata(ENGLISH_HTML);
    expect(m.title).toBe("Attention Is All You Need");
    expect(m.author).toHaveLength(2);
    expect(m.author?.[0]).toEqual({ family: "Vaswani", given: "Ashish" });
    expect(m["container-title"]).toBe("NeurIPS");
    expect(m.volume).toBe("30");
    expect(m.page).toBe("5998-6008");
    expect(m.DOI).toBe("10.5555/3295222.3295349");
    expect(m.issued).toEqual({ "date-parts": [[2017]] });
  });

  it("extracts and normalizes ISSN from citation_issn / prism.issn", () => {
    const html = `
      <meta name="citation_title" content="An OA paper">
      <meta name="citation_issn" content="2076-3417">
      <meta name="prism.issn" content="20763417">
      <meta name="prism.eIssn" content="1234-5678">
    `;
    const m = extractEnglishMetadata(html);
    // 2076-3417 appears twice (raw + compact) → de-duped; both forms canonicalized.
    expect(m.ISSN).toEqual(["2076-3417", "1234-5678"]);
  });
});

describe("extractPdfUrl", () => {
  it("reads citation_pdf_url", () => {
    expect(extractPdfUrl(ENGLISH_HTML)).toBe("https://x.com/paper.pdf");
  });

  it("reads content-first, unquoted-name meta tags (ACL Anthology)", () => {
    expect(
      extractPdfUrl(`
        <meta content="https://aclanthology.org/N19-1423.pdf" name=citation_pdf_url>
      `),
    ).toBe("https://aclanthology.org/N19-1423.pdf");
  });
});

describe("extractMetadata router", () => {
  it("routes an English publisher page to the en track", () => {
    const r = extractMetadata({ url: "https://link.springer.com/article/xyz", html: ENGLISH_HTML });
    expect(r.track).toBe("en");
    expect(r.metadata.title).toBe("Attention Is All You Need");
  });

  it("routes a CNKI page to the zh track and scrapes 卷期页", () => {
    const r = extractMetadata({ url: "https://kns.cnki.net/kcms/detail/x.html", html: CNKI_HTML });
    expect(r.track).toBe("zh");
    expect(r.publisher).toBe("cnki");
    expect(r.metadata.language).toBe("zh");
    expect(r.metadata.title).toContain("图像识别");
    expect(r.metadata.volume).toBe("44");
    expect(r.metadata.issue).toBe("3");
    expect(r.metadata.page).toBe("156-168");
  });

  it("routes a non-publisher Chinese page to zh by CJK title", () => {
    const r = extractMetadata({
      url: "https://blog.example.com/post",
      html: `<meta property="og:title" content="人工智能与教育的未来">`,
    });
    expect(r.track).toBe("zh");
  });
});

// Regressions from the 2026-07-10 real-site compat sweep. Each fixture is a
// minimal fragment lifted from the live page named in the describe block.
describe("extractEnglishMetadata — real-site shapes", () => {
  it("reads ACL Anthology's content-first unquoted metas (title/authors/year)", () => {
    const r = extractEnglishMetadata(`
      <meta content="BERT: Pre-training of Deep Bidirectional Transformers" name=citation_title>
      <meta content="Devlin, Jacob" name=citation_author>
      <meta content="Chang, Ming-Wei" name=citation_author>
      <meta content="2019/06" name=citation_publication_date>
    `);
    expect(r.title).toBe("BERT: Pre-training of Deep Bidirectional Transformers");
    expect(r.author).toHaveLength(2);
    expect(r.author?.[0]).toEqual({ family: "Devlin", given: "Jacob" });
    expect(r.issued).toEqual({ "date-parts": [[2019]] });
  });

  it("decodes HTML entities in meta content (ScienceDirect, SpringerLink)", () => {
    const r = extractEnglishMetadata(`
      <meta name="citation_title" content="Paying for open access">
      <meta name="citation_journal_title" content="Journal of Economic Behavior &amp; Organization">
    `);
    expect(r["container-title"]).toBe("Journal of Economic Behavior & Organization");
  });

  it("reads PubMed's semicolon-delimited citation_authors and US-ordered date", () => {
    const r = extractEnglishMetadata(`
      <meta name="citation_title" content="Climatological influences on major storm events">
      <meta name="citation_authors" content="Pouzet P;Maanan M;">
      <meta name="citation_date" content="07/21/2020">
    `);
    expect(r.author).toEqual([
      { family: "Pouzet", given: "P" },
      { family: "Maanan", given: "M" },
    ]);
    expect(r.issued).toEqual({ "date-parts": [[2020]] });
  });

  it("picks the DOI out of ACM's two dc.Identifier tags, not the acm-id", () => {
    const r = extractEnglishMetadata(`
      <meta name="dc.Identifier" scheme="acm-id" content="3616631">
      <meta name="dc.Identifier" scheme="doi" content="10.1145/3576915.3616631">
    `);
    expect(r.DOI).toBe("10.1145/3576915.3616631");
  });

  it("de-dupes an author emitted as both name= and property= (Semantic Scholar)", () => {
    const r = extractEnglishMetadata(`
      <meta name="citation_author" content="Ashish Vaswani">
      <meta name="citation_author" content="I. Polosukhin">
      <meta property="citation_author" content="I. Polosukhin">
    `);
    expect(r.author).toHaveLength(2);
  });

  it("treats a trailing initial as the given name, not the family (Europe PMC)", () => {
    const r = extractEnglishMetadata(`<meta name="citation_author" content="Kariya KI">`);
    expect(r.author).toEqual([{ family: "Kariya", given: "KI" }]);
  });

  it("still reads a full 'Given Family' name as written", () => {
    const r = extractEnglishMetadata(`<meta name="citation_author" content="Alexey Dosovitskiy">`);
    expect(r.author).toEqual([{ given: "Alexey", family: "Dosovitskiy" }]);
  });

  // ACM ships no citation_title/dc.Title, and its og:title is a byte-for-byte
  // copy of the browser-tab title — venue suffix and all.
  it("splits ACM's tab-title og:title into title + venue", () => {
    const r = extractEnglishMetadata(`
      <title>Point Cloud Analysis for ML-Based Malicious Traffic Detection: Reducing Majorities of False Positive Alarms | Proceedings of the 2023 ACM SIGSAC Conference on Computer and Communications Security</title>
      <meta property="og:title" content="Point Cloud Analysis for ML-Based Malicious Traffic Detection: Reducing Majorities of False Positive Alarms | Proceedings of the 2023 ACM SIGSAC Conference on Computer and Communications Security">
    `);
    expect(r.title).toBe(
      "Point Cloud Analysis for ML-Based Malicious Traffic Detection: Reducing Majorities of False Positive Alarms",
    );
    expect(r["container-title"]).toBe(
      "Proceedings of the 2023 ACM SIGSAC Conference on Computer and Communications Security",
    );
  });

  it("leaves og:title alone when the publisher set it apart from <title>", () => {
    const r = extractEnglishMetadata(`
      <title>Some Paper | Nature</title>
      <meta property="og:title" content="Some Paper">
    `);
    expect(r.title).toBe("Some Paper");
    expect(r["container-title"]).toBeUndefined();
  });

  // Two pipes: we cannot tell which one divides title from venue, so don't guess.
  it("refuses to split a tab title with more than one pipe", () => {
    const r = extractEnglishMetadata(`
      <title>Rules | Standards | A Study</title>
      <meta property="og:title" content="Rules | Standards | A Study">
    `);
    expect(r.title).toBe("Rules | Standards | A Study");
    expect(r["container-title"]).toBeUndefined();
  });

  it("lets citation_journal_title win the container over a split tail", () => {
    const r = extractEnglishMetadata(`
      <title>Some Paper | ACM Conferences</title>
      <meta property="og:title" content="Some Paper | ACM Conferences">
      <meta name="citation_journal_title" content="Real Journal">
    `);
    expect(r.title).toBe("Some Paper");
    expect(r["container-title"]).toBe("Real Journal");
  });

  it("prefers citation_title over og:title, leaving the tab title untouched", () => {
    const r = extractEnglishMetadata(`
      <title>Paying for open access | ScienceDirect</title>
      <meta name="citation_title" content="Paying for open access">
      <meta property="og:title" content="Paying for open access | ScienceDirect">
    `);
    expect(r.title).toBe("Paying for open access");
  });
});

describe("extractArxivId", () => {
  it("reads citation_arxiv_id off an arXiv abs page", () => {
    const html = `
      <meta name="citation_title" content="SciResearcher" />
      <meta name="citation_arxiv_id" content="2605.01489" />
    `;
    expect(extractArxivId({ url: "https://arxiv.org/abs/2605.01489", html })).toBe(
      "2605.01489",
    );
  });

  it("falls back to the page URL (abs/pdf, version stripped)", () => {
    expect(
      extractArxivId({ url: "https://arxiv.org/pdf/2605.01489v2", html: "<html></html>" }),
    ).toBe("2605.01489");
  });

  it("returns null on non-arXiv pages", () => {
    expect(
      extractArxivId({ url: "https://www.nature.com/articles/x", html: "<html></html>" }),
    ).toBeNull();
  });
});

// Digital Commons (bepress) 会把整套路牌全部写成 bepress_citation_* 变体，
// Highwire/Dublin Core 一概缺席。2026-09 Purdue 实站复盘：不读这批 meta 时
// 题录只剩 og:title，作者/DOI/卷期页与 PDF 链接全部丢失。
describe("extractEnglishMetadata — bepress (Digital Commons)", () => {
  const BEPRESS_HTML = `
    <meta property="og:title" content="Dissociation">
    <meta name="bepress_citation_journal_title" content="CLCWeb: Comparative Literature and Culture">
    <meta name="bepress_citation_firstpage" content="13">
    <meta name="bepress_citation_author" content="Bademsoy, Aylin">
    <meta name="bepress_citation_title" content="Dissociation">
    <meta name="bepress_citation_date" content="2026">
    <meta name="bepress_citation_volume" content="27">
    <meta name="bepress_citation_issue" content="1">
    <meta name="bepress_citation_pdf_url" content="https://docs.lib.purdue.edu/cgi/viewcontent.cgi?article=5180&amp;context=clcweb">
    <meta name="bepress_citation_doi" content="10.7771/1481-4374.5180">
    <meta name="bepress_citation_issn" content="1481-4374">
  `;

  it("reads bepress_citation_* into CSL when Highwire tags are absent", () => {
    const m = extractEnglishMetadata(BEPRESS_HTML);
    expect(m.title).toBe("Dissociation");
    expect(m.author).toEqual([{ family: "Bademsoy", given: "Aylin" }]);
    expect(m["container-title"]).toBe("CLCWeb: Comparative Literature and Culture");
    expect(m.volume).toBe("27");
    expect(m.issue).toBe("1");
    expect(m.page).toBe("13");
    expect(m.DOI).toBe("10.7771/1481-4374.5180");
    expect(m.ISSN).toEqual(["1481-4374"]);
    expect(m.issued).toEqual({ "date-parts": [[2026]] });
  });

  it("extractPdfUrl falls back to bepress_citation_pdf_url", () => {
    expect(extractPdfUrl(BEPRESS_HTML)).toBe(
      "https://docs.lib.purdue.edu/cgi/viewcontent.cgi?article=5180&context=clcweb",
    );
  });

  it("prefers Highwire values when a page carries both vocabularies", () => {
    const m = extractEnglishMetadata(`
      <meta name="citation_title" content="Highwire wins">
      <meta name="bepress_citation_title" content="bepress loses">
    `);
    expect(m.title).toBe("Highwire wins");
  });
});
