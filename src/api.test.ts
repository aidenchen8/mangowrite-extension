import { describe, expect, it, vi } from "vitest";

import { downloadAttachment, resolvePdfFilename, uploadPluginCapture } from "./api.js";
import type { ByteFetcher } from "./api.js";
import type { Attachment } from "./protocol.js";

const enc = (s: string) => new TextEncoder().encode(s);
const PDF_BYTES = enc("%PDF-1.7\n... real pdf ...");

const IEEE_ATTACHMENT: Attachment = {
  kind: "pdf",
  url: "https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=10849561",
  mime: "application/pdf",
  filename: "10849561.pdf",
};

const STAMP_SHELL =
  '<html><head><title>IEEE Xplore Full-Text PDF:</title></head><body>' +
  '<iframe src="https://ieeexplore.ieee.org/ielx8/6287639/10820123/10849561.pdf?tp=&arnumber=10849561&ref=x" frameborder="0"></iframe></body></html>';

describe("downloadAttachment — PDF-viewer shell resolution (IEEE stamp.jsp)", () => {
  it("follows the embedded <iframe> PDF when the pdf link serves an HTML shell", async () => {
    const fetchBytes: ByteFetcher = vi.fn(async (url: string) => {
      if (url.includes("stamp.jsp")) {
        return { bytes: enc(STAMP_SHELL), contentType: "text/html; charset=UTF-8", contentDisposition: null };
      }
      if (url.includes("10849561.pdf")) {
        return { bytes: PDF_BYTES, contentType: "application/pdf", contentDisposition: null };
      }
      return null;
    });

    const { file, gate } = await downloadAttachment(IEEE_ATTACHMENT, "Agentic AI", fetchBytes);
    expect(file).not.toBeNull();
    expect(gate).toBeNull();
    expect(file!.mime).toBe("application/pdf");
    expect(file!.bytes).toEqual(PDF_BYTES);
    // filename derived from the resolved inner PDF URL, not the stamp.jsp shell.
    expect(file!.filename).toBe("10849561.pdf");
    expect(fetchBytes).toHaveBeenCalledTimes(2);
  });

  it("yields no file, flagged gated, when the embedded PDF is itself a paywall", async () => {
    const fetchBytes: ByteFetcher = vi.fn(async (url: string) => {
      if (url.includes("stamp.jsp")) {
        return { bytes: enc(STAMP_SHELL), contentType: "text/html", contentDisposition: null };
      }
      return { bytes: enc("<html>Sign in to access</html>"), contentType: "text/html", contentDisposition: null };
    });

    expect(await downloadAttachment(IEEE_ATTACHMENT, "Agentic AI", fetchBytes)).toEqual({
      file: null,
      gate: "login",
    });
  });

  it("flags a plain login-wall HTML with no embedded PDF as gated", async () => {
    const fetchBytes: ByteFetcher = vi.fn(async () => ({
      bytes: enc("<html><body>Please sign in</body></html>"),
      contentType: "text/html",
      contentDisposition: null,
    }));

    expect(await downloadAttachment(IEEE_ATTACHMENT, "Agentic AI", fetchBytes)).toEqual({
      file: null,
      gate: "login",
    });
    // one fetch only — no embed to follow.
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });
});

const CNKI_HTML_ATTACHMENT: Attachment = {
  kind: "html",
  url: "https://bar.cnki.net/bar/download/order?id=HTML_ID_123",
  mime: "text/html",
  filename: "pzkx202009002.html",
};

const CNKI_PDF_ATTACHMENT: Attachment = {
  kind: "pdf",
  url: "https://bar.cnki.net/bar/download/order?id=PDF_ID_456",
  mime: "application/pdf",
  filename: "pzkx202009002.pdf",
};

describe("downloadAttachment — gate pages must not become full text", () => {
  it("rejects the CNKI login page served at a 200 for the HTML 全文 link", async () => {
    // The real regression: 中国知网-登录 came back as 200 text/html and was stored
    // as the content of 迈向第三代人工智能.
    const fetchBytes: ByteFetcher = vi.fn(async () => ({
      bytes: enc(
        '<html><head><title>中国知网-登录</title></head><body>' +
          '<div id="captcha-element"></div><div id="loginMain"></div></body></html>',
      ),
      contentType: "text/html; charset=utf-8",
      contentDisposition: null,
    }));

    // The classified reason is what turns the message into "站点要求登录".
    expect(await downloadAttachment(CNKI_HTML_ATTACHMENT, "迈向第三代人工智能", fetchBytes)).toEqual({
      file: null,
      gate: "login",
    });
  });

  it("still accepts a genuine HTML full-text body", async () => {
    const body = `<html><head><title>迈向第三代人工智能</title></head><body>${"正文".repeat(2000)}</body></html>`;
    const fetchBytes: ByteFetcher = vi.fn(async () => ({
      bytes: enc(body),
      contentType: "text/html; charset=utf-8",
      contentDisposition: null,
    }));

    const { file, gate } = await downloadAttachment(CNKI_HTML_ATTACHMENT, "迈向第三代人工智能", fetchBytes);
    expect(file).not.toBeNull();
    expect(gate).toBeNull();
    expect(file!.mime).toBe("text/html");
    expect(file!.filename).toBe("pzkx202009002.html");
  });

  it("rejects a PDF attachment whose bytes aren't a PDF despite a non-HTML Content-Type", async () => {
    const fetchBytes: ByteFetcher = vi.fn(async () => ({
      bytes: enc('<html><head><title>中国知网-登录</title></head><body></body></html>'),
      contentType: "application/octet-stream",
      contentDisposition: null,
    }));

    expect(await downloadAttachment(CNKI_PDF_ATTACHMENT, "迈向第三代人工智能", fetchBytes)).toEqual({
      file: null,
      gate: "login",
    });
  });

  it("accepts real PDF bytes served as octet-stream", async () => {
    const fetchBytes: ByteFetcher = vi.fn(async () => ({
      bytes: PDF_BYTES,
      contentType: "application/octet-stream",
      contentDisposition: null,
    }));

    const { file, gate } = await downloadAttachment(CNKI_PDF_ATTACHMENT, "迈向第三代人工智能", fetchBytes);
    expect(file).not.toBeNull();
    expect(gate).toBeNull();
    expect(file!.bytes).toEqual(PDF_BYTES);
    // …and records them as a PDF. raw.githubusercontent.com labels every file
    // application/octet-stream; carrying that label through made the parse job
    // fail with unsupported_mime while the bytes were a perfectly good paper.
    expect(file!.mime).toBe("application/pdf");
  });
});

describe("resolvePdfFilename — path segment decoding", () => {
  it("decodes the percent-encoded basename of a local file:// PDF", () => {
    const name = resolvePdfFilename(
      "file:///D:/%E5%BA%94%E7%94%A8%E8%BD%AF%E4%BB%B6/%E8%AE%BA%E6%96%87.pdf",
      null,
      "fallback",
    );
    // 上传文件名会成为库里的初始标题——必须是解码后的人话，不是 %E8… 汤。
    expect(name).toBe("论文.pdf");
  });

  it("decodes publisher URLs too and appends .pdf when the segment lacks it", () => {
    expect(resolvePdfFilename("https://example.org/files/paper%20draft", null, "T")).toBe(
      "paper draft.pdf",
    );
  });

  it("keeps the raw segment when decoding fails (stray %)", () => {
    expect(resolvePdfFilename("https://example.org/files/50%off.pdf", null, "T")).toBe("50%off.pdf");
  });

  it("content-disposition still wins over the URL path", () => {
    expect(
      resolvePdfFilename("https://example.org/a.pdf", 'attachment; filename="declared.pdf"', "T"),
    ).toBe("declared.pdf");
  });
});

describe("uploadPluginCapture — skipEnrichSources form 字段", () => {
  // 服务端契约：multipart 字段名精确为 skipEnrichSources，逗号分隔、白名单 openalex。
  async function captureForm(skipEnrichSources?: string[]): Promise<FormData> {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ sourceId: "src-1", created: true, state: "ok", resolved: true, ingestStatus: null, uploadedFile: false, validation: null, jobId: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await uploadPluginCapture({
        apiBaseUrl: "https://api.example.com",
        token: "tk",
        identifier: null,
        originUrl: "https://journal.example/article",
        skipEnrichSources,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    return init.body as FormData;
  }

  it("非空时以逗号串入 form", async () => {
    const form = await captureForm(["openalex"]);
    expect(form.get("skipEnrichSources")).toBe("openalex");
  });

  it("缺省/为空时不发送该字段", async () => {
    expect((await captureForm()).get("skipEnrichSources")).toBeNull();
    expect((await captureForm([])).get("skipEnrichSources")).toBeNull();
  });
});
