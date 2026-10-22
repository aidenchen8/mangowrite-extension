import type { PdfFileAsset } from "./protocol.js";

export type ManualCaptureAsset =
  | ({
      kind: "file";
    } & PdfFileAsset)
  | {
      kind: "html";
      pageHtml: string;
      filename: string;
      mime: "text/html";
    };

export function chooseManualCaptureAsset(input: {
  pageHtml: string;
  pdfFile: PdfFileAsset | null;
}): ManualCaptureAsset | null {
  if (input.pdfFile) {
    return {
      kind: "file",
      bytes: input.pdfFile.bytes,
      filename: input.pdfFile.filename,
      mime: input.pdfFile.mime,
    };
  }

  const pageHtml = input.pageHtml.trim();
  if (!pageHtml) {
    return null;
  }

  return {
    kind: "html",
    pageHtml,
    filename: "capture.html",
    mime: "text/html",
  };
}

export function normalizeApiBaseUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}
