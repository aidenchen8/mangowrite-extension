import { describe, expect, it } from "vitest";

import { hostedPdfTranslator } from "./hosted-pdf.js";

const noopFetch = async () => "";

// Mirrors the payload line GitHub embeds in the blob page's initial HTML
// (verified against github.com/cordiverse/paper/blob/main/paper.pdf).
const GITHUB_HTML = (rawBlobUrl: string) =>
  `<html><head><title>paper/paper.pdf at main · cordiverse/paper · GitHub</title>
  <meta property="og:type" content="object" /></head>
  <body><script type="application/json">{"payload":{"blob":{"rawBlobUrl":"${rawBlobUrl}"}}}</script></body></html>`;

describe("hostedPdfTranslator (GitHub)", () => {
  const blobUrl = "https://github.com/cordiverse/paper/blob/main/paper.pdf";

  it("detects a blob page for a .pdf file", () => {
    expect(hostedPdfTranslator.detect({ url: blobUrl, html: "" })).toBe(true);
  });

  it("ignores blob pages for non-PDF files", () => {
    expect(
      hostedPdfTranslator.detect({ url: "https://github.com/cordiverse/paper/blob/main/README.md", html: "" }),
    ).toBe(false);
  });

  it("ignores repo root / tree pages", () => {
    expect(hostedPdfTranslator.detect({ url: "https://github.com/cordiverse/paper", html: "" })).toBe(false);
    expect(
      hostedPdfTranslator.detect({ url: "https://github.com/cordiverse/paper/tree/main/docs", html: "" }),
    ).toBe(false);
  });

  it("ignores non-git hosts", () => {
    expect(
      hostedPdfTranslator.detect({ url: "https://example.org/a/b/blob/main/paper.pdf", html: "" }),
    ).toBe(false);
  });

  it("uses the payload's rawBlobUrl — refs/heads resolves a slashy ref server-side", async () => {
    const html = GITHUB_HTML("https://github.com/cordiverse/paper/raw/refs/heads/main/paper.pdf");
    const result = await hostedPdfTranslator.extract({ url: blobUrl, html, fetchText: noopFetch });
    expect(result.resolverSource).toBe("plugin-git-pdf");
    expect(result.identifier).toBeNull();
    expect(result.attachments).toEqual([
      {
        kind: "pdf",
        url: "https://github.com/cordiverse/paper/raw/refs/heads/main/paper.pdf",
        mime: "application/pdf",
        filename: "paper.pdf",
      },
    ]);
    // No placeholder metadata: anything here would be filed as an authoritative
    // bibliography server-side and block the post-parse title/DOI resolution.
    expect(result.metadata).toEqual({});
    expect(result.allowGenericPdfDiscovery).toBe(false);
    expect(result.allowRawHtmlFallback).toBe(false);
  });

  it("decodes JSON unicode escapes in rawBlobUrl", async () => {
    // The fixture must carry a literal backslash-u escape, as GitHub's embedded JSON does.
    const html = GITHUB_HTML(
      "https://github.com/o/r/raw/refs/heads/main/a.pdf?token=A\\u0026B",
    );
    const result = await hostedPdfTranslator.extract({
      url: "https://github.com/o/r/blob/main/a.pdf",
      html,
      fetchText: noopFetch,
    });
    expect(result.attachments[0]?.url).toBe(
      "https://github.com/o/r/raw/refs/heads/main/a.pdf?token=A&B",
    );
  });

  it("falls back to a blob→raw URL rewrite when the payload is absent", async () => {
    const result = await hostedPdfTranslator.extract({ url: blobUrl, html: "<html></html>", fetchText: noopFetch });
    expect(result.attachments[0]?.url).toBe("https://github.com/cordiverse/paper/raw/main/paper.pdf");
  });

  it("derives the attachment filename from a nested, encoded path", async () => {
    const result = await hostedPdfTranslator.extract({
      url: "https://github.com/o/r/blob/main/docs/my%20paper.pdf",
      html: "<html></html>",
      fetchText: noopFetch,
    });
    expect(result.attachments[0]?.filename).toBe("my paper.pdf");
    expect(result.metadata).toEqual({});
  });
});

describe("hostedPdfTranslator (GitLab / Gitee)", () => {
  it("rewrites gitlab.com -/blob to -/raw", async () => {
    const url = "https://gitlab.com/group/sub/repo/-/blob/main/papers/paper.pdf";
    expect(hostedPdfTranslator.detect({ url, html: "" })).toBe(true);
    const result = await hostedPdfTranslator.extract({ url, html: "", fetchText: noopFetch });
    expect(result.attachments[0]?.url).toBe(
      "https://gitlab.com/group/sub/repo/-/raw/main/papers/paper.pdf",
    );
  });

  it("rewrites gitee.com blob to raw", async () => {
    const url = "https://gitee.com/owner/repo/blob/master/paper.pdf";
    expect(hostedPdfTranslator.detect({ url, html: "" })).toBe(true);
    const result = await hostedPdfTranslator.extract({ url, html: "", fetchText: noopFetch });
    expect(result.attachments[0]?.url).toBe("https://gitee.com/owner/repo/raw/master/paper.pdf");
  });
});
