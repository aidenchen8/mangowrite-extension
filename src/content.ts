import type { CaptureResult, ContentMessage, FetchBytesResult, OriginSnapshotResult } from "./protocol.js";
import { buildBridgeEvent, buildBridgeResponse, isBridgeOriginAllowed, parseBridgeRequest } from "./bridge.js";
import { pickTranslator } from "./translators/registry.js";
import { initFab } from "./fab.js";
import { canonicalizeUrl, extractCanonicalHint, sanitizeOriginUrl } from "./canonical-url.js";
import { buildSingleFileHtml } from "./single-file.js";
import { debugLog, isContextInvalidatedError, isExtensionContextAlive, logBuildBanner } from "./env.js";
import { waitForContentStability } from "./capture-stability.js";

// Content scripts re-inject on every page load but NOT on extension reload — refresh the
// target page after rebuilding, then check this banner in the page's own DevTools console.
logBuildBanner("content");
debugLog("content", "loaded", window.location.href);

// Cheap sync detection (no network) so the toolbar icon can go from gray to
// brand color the moment a page is recognized, without waiting for capture.
{
  const pageHtml = document.documentElement.outerHTML;
  const recognized =
    pickTranslator({ url: window.location.href, html: pageHtml }) !== null;
  debugLog("content", "recognized-state", recognized);
  const originUrl = recognized
    ? sanitizeOriginUrl(window.location.href)
    : canonicalizeUrl(window.location.href, { canonicalHint: extractCanonicalHint(pageHtml) });
  try {
    void chrome.runtime.sendMessage({ type: "mango-write/recognized-state", recognized, originUrl });
  } catch (error) {
    // Sync throw = stale script in a page that outlived an extension reload.
    if (!isContextInvalidatedError(error)) throw error;
  }

  // Mount the on-page FAB (draggable capture entry). It reflects `recognized`
  // and opens the popup panel on click.
  void initFab({ recognized });
}

/**
 * Chrome 原生 PDF 查看器壳的保守判别：整页只有一个 application/pdf embed、
 * 没有正文文本。要求「近空 body」是为了不把「网页里内嵌了一个 PDF 预览」的
 * 普通文章页误判进来——那种页面的正文仍然值得走网页快照。这只是
 * Content-Type 事实（background 的 webRequest 记录）缺失时的兜底信号，
 * 查看器 DOM 是 Chrome 内部实现，随时可能变。
 */
function isPdfViewerShell(): boolean {
  if (!document.querySelector('embed[type="application/pdf"], embed#plugin')) return false;
  const body = document.body;
  if (!body) return false;
  return body.innerText.trim() === "" && body.querySelectorAll("*").length <= 8;
}

// Web app → background bridge (see bridge.ts for the channel design and why
// this listener is the security boundary). The page posts
// {source:"mango-write-web", requestId, message}; we relay the message to the
// background's external-message handler and post the response back with the
// same requestId. Anything from a non-whitelisted origin never leaves this
// listener.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const request = parseBridgeRequest(event.data);
  if (!request) return;
  if (!isBridgeOriginAllowed(window.location.origin)) return;

  const reply = (response: { ok: boolean; result?: unknown; error?: string }) => {
    window.postMessage(buildBridgeResponse(request.requestId, response), window.location.origin);
  };

  // A stale content script (page outlived an extension reload/update) throws
  // "Extension context invalidated" synchronously here — a .catch on the
  // promise chain would never see it. Answer the page explicitly so the web
  // app can prompt a refresh instead of the console logging an uncaught error.
  if (!isExtensionContextAlive()) {
    reply({ ok: false, error: "context_invalidated" });
    return;
  }
  try {
    void chrome.runtime
      .sendMessage({ type: "mango-write/bridge", message: request.message })
      .then((response: { ok: boolean; result?: unknown; error?: string } | undefined) => {
        reply(response ?? { ok: false, error: "no_response" });
      })
      .catch((error: unknown) => {
        reply({ ok: false, error: error instanceof Error ? error.message : "bridge_failed" });
      });
  } catch (error) {
    reply({
      ok: false,
      error: isContextInvalidatedError(error)
        ? "context_invalidated"
        : error instanceof Error
          ? error.message
          : "bridge_failed",
    });
  }
});

/** Same-origin credentialed text fetch handed to translators (ShowExport etc). */
async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, {
    credentials: "include",
    ...init,
    signal: init?.signal ?? timeoutSignal(),
  });
  if (!res.ok) throw new Error(`fetch_failed:${res.status}`);
  return res.text();
}

// 读取阶段的耗时上限。点击导入后任务已入队、用户可以离开，但读取本身仍要
// 尽快结束：单请求 10s 超时防一个挂死的服务器占住并发槽，快照 20s 总时限
// 防大页面把读取拖到分钟级——没来得及内联的资源由 serve 端兜底（single-file
// 的设计允许内联失败），快照永远不会为等图片而无界等待。
const PAGE_FETCH_TIMEOUT_MS = 10_000;
const SNAPSHOT_DEADLINE_MS = 20_000;

/** AbortSignal.timeout 从 Chrome 103 起才有；旧内核不设超时（退化为无限等待）。 */
function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS) : undefined;
}

/** 只限制等待时长、不取消底层请求（消息中转没有取消通道）：超时按软失败处理。 */
function withTimeout<T>(promise: Promise<T>): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), PAGE_FETCH_TIMEOUT_MS)),
  ]);
}

/**
 * Cross-origin stylesheets can't be read from a content script (CORS-bound to
 * the page), so the background service worker fetches them for the snapshot.
 */
async function fetchCrossOriginCss(href: string): Promise<string | null> {
  try {
    const res = (await withTimeout(
      chrome.runtime.sendMessage({
        type: "mango-write/fetch-css-text",
        url: href,
      }),
    )) as { ok?: boolean; result?: { cssText?: string | null } } | null | undefined;
    return res?.ok && typeof res.result?.cssText === "string" ? res.result.cssText : null;
  } catch {
    return null;
  }
}

/**
 * Image fetch for single-file snapshot inlining. Same-origin images are
 * fetched in the page's own context (anti-leech/SSO sessions are tab-scoped;
 * see fetchBytesInPage), cross-origin ones go through the background service
 * worker because content-script fetches are CORS-bound to the page.
 */
async function fetchImageDataUri(url: string): Promise<string | null> {
  try {
    if (new URL(url, window.location.href).origin === window.location.origin) {
      const res = await withTimeout(fetchBytesInPage(url));
      if (!res?.ok) return null;
      const mime = (res.contentType ?? "").split(";")[0]?.trim().toLowerCase();
      if (!mime || !mime.startsWith("image/")) return null;
      return `data:${mime};base64,${res.base64}`;
    }
  } catch {
    return null;
  }
  try {
    const res = (await withTimeout(
      chrome.runtime.sendMessage({
        type: "mango-write/fetch-image-datauri",
        url,
      }),
    )) as { ok?: boolean; result?: { dataUri?: string | null } } | null | undefined;
    return res?.ok && typeof res.result?.dataUri === "string" ? res.result.dataUri : null;
  } catch {
    return null;
  }
}

async function capturePage(): Promise<CaptureResult> {
  const url = window.location.href;
  // Translators read the RAW page HTML — metadata like JSON-LD lives in
  // <script>, which the snapshot strips. Only the archived/uploaded pageHtml
  // of an unrecognized page is the self-contained single-file snapshot.
  const html = document.documentElement.outerHTML;
  const translator = pickTranslator({ url, html });
  debugLog("content", "capturePage:translator", translator?.id ?? "none", url);
  const extracted = translator
    ? await translator.extract({ url, html, fetchText })
    : null;

  if (translator && extracted) {
    const result = extracted;
    const metadataTitle =
      typeof result.metadata.title === "string" ? result.metadata.title : null;

    debugLog("content", "capturePage:extracted", {
      translator: translator.id,
      identifier: result.identifier,
      resolverSource: result.resolverSource,
      attachments: result.attachments.map((a) => ({ kind: a.kind, url: a.url, filename: a.filename })),
      allowGenericPdfDiscovery: result.allowGenericPdfDiscovery,
      allowRawHtmlFallback: result.allowRawHtmlFallback,
    });

    // 论文页零资源请求：不建快照（快照要抓几百个 CSS/图片），原始 outerHTML
    // 足够服务端规则提取与闸门判定。
    return {
      recognized: true,
      originUrl: sanitizeOriginUrl(url),
      title: (metadataTitle || document.title).trim(),
      identifier: result.identifier,
      pageHtml: html,
      pageHtmlKind: "raw",
      metadata: result.metadata as Record<string, unknown>,
      resolverSource: result.resolverSource,
      attachments: result.attachments,
      allowGenericPdfDiscovery: result.allowGenericPdfDiscovery,
      allowRawHtmlFallback: result.allowRawHtmlFallback,
    };
  }

  // 未识别网页：快照就是导入内容本身，照旧构建。
  const snapshotDeadline = Date.now() + SNAPSHOT_DEADLINE_MS;
  const snapshotHtml = await buildSingleFileHtml(document, url, {
    fetchCrossOriginCss,
    fetchImageDataUri,
    shouldAbort: () => Date.now() > snapshotDeadline,
    devicePixelRatio: window.devicePixelRatio,
  });

  // No translator recognized a paper here — this is just a web page. We still
  // import it: the page snapshot becomes a webpage entry, never a
  // paper's full text. The canonical URL keys the webpage work so re-capturing
  // the same page (tracking params, m.-host, …) dedups instead of doubling.
  return {
    recognized: false,
    originUrl: canonicalizeUrl(url, { canonicalHint: extractCanonicalHint(html) }),
    title: document.title.trim(),
    identifier: null,
    pageHtml: snapshotHtml,
    pageHtmlKind: "snapshot",
    metadata: {},
    resolverSource: "none",
    attachments: [],
    allowGenericPdfDiscovery: false,
    // The snapshot IS the content of a webpage capture.
    allowRawHtmlFallback: true,
  };
}

/**
 * Fetch bytes in the page's own execution context, not the background
 * service worker's. Anti-leech / SSO-gated download links (CNKI via WebVPN,
 * etc.) are often scoped to a single tab's session — a service-worker fetch
 * with credentials: "include" can still come back empty or as a login page
 * because the cookies/Referer that make the link work aren't sent the same
 * way from a cross-origin, non-navigational request.
 */
async function fetchBytesInPage(url: string): Promise<FetchBytesResult> {
  try {
    const response = await fetch(url, { method: "GET", credentials: "include" });
    if (!response.ok) {
      return { ok: false, error: `http_${response.status}` };
    }
    const buffer = await response.arrayBuffer();
    return {
      ok: true,
      base64: arrayBufferToBase64(buffer),
      contentType: response.headers.get("content-type"),
      contentDisposition: response.headers.get("content-disposition"),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "fetch_failed" };
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener(
  (message: ContentMessage, _sender, sendResponse) => {
    if (message.type === "mango-write/ping") {
      // Liveness probe + viewer-shell report (popup uses both to tell a
      // native-PDF-viewer tab apart from an unrecognized web page — current
      // Chrome injects content scripts into the viewer page, so an answer
      // alone no longer means "webpage").
      sendResponse({ ok: true, viewerShell: isPdfViewerShell() });
      return true;
    }
    if (message.type === "mango-write/library-changed") {
      // Background's one-way "an import just landed" broadcast. Relay it into
      // the page world so the web app can refresh its library list. The origin
      // gate mirrors the request bridge: this listener is the security
      // boundary, so the check lives here even though the background already
      // filtered its broadcast targets.
      if (isBridgeOriginAllowed(window.location.origin)) {
        window.postMessage(buildBridgeEvent("library-changed"), window.location.origin);
      }
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === "mango-write/capture-page-context") {
      debugLog("content", "capture-page-context requested");
      // 等正文稳定再快照：懒加载/慢渲染页在用户点击瞬间可能没渲染完，
      // 立刻 outerHTML 会得到半成品。等待有 3s 硬超时（心跳页永远有变更），
      // 静态页约一个静默窗口（700ms）即返回，见 capture-stability.ts。
      waitForContentStability()
        .then(() => capturePage())
        .then((capture) => sendResponse(capture))
        .catch((error) => {
          debugLog("content", "capturePage:error", error);
          sendResponse({
            error: error instanceof Error ? error.message : "capture_failed",
          });
        });
      return true; // keep the message channel open for the async response
    }
    if (message.type === "mango-write/origin-snapshot") {
      debugLog("content", "origin-snapshot requested");
      sendResponse({
        title: document.title,
        url: window.location.href,
        html: document.documentElement.outerHTML,
      } satisfies OriginSnapshotResult);
      return true;
    }
    if (message.type === "mango-write/fetch-bytes") {
      debugLog("content", "fetch-bytes requested", message.url);
      fetchBytesInPage(message.url)
        .then((result) => {
          debugLog("content", "fetch-bytes result", message.url, result.ok ? { contentType: result.contentType, bytes: result.base64.length } : result);
          sendResponse(result);
        })
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "fetch_failed" }));
      return true;
    }
    return true;
  },
);
