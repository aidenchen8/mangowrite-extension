import { describe, expect, it, vi } from "vitest";

import { extractXplMetadata, ieeeTranslator } from "./ieee.js";

// Fragment lifted from ieeexplore.ieee.org/document/9156697 — Xplore exposes no
// citation_*/DC/JSON-LD at all, only this assignment.
const CONFERENCE_HTML = `<html><head><meta property="og:title" content="IEEE Xplore"></head>
<body><script>
xplGlobal.document.metadata = {"title":"ECA-Net: Efficient Channel Attention for Deep Convolutional Neural Networks","doi":"10.1109/CVPR42600.2020.01155","publicationTitle":"2020 IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)","volume":"","issue":"","startPage":"11531","endPage":"11539","publicationYear":"2020","publisher":"IEEE","isConference":true,"articleNumber":"9156697","pdfUrl":"/stamp/stamp.jsp?tp=&arnumber=9156697","issn":[{"format":"Electronic ISSN","value":"2575-7075"}],"authors":[{"name":"Qilong Wang","firstName":"Qilong","lastName":"Wang"},{"name":"Banggu Wu","firstName":"Banggu","lastName":"Wu"}]};
</script></body></html>`;

describe("extractXplMetadata", () => {
  it("balances braces while skipping string contents", () => {
    const html = `<script>xplGlobal.document.metadata = {"abstract":"a } brace \\" in text","doi":"10.1/x"};</script>`;
    expect(extractXplMetadata(html)).toEqual({ abstract: 'a } brace " in text', doi: "10.1/x" });
  });

  it("returns null when the assignment is absent", () => {
    expect(extractXplMetadata("<html><body>nothing</body></html>")).toBeNull();
  });
});

describe("ieeeTranslator", () => {
  it("detects the page by the embedded assignment, not the host", () => {
    expect(ieeeTranslator.detect({ url: "https://webvpn.uni.edu/x", html: CONFERENCE_HTML })).toBe(
      true,
    );
    expect(ieeeTranslator.detect({ url: "https://ieeexplore.ieee.org/x", html: "<html></html>" })).toBe(
      false,
    );
  });

  it("maps the embedded record to CSL and the stamp.jsp PDF", async () => {
    const { metadata, attachments, identifier } = await ieeeTranslator.extract({
      url: "https://ieeexplore.ieee.org/document/9156697",
      html: CONFERENCE_HTML,
      fetchText: vi.fn(),
    });

    expect(metadata.type).toBe("paper-conference");
    expect(metadata.title).toContain("ECA-Net");
    expect(metadata.author).toEqual([
      { family: "Wang", given: "Qilong" },
      { family: "Wu", given: "Banggu" },
    ]);
    expect(metadata["container-title"]).toContain("CVPR");
    expect(metadata.page).toBe("11531-11539");
    expect(metadata.issued).toEqual({ "date-parts": [[2020]] });
    expect(metadata.DOI).toBe("10.1109/cvpr42600.2020.01155");
    expect(metadata.ISSN).toEqual(["2575-7075"]);
    expect(identifier).toBe("10.1109/cvpr42600.2020.01155");
    expect(attachments).toEqual([
      expect.objectContaining({
        kind: "pdf",
        url: "https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=9156697",
      }),
    ]);
  });

  it("collapses a single-page range and skips empty volume/issue", async () => {
    const html = `<script>xplGlobal.document.metadata = {"title":"IEEE Open Access Publishing","startPage":"6294","endPage":"6294","volume":"21","issue":"4","isJournal":true};</script>`;
    const { metadata } = await ieeeTranslator.extract({
      url: "https://ieeexplore.ieee.org/document/10718664",
      html,
      fetchText: vi.fn(),
    });
    expect(metadata.type).toBe("article-journal");
    expect(metadata.page).toBe("6294");
    expect(metadata.volume).toBe("21");
  });

  // 2026-09 起 SSR 里的 assignment 只剩会话状态，题录由 /rest/document/<id>/
  // metadata 提供（document/10286823 实测：metadata={"userInfo":{…}}）。
  it("pulls the record from the REST endpoint and prefers it over the assignment", async () => {
    const html = `<script>xplGlobal.document.metadata={"userInfo":{"institute":false,"guest":true}};</script>`;
    const fetchText = vi.fn(async () =>
      JSON.stringify({
        title: "An Interference Sensing Algorithm Based on Duration Units of Frequency Points for Adaptive Frequency-Hopping System",
        publicationTitle: "IEEE Access",
        publicationYear: "2023",
        doi: "10.1109/ACCESS.2023.3325252",
        pdfUrl: "/stamp/stamp.jsp?tp=&arnumber=10286823",
        articleNumber: "10286823",
        authors: [
          { name: "Duo Wang", firstName: "Duo", lastName: "Wang" },
          { name: "Ju Wang", firstName: "Ju", lastName: "Wang" },
        ],
      }),
    );
    const { metadata, identifier, attachments } = await ieeeTranslator.extract({
      url: "https://ieeexplore.ieee.org/document/10286823",
      html,
      fetchText,
    });

    expect(fetchText).toHaveBeenCalledWith(
      "/rest/document/10286823/metadata",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Security-Request": "true" }),
      }),
    );
    expect(metadata.title).toContain("Interference Sensing Algorithm");
    expect(metadata["container-title"]).toBe("IEEE Access");
    expect(metadata.author).toEqual([
      { family: "Wang", given: "Duo" },
      { family: "Wang", given: "Ju" },
    ]);
    expect(metadata.DOI).toBe("10.1109/access.2023.3325252");
    expect(identifier).toBe("10.1109/access.2023.3325252");
    expect(attachments[0]!.url).toBe("https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=10286823");
  });

  it("falls back to the inline assignment when the REST endpoint is unreachable", async () => {
    const { metadata } = await ieeeTranslator.extract({
      url: "https://ieeexplore.ieee.org/document/9156697",
      html: CONFERENCE_HTML,
      fetchText: vi.fn(async () => {
        throw new Error("fetch_failed:403");
      }),
    });
    expect(metadata.title).toContain("ECA-Net");
  });

  it("produces no title from a userInfo-only assignment with no REST record", async () => {
    const { metadata } = await ieeeTranslator.extract({
      url: "https://ieeexplore.ieee.org/document/10286823",
      html: `<script>xplGlobal.document.metadata={"userInfo":{"institute":false}};</script>`,
      fetchText: vi.fn(async () => {
        throw new Error("fetch_failed:403");
      }),
    });
    expect(metadata.title).toBeUndefined();
  });
});
