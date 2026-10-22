import { describe, expect, it } from "vitest";

import {
  chooseManualCaptureAsset,
  normalizeApiBaseUrl,
  type ManualCaptureAsset,
} from "./workflow.js";

describe("chooseManualCaptureAsset", () => {
  it("prefers a fetched pdf over raw html for manual capture", () => {
    const result = chooseManualCaptureAsset({
      pageHtml: "<html><body><p>preview</p></body></html>",
      pdfFile: {
        bytes: new Uint8Array([1, 2, 3]),
        filename: "paper.pdf",
        mime: "application/pdf",
      },
    });

    expect(result).toEqual<ManualCaptureAsset>({
      kind: "file",
      bytes: new Uint8Array([1, 2, 3]),
      filename: "paper.pdf",
      mime: "application/pdf",
    });
  });

  it("falls back to html capture when no pdf is available", () => {
    const result = chooseManualCaptureAsset({
      pageHtml: "<html><body><p>preview</p></body></html>",
      pdfFile: null,
    });

    expect(result).toEqual<ManualCaptureAsset>({
      kind: "html",
      pageHtml: "<html><body><p>preview</p></body></html>",
      filename: "capture.html",
      mime: "text/html",
    });
  });
});

describe("normalizeApiBaseUrl", () => {
  it("trims whitespace and trailing slashes", () => {
    expect(normalizeApiBaseUrl(" https://app.example.com/// ")).toBe(
      "https://app.example.com",
    );
  });

  it("returns null for invalid URLs", () => {
    expect(normalizeApiBaseUrl("not-a-url")).toBeNull();
  });
});
