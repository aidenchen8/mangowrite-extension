import { describe, expect, it, vi } from "vitest";

import { wosTranslator } from "./wos.js";

// Fragments lifted verbatim from webofscience.clarivate.cn/wos/woscc/full-record/
// WOS:000571285200009 (Harris et al., "Array programming with NumPy"). The page
// carries exactly one meta tag (`viewport`) — everything below is what the
// Angular app renders, `data-ta` hooks and all. The `<mark>` around the DOI is
// the search-term highlight WoS injects when you arrive from a DOI query.
const FULL_RECORD_HTML = `<html><head><meta name="viewport" content="width=device-width"></head>
<body><app-wos>
<h2 class="title text--large" data-ta="FullRTa-fullRecordtitle-0" id="FullRTa-fullRecordtitle-0" lang="en" dir="ltr">Array programming with NumPy</h2>
<a data-ta="SumAuthTa-DisplayName-author-en-0" href="/wos/author/record/90843704"><span lang="en" class="ng-star-inserted">Harris, CR</span><!----></a>
<a data-ta="SumAuthTa-DisplayName-author-en-2" href="/wos/author/record/16565224"><span lang="en" class="ng-star-inserted">van der Walt, SJ</span><!----></a>
<a data-ta="SumAuthTa-DisplayName-author-en-1" href="/wos/author/record/29465804"><span lang="en" class="ng-star-inserted">Millman, KJ</span><!----></a>
<h3 data-ta="FullRTa-sourceLabel" id="FullRTa-sourceLabel">Source</h3>
<a class="ng-star-inserted" lang="en" href="/wos/woscc/general-summary?queryJson=%5B%7B%22rowBoolean%22:null,%22rowField%22:%22SO%22,%22rowText%22:%22NATURE%22%7D%5D"><span>NATURE</span></a>
<h3 data-ta="FullRTa-volumeLabel">Volume</h3><span class="value" data-ta="FullRTa-volume" id="FullRTa-volume">585</span>
<h3 data-ta="FullRTa-issueLabel">Issue</h3><span class="value" data-ta="FullRTa-issue" id="FullRTa-issue">7825</span>
<h3 data-ta="FullRTa-pagesLabel">Page</h3><span class="value" data-ta="FullRTa-pageNo" id="FullRTa-pageNo">357-362</span>
<h3 data-ta="FullRTa-DOILabel" id="FullRTa-DOILabel">DOI</h3><span dir="auto" class="value" data-ta="FullRTa-DOI" id="FullRTa-DOI"><mark>10.1038/s41586-020-2649-2</mark></span><!---->
<h3 data-ta="FullRTa-publishedLabel">Published</h3><span name="pubdate" class="value" data-ta="FullRTa-pubdate" id="FullRTa-pubdate">SEP 17 2020</span>
<h3 data-ta="FullRTa-doctypeLabel">Document Type</h3><span><span class="value" data-ta="FullRTa-doctype-0" id="FullRTa-doctype-0">Review</span><!----></span>
</app-wos></body></html>`;

describe("wosTranslator", () => {
  it("detects by the record hook, not the host (clarivate.cn mirror, WebVPN)", () => {
    expect(wosTranslator.detect({ url: "https://webvpn.uni.edu.cn/x", html: FULL_RECORD_HTML })).toBe(
      true,
    );
    // The search-results page has no full-record hook and must not be captured.
    expect(
      wosTranslator.detect({
        url: "https://www.webofscience.com/wos/woscc/summary/x/relevance/1",
        html: `<html><body><app-wos><a data-ta="summary-record-title-link">Array programming</a></app-wos></body></html>`,
      }),
    ).toBe(false);
  });

  it("reads the record off the data-ta hooks, unwrapping the highlighted DOI", async () => {
    const { metadata, identifier, attachments, resolverSource } = await wosTranslator.extract({
      url: "https://webofscience.clarivate.cn/wos/woscc/full-record/WOS:000571285200009",
      html: FULL_RECORD_HTML,
      fetchText: vi.fn(),
    });

    expect(metadata.title).toBe("Array programming with NumPy");
    expect(metadata.DOI).toBe("10.1038/s41586-020-2649-2");
    expect(metadata.volume).toBe("585");
    expect(metadata.issue).toBe("7825");
    expect(metadata.page).toBe("357-362");
    expect(metadata.issued).toEqual({ "date-parts": [[2020]] });
    expect(identifier).toBe("10.1038/s41586-020-2649-2");
    expect(resolverSource).toBe("plugin-dom-en");
    // WoS is an index: it never hosts full text.
    expect(attachments).toEqual([]);
  });

  it("orders authors by their hook index and splits 'Family, Initials'", async () => {
    const { metadata } = await wosTranslator.extract({
      url: "https://www.webofscience.com/wos/woscc/full-record/WOS:000571285200009",
      html: FULL_RECORD_HTML,
      fetchText: vi.fn(),
    });

    // Author 2 appears before author 1 in the markup above, on purpose.
    expect(metadata.author).toEqual([
      { family: "Harris", given: "CR" },
      { family: "Millman", given: "KJ" },
      { family: "van der Walt", given: "SJ" },
    ]);
  });

  it("recovers the journal from the source-search link, not the JCR side-nav", async () => {
    const { metadata } = await wosTranslator.extract({
      url: "https://www.webofscience.com/wos/woscc/full-record/WOS:000571285200009",
      html: FULL_RECORD_HTML,
      fetchText: vi.fn(),
    });

    // Upper-cased by WoS itself; CrossRef overrides it downstream via the DOI.
    expect(metadata["container-title"]).toBe("NATURE");
  });

  it("maps the WoS document type onto CSL", async () => {
    const asProceedings = FULL_RECORD_HTML.replace(
      '>Review</span>',
      '>Proceedings Paper</span>',
    );
    const { metadata } = await wosTranslator.extract({
      url: "https://www.webofscience.com/wos/woscc/full-record/WOS:000000000000001",
      html: asProceedings,
      fetchText: vi.fn(),
    });
    expect(metadata.type).toBe("paper-conference");
  });

  it("survives a record with no DOI, volume or pages", async () => {
    const sparse = `<html><body><app-wos>
<h2 data-ta="FullRTa-fullRecordtitle-0" id="FullRTa-fullRecordtitle-0">A talk with no DOI</h2>
<span data-ta="FullRTa-pubdate">NOV 2019</span>
</app-wos></body></html>`;
    const { metadata, identifier } = await wosTranslator.extract({
      url: "https://www.webofscience.com/wos/woscc/full-record/WOS:000000000000002",
      html: sparse,
      fetchText: vi.fn(),
    });

    expect(metadata.title).toBe("A talk with no DOI");
    expect(metadata.issued).toEqual({ "date-parts": [[2019]] });
    expect(metadata.DOI).toBeUndefined();
    expect(metadata.author).toBeUndefined();
    expect(identifier).toBeNull();
  });
});
