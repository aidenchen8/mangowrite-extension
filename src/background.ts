import {
  checkDeviceTokenValid,
  checkLibraryDuplicate,
  completeOriginMetadata,
  CompletionSubmitError,
  downloadAttachment,
  downloadPdfCandidate,
  extractPluginPdfCandidates,
  reportPluginEvents,
  reportPluginFailure,
  requestPluginSession,
  resolvePdfFilename,
  revokeSelf,
  uploadOriginPdf,
  uploadPluginCapture,
  type ByteFetcher,
  type MembershipInfo,
  type PluginImportEventItem,
  type PluginPdfCandidate,
} from "./api.js";
import { detectGate, type GateKind } from "./interstitial.js";
import { isBridgeOriginAllowed } from "./bridge.js";
import { isPublicHttpUrl } from "./fetch-guard.js";
import { extractPluginPdfCandidates as extractLocalPdfCandidates } from "./vendor/metadata-resolver/pdf-candidates";
import type {
  AcquiredPayload,
  BackgroundMessage,
  CaptureFailure,
  CaptureListMessage,
  CaptureActionKind,
  CaptureRecord,
  CaptureResult,
  CaptureResultKind,
  CaptureState,
  CaptureView,
  CompletionCaptureSummary,
  CompletionMismatchReason,
  CompletionTask,
  CompletionView,
  ExtensionSettings,
  ExternalBackgroundMessage,
  FetchBytesResult,
  FailureKind,
  OriginSnapshotResult,
  PageSnapshot,
  PdfFileAsset,
  RecognizedStateMessage,
  RetryKind,
  TabDocumentInfo,
  TeamTarget,
} from "./protocol.js";
import {
  clearPairing,
  getActiveOrigin,
  getApiBaseUrl,
  getDeviceId,
  getPairing,
  getPairings,
  isAutoPairOptedOut,
  normalizeOrigin,
  setActiveOrigin,
  setAutoPairOptOut,
  setPairingActiveSpace,
  getSettings,
  setPairing,
  setSettings,
  type Pairing,
} from "./storage.js";
import { captureKey, classifyFailure, failureText, isTransientError, siteLabel } from "./queue-util.js";
import { wrapByteFetcher } from "./net-throttle.js";
import { sanitizeOriginUrl } from "./canonical-url.js";
import {
  proxyMappingFromPage,
  toProxiedUrl,
  type ProxyPageMapping,
} from "./webvpn-proxy.js";
import { looksLikePdfBytes, documentKindFromContentType } from "./pdf-detect.js";
import { lookupOpenAlexByDoi } from "./openalex-lookup.js";
import {
  checkForUpdate,
  initUpdateCheck,
  isUpdateCheckAlarm,
} from "./update-check.js";
import { debugError, debugLog, logBuildBanner, STORE_DNR_REFERER, VERSION } from "./env.js";

// Runs every time the service worker wakes up (MV3 kills it after ~30s idle) —
// the fastest way to confirm in the "检查视图" console that a reload picked up new code.
logBuildBanner("background");

// Any dynamic DNR rule we hold is meant to live only for the duration of a
// single download; if the worker was killed mid-download a stale rule can
// linger. Clear everything on wake — we own no persistent rules.
void clearDynamicRules();

// Reset to gray the moment a tab starts loading a new page — content scripts
// don't run on chrome://, the Web Store, etc., so without this the icon would
// stay stuck on whatever state the previous page left it in.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    recognizedByTab.set(tabId, { recognized: false, originUrl: sanitizeOriginUrl(changeInfo.url) });
    // A fresh main-frame navigation invalidates the previous document fact —
    // a new response will re-record it when headers arrive.
    forgetTabDocument(tabId);
    void setToolbarIcon(tabId, false);
  }
  // 模式 B：盯派活打开的出版商标签，加载完成后接管抓 PDF。
  if (changeInfo.status === "complete" && pendingOriginFetches.has(tabId)) {
    void runPendingOriginFetch(tabId);
  }
  // 补全/更正回路：关联标签（检索标签及其新开/登录跳转延续）加载到详情页后
  // 尝试识别；认出论文先成确认卡，等用户拍板，绝不静默回填。
  const completion = findCompletionTaskByTab(tabId);
  if (changeInfo.status === "complete" && completion) {
    void runPendingMetadataCompletion(tabId);
  }
});
// 补全/更正回路：从任务标签新开的标签（受控搜索 → 详情新标签、登录跳转）
// 继承任务关联——任务跟着用户走，而不是绑死在最初那个标签上。
chrome.tabs.onCreated.addListener((tab) => {
  const openerTabId = tab.openerTabId;
  if (openerTabId == null || tab.id == null) return;
  const task = findCompletionTaskByTab(openerTabId);
  if (!task || task.status !== "active") return;
  task.tabIds.push(tab.id);
  void persistCompletionTasks();
  debugLog("background", "completion:tab-inherited", { sourceId: task.sourceId, tabId: tab.id });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  recognizedByTab.delete(tabId);
  forgetTabDocument(tabId);
  void handleOriginTabRemoved(tabId);
  void handleCompletionTabRemoved(tabId);
});

chrome.runtime.onInstalled.addListener((details) => {
  debugLog("background", "onInstalled", {
    reason: details.reason,
    previousVersion: details.previousVersion,
  });
});

// Periodic wake so a stale queue (worker hard-killed mid-import) is reconciled
// even without user interaction — the alarm event revives the worker and
// markStaleCapturesFailed retires anything that can't resume.
chrome.alarms?.create("mango-write/reconcile", { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "mango-write/reconcile") {
    void markStaleCapturesFailed();
    void sweepStaleOriginFetches();
    void sweepStaleMetadataCompletions();
  } else if (isUpdateCheckAlarm(alarm.name)) {
    void checkForUpdate();
  }
});

// Site-distributed builds poll for newer versions (sideloaded installs never
// auto-update); no-op on store/dev channels.
initUpdateCheck();

/** Per-tab recognized state, so the popup can render its own state on open without re-detecting. */
const recognizedByTab = new Map<number, { recognized: boolean; originUrl: string }>();

// 直达 PDF 标签页的权威判据：main-frame 响应的 Content-Type。
// Chrome 的原生 PDF 查看器页也会注入 content script 并应答 ping（线上
// darwin-online、file:// 两批坏数据的成因），「content script 不在场」不再
// 可判。这里观察每个标签页主框架响应的真实 Content-Type —— 与 Chrome 决定
// 渲染查看器用的是同一事实，不会随查看器实现漂移。镜像到
// chrome.storage.session：MV3 service worker 随时会被回收，唤醒后凭 session
// 恢复（同 pendingOriginFetches 的模式）。

const tabDocuments = new Map<number, TabDocumentInfo>();
const TAB_DOCUMENTS_KEY = "tabDocumentTypes";
/** 串行化 session 镜像写：redirect + final 两次 onHeadersReceived 紧邻触发时避免乱序落盘。 */
let tabDocumentPersistChain: Promise<void> = Promise.resolve();

chrome.webRequest?.onHeadersReceived?.addListener(
  // Observational only — always returns undefined so it never blocks.
  (details): chrome.webRequest.BlockingResponse | undefined => {
    // 重定向也会触发 onHeadersReceived；后写覆盖先写，最终留在表里的是
    // 最后一次（即最终响应）的 Content-Type。
    const contentType =
      details.responseHeaders?.find((header) => header.name.toLowerCase() === "content-type")?.value ?? null;
    const info: TabDocumentInfo = {
      kind: documentKindFromContentType(contentType),
      contentType,
      url: details.url,
    };
    tabDocuments.set(details.tabId, info);
    tabDocumentPersistChain = tabDocumentPersistChain.then(() =>
      chrome.storage.session
        ?.set({ [TAB_DOCUMENTS_KEY]: Array.from(tabDocuments.entries()) })
        .catch((error: unknown) => debugError("background", "persistTabDocuments:failed", error)),
    );
    return undefined;
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
);
function forgetTabDocument(tabId: number): void {
  if (!tabDocuments.delete(tabId)) return;
  tabDocumentPersistChain = tabDocumentPersistChain.then(() =>
    chrome.storage.session
      ?.set({ [TAB_DOCUMENTS_KEY]: Array.from(tabDocuments.entries()) })
      .catch((error: unknown) => debugError("background", "persistTabDocuments:failed", error)),
  );
}

async function restoreTabDocuments(): Promise<void> {
  try {
    const stored = await chrome.storage.session?.get(TAB_DOCUMENTS_KEY);
    const list = (stored?.[TAB_DOCUMENTS_KEY] as Array<[number, TabDocumentInfo]> | undefined) ?? [];
    for (const [tabId, info] of list) {
      if (!tabDocuments.has(tabId)) tabDocuments.set(tabId, info);
    }
  } catch (error) {
    debugError("background", "restoreTabDocuments:failed", error);
  }
}

void restoreTabDocuments();

/**
 * popup 打开时 content script ping 无应答（扩展刚更新，旧标签页里的 content
 * script 已失效）且 webRequest 没有该页的 Content-Type 记录——「是不是 PDF」
 * 缺事实。直接 GET 一段头字节判定：Range 限制传输量，%PDF- 校验兜住不带
 * Content-Type 的直链；与 import-pdf-url 的字节校验是同一套判定函数。
 */
async function probeUrlDocumentKind(url: string): Promise<TabDocumentInfo["kind"]> {
  if (!isPublicHttpUrl(url)) return "unknown";
  try {
    const response = await fetch(url, {
      headers: { Range: "bytes=0-1023" },
      credentials: "omit",
      signal: AbortSignal.timeout(8_000),
    });
    const kind = documentKindFromContentType(response.headers.get("content-type"));
    if (kind !== "unknown") return kind;
    const buffer = await response.arrayBuffer();
    return looksLikePdfBytes(new Uint8Array(buffer)) ? "pdf" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Long-lived ports from the popup that want live progress updates. */
const progressPorts = new Set<chrome.runtime.Port>();

/** In-memory registry of captures currently running. Persisted to chrome.storage.local. */
const captures = new Map<string, CaptureRecord>();

/**
 * Webpage captures awaiting the user's 按网页导入 / 取消 on their `confirm`
 * queue card. Heap-only, like the byte payloads — a worker restart loses them
 * and the restored rows are failed by markStaleCapturesFailed.
 */
const pendingWebpageCaptures = new Map<string, CaptureResult>();

const RUNNING_CAPTURES_KEY = "runningCaptures";

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "mango-write/capture-progress") return;
  debugLog("background", "progress port connected");
  progressPorts.add(port);

  // Send the current list so a reopened popup can catch up in one shot.
  // failed/conflict 留到用户处理；已完成的由 1 天 TTL 与 20 条上限自动清理。
  port.postMessage(buildListMessage());

  port.onDisconnect.addListener(() => {
    progressPorts.delete(port);
  });
});

chrome.runtime.onMessage.addListener((message: BackgroundMessage | RecognizedStateMessage, sender, sendResponse) => {
  if (message.type === "mango-write/recognized-state") {
    const tabId = sender.tab?.id ?? null;
    if (tabId != null) {
      recognizedByTab.set(tabId, {
        recognized: message.recognized,
        originUrl: message.originUrl?.trim() || sanitizeOriginUrl(sender.tab?.url ?? ""),
      });
    }
    // Await + sendResponse (rather than fire-and-forget) so the MV3 service
    // worker isn't eligible for suspension before chrome.action.setIcon lands.
    void setToolbarIcon(tabId, message.recognized).then(() => sendResponse({ ok: true }));
    return true;
  }

  debugLog("background", "onMessage", message.type, message, { senderTabId: sender.tab?.id });
  // Bridge relay: sender is the content script, so its tab URL is the asking
  // web app's page. Origin-aware external handlers scope to that origin.
  const senderUrl = sender.url || sender.tab?.url || "";
  void handleBackgroundMessage(message, sender.tab?.id ?? null, senderUrl)
    .then((result) => {
      debugLog("background", "onMessage:ok", message.type, result);
      sendResponse({ ok: true, result });
    })
    .catch((error) => {
      debugError("background", "onMessage:error", message.type, error);
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "unknown_error",
      });
    });
  return true;
});

chrome.runtime.onMessageExternal.addListener(
  (message: ExternalBackgroundMessage, sender, sendResponse) => {
    debugLog("background", "onMessageExternal", message.type, { from: sender.url, message });
    void handleExternalMessage(message, normalizeOrigin(sender.origin || sender.url || ""))
      .then((result) => {
        debugLog("background", "onMessageExternal:ok", message.type, result);
        sendResponse({ ok: true, result });
      })
      .catch((error) => {
        debugError("background", "onMessageExternal:error", message.type, error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "unknown_error",
        });
      });
    return true;
  },
);

/**
 * On wake, any captures still in storage but not in memory mean the service
 * worker died mid-import. Mark them failed so the user isn't left with a
 * stale "running" state.
 */
void (async () => {
  await markStaleCapturesFailed();
  // 唤醒后先清一遍（storage 里可能躺着过期/超量的已完成记录），有变化才回写。
  if (pruneCaptures()) {
    void persistCaptures();
    broadcastCaptures();
    void updateBadge();
  }
})();

/**
 * Gray icon = no paper detected on this tab; brand-color icon = a translator
 * recognized one. Uses chrome.runtime.getURL rather than bare relative paths —
 * setIcon's `path` resolves against the calling script's own URL
 * (chrome-extension://<id>/dist/background.js), not the extension root, so a
 * plain "icons/icon16.png" silently 404s as .../dist/icons/icon16.png.
 */
async function setToolbarIcon(tabId: number | null, recognized: boolean): Promise<void> {
  if (tabId == null) return;
  const suffix = recognized ? "" : "-gray";
  try {
    await chrome.action.setIcon({
      tabId,
      path: {
        16: chrome.runtime.getURL(`icons/icon16${suffix}.png`),
        32: chrome.runtime.getURL(`icons/icon32${suffix}.png`),
        48: chrome.runtime.getURL(`icons/icon48${suffix}.png`),
        128: chrome.runtime.getURL(`icons/icon128${suffix}.png`),
      },
    });
    debugLog("background", "setToolbarIcon:ok", tabId, recognized);
  } catch (error) {
    // tab closed/navigated away before the icon update landed — safe to ignore.
    debugLog("background", "setToolbarIcon:skip", tabId, error);
  }
}

const CSS_FETCH_MAX_LENGTH = 2 * 1024 * 1024;

/**
 * Stylesheet fetch for single-file snapshots. Runs in the service worker
 * (host_permissions <all_urls>) because content-script fetches are CORS-bound
 * to the page. Failures are soft — the snapshot keeps the original <link> plus
 * a <base> fallback.
 *
 * 安全优先于样式：凭证一律不带（订阅墙保护的跨域 CSS 会丢样式，serve 端兜底），
 * 且拒绝私网/环回地址、只收 text/css（CDN 不回 content-type 时放行）。
 */
async function fetchCssText(url: string): Promise<{ cssText: string | null }> {
  try {
    if (!isPublicHttpUrl(url)) return { cssText: null };
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return { cssText: null };
    const contentType = res.headers.get("content-type");
    if (contentType && !/text\/css/i.test(contentType)) return { cssText: null };
    const text = await res.text();
    if (text.length > CSS_FETCH_MAX_LENGTH) return { cssText: null };
    return { cssText: text };
  } catch (error) {
    debugLog("background", "fetch-css-text:failed", url, error);
    return { cssText: null };
  }
}

const IMAGE_FETCH_MAX_BYTES = 10 * 1024 * 1024;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Image fetch for single-file snapshot inlining (cross-origin counterpart of
 * the content script's page-context fetch). Image mimes only; failures are
 * soft — the serve-time rewrite strips whatever was not inlined. No
 * credentials, and private/loopback hosts are refused (fetch-guard).
 */
async function fetchImageDataUri(url: string): Promise<{ dataUri: string | null }> {
  try {
    if (!isPublicHttpUrl(url)) return { dataUri: null };
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return { dataUri: null };
    const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!mime.startsWith("image/")) return { dataUri: null };
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > IMAGE_FETCH_MAX_BYTES) return { dataUri: null };
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > IMAGE_FETCH_MAX_BYTES) {
      return { dataUri: null };
    }
    return { dataUri: `data:${mime};base64,${arrayBufferToBase64(buffer)}` };
  } catch (error) {
    debugLog("background", "fetch-image-datauri:failed", url, error);
    return { dataUri: null };
  }
}

async function handleBackgroundMessage(
  message: BackgroundMessage,
  senderTabId: number | null,
  senderUrl = "",
): Promise<
  | { message: string }
  | { captureId: string }
  | { recognized: boolean }
  | { cssText: string | null }
  | { dataUri: string | null }
  | { ok: true }
  | { pong: true; version: string }
  | PairingState
  | ExternalPairingState
  | AutoPairDecision
  | { deviceId: string }
  | CaptureView[]
  | ExtensionSettings
  | TabDocumentInfo
  | { kind: TabDocumentInfo["kind"] }
> {
  switch (message.type) {
    case "mango-write/begin-capture":
      return beginCapture(message, senderTabId);
    case "mango-write/confirm-webpage-capture":
      confirmWebpageCapture(message.captureId);
      return { ok: true };
    case "mango-write/import-pdf-url":
      return runPdfUrlImport({
        url: message.url,
        title: message.title,
        tabId: message.tabId ?? senderTabId,
        teamId: message.teamId,
        teamName: message.teamName ?? null,
      });
    case "mango-write/get-recognized-state":
      return recognizedByTab.get(message.tabId) ?? { recognized: false, originUrl: "" };
    case "mango-write/get-tab-document": {
      const info = tabDocuments.get(message.tabId);
      // No observed fact (tab predates the listener, non-http scheme, …) —
      // say "unknown" so the popup falls back to its URL/DOM heuristics.
      return info ?? { kind: "unknown" as const, contentType: null, url: "" };
    }
    case "mango-write/probe-url":
      return { kind: await probeUrlDocumentKind(message.url) };
    case "mango-write/fetch-css-text":
      return fetchCssText(message.url);
    case "mango-write/fetch-image-datauri":
      return fetchImageDataUri(message.url);
    case "mango-write/get-pairing-state":
      return getPairingState();
    case "mango-write/logout":
      await disconnectPairing();
      return describePairingState();
    case "mango-write/switch-env":
      await setActiveOrigin(message.origin);
      return describePairingState();
    case "mango-write/get-captures":
      return captureViews();
    case "mango-write/retry-capture":
      retryCapture(message.captureId);
      return { ok: true };
    case "mango-write/reimport-capture":
      await reimportCapture(message.captureId);
      return { ok: true };
    case "mango-write/confirm-replace-capture":
      confirmReplaceCapture(message.captureId);
      return { ok: true };
    case "mango-write/cancel-capture":
      cancelCapture(message.captureId);
      return { ok: true };
    case "mango-write/dismiss-capture":
      dismissCapture(message.captureId);
      return { ok: true };
    case "mango-write/clear-finished-captures":
      clearFinishedCaptures();
      return { ok: true };
    case "mango-write/apply-completion":
      return applyCompletionTask({
        sourceId: message.sourceId,
        allowMismatch: message.allowMismatch ?? false,
      });
    case "mango-write/cancel-completion":
      return cancelCompletionTask(message.sourceId);
    case "mango-write/get-settings":
      return getSettings();
    case "mango-write/set-settings":
      return setSettings(message.settings);
    // Web-app bridge relay from the content script (origin already gated
    // there — see bridge.ts). Same handler as onMessageExternal; origin-aware
    // messages (get-pairing-state / unpair) scope to the asking page.
    case "mango-write/bridge":
      return handleExternalMessage(message.message, normalizeOrigin(senderUrl));
    default:
      throw new Error("unknown_message_type");
  }
}

/** Web-app view of the pairing: its own origin's slot, never the whole install. */
type ExternalPairingState = {
  paired: boolean;
  user: Pairing["user"] | null;
  tokenId: string | null;
  apiBaseUrl: string;
};

async function handleExternalMessage(
  message: ExternalBackgroundMessage,
  senderOrigin = "",
): Promise<
  | { message: string }
  | { pong: true; version: string }
  | PairingState
  | ExternalPairingState
  | AutoPairDecision
  | { deviceId: string }
  | { ok: true }
> {
  switch (message.type) {
    case "mango-write/fetch-origin":
      return runFetchOriginDispatch({
        originUrl: message.originUrl,
        token: message.token,
        sourceId: message.sourceId,
      });
    case "mango-write/complete-metadata":
      return runCompleteMetadataDispatch({
        searchUrl: message.searchUrl,
        token: message.token,
        sourceId: message.sourceId,
        apiBaseUrl: message.apiBaseUrl,
        targetTitle: message.targetTitle ?? null,
        targetDoi: message.targetDoi ?? null,
      });
    case "mango-write/ping":
      // version lets the web app's guide page compare installed vs latest.
      return { pong: true, version: VERSION };
    case "mango-write/pair": {
      const origin = normalizeOrigin(message.apiBaseUrl ?? getApiBaseUrl());
      await setPairing(origin, {
        deviceToken: message.token,
        tokenId: message.tokenId,
        user: message.user,
        pairedAt: Date.now(),
        apiBaseUrl: message.apiBaseUrl,
        canSwitchEnv: message.canSwitchEnv === true,
      });
      // Pairing at all — auto or by hand — is consent for this origin, so the
      // earlier "user disconnected on purpose" flag no longer applies.
      await setAutoPairOptOut(origin, false);
      releaseAutoPairClaim(origin);
      return describePairingState();
    }
    case "mango-write/should-auto-pair":
      // Single arbiter for auto-pairing: every open tab of the web app asks,
      // at most one is told to mint. See shouldAutoPair().
      return shouldAutoPair(normalizeOrigin(message.apiBaseUrl), message.userId);
    case "mango-write/get-device-id":
      return { deviceId: await getDeviceId() };
    case "mango-write/set-active-space":
      // 写进发送方自己的配对槽位（origin 隔离，同 get-pairing-state 的口径）。
      await setPairingActiveSpace(senderOrigin, message.spaceId);
      return { ok: true };
    case "mango-write/reload-self": {
      // Respond before reload — chrome.runtime.reload() kills the worker
      // immediately, so reloading first would surface "Extension context
      // invalidated" to the guide page instead of an ok. The reload also
      // orphans this tab's content-script bridge; the page reloads itself
      // right after, bringing both sides up on the new build.
      setTimeout(() => chrome.runtime.reload(), 50);
      return { message: "reloading" };
    }
    case "mango-write/get-pairing-state":
      return getExternalPairingState(senderOrigin);
    case "mango-write/unpair":
      // Scope the drop to the asking origin when we know it: the install can
      // hold one pairing per environment, and the web app's hygiene unpair
      // ("paired to another account") must not revoke a different
      // environment's slot.
      await disconnectPairing({
        origin: senderOrigin || undefined,
        optOut: message.optOut !== false,
      });
      return describePairingState();
    default:
      throw new Error("unknown_external_message_type");
  }
}

/** One paired environment, for the popup's switcher. */
type PairedEnvironment = {
  origin: string;
  user: Pairing["user"];
  active: boolean;
};

type PairingState = {
  paired: boolean;
  user: Pairing["user"] | null;
  tokenId: string | null;
  /**
   * Origin this device actually talks to — what the popup's environment badge
   * is derived from. Falls back to the build constant while unpaired so a
   * local/test build still declares its target before anyone logs in.
   */
  apiBaseUrl: string;
  /** Stable per-install id; the web app sends it when minting so one device = one row. */
  deviceId: string;
  /** Every environment this install is paired with (admins may hold several). */
  environments: PairedEnvironment[];
  /** Whether to offer the environment switcher — resolved server-side, never from a role string. */
  canSwitchEnv: boolean;
  /**
   * Membership slice of the self/status probe that validated the token — the
   * popup's membership bar renders it. Null when unpaired / no membership /
   * the probing path didn't hit the server (describePairingState).
   */
  membership: MembershipInfo | null;
  /**
   * 可写团队目标（self/status 同一往返带回），导入目标选择器的选项。
   * 只在 getPairingState 的探测路径里有值；describePairingState（刚写完状态、
   * 不打网络）返回空数组，popup 随后的 refreshPairingState 会补上。
   */
  teams: TeamTarget[];
  /** 网页端推来的「当前所在空间」：个人 = null。选择器的默认项。 */
  activeSpaceId: string | null;
};

async function unpairedState(): Promise<PairingState> {
  return {
    paired: false,
    user: null,
    tokenId: null,
    apiBaseUrl: getApiBaseUrl(),
    deviceId: await getDeviceId(),
    environments: [],
    canSwitchEnv: false,
    membership: null,
    teams: [],
    activeSpaceId: null,
  };
}

// Called whenever the popup opens and whenever the web app asks (e.g. its own
// top-bar / settings page refresh) — the natural points where a stale local
// pairing (revoked elsewhere) should be caught and cleared automatically.
async function getPairingState(): Promise<PairingState> {
  const pairing = await getPairing();
  if (!pairing) return unpairedState();

  const apiBaseUrl = pairing.apiBaseUrl ?? getApiBaseUrl();
  const { valid, membership, teams } = await checkDeviceTokenValid(apiBaseUrl, pairing.deviceToken);
  if (!valid) {
    await clearPairing();
    return unpairedState();
  }
  // membership/teams 来自同一次 self/status 往返；describePairingState 不打网络，
  // 在这里补上——popup 的会员条与团队选择器随 get-pairing-state 一起刷新，无独立轮询。
  return { ...(await describePairingState()), membership, teams: teams ?? [] };
}

/**
 * Current state as stored, with no server round-trip. Used by the mutating
 * handlers (pair / switch-env / unpair) — they just wrote the state, so
 * re-validating the token against the API would only add latency.
 */
async function describePairingState(): Promise<PairingState> {
  const pairing = await getPairing();
  if (!pairing) return unpairedState();

  const [map, activeOrigin, deviceId] = await Promise.all([
    getPairings(),
    getActiveOrigin(),
    getDeviceId(),
  ]);
  return {
    paired: true,
    user: pairing.user,
    tokenId: pairing.tokenId,
    apiBaseUrl: pairing.apiBaseUrl ?? getApiBaseUrl(),
    deviceId,
    environments: Object.entries(map).map(([origin, entry]) => ({
      origin,
      user: entry.user,
      active: origin === activeOrigin,
    })),
    canSwitchEnv: pairing.canSwitchEnv === true,
    // 会员/团队只在 getPairingState 的 self/status 往返里带回；这里的调用方
    // （pair / switch-env / logout）刚写完状态，不需要这批数据。
    membership: null,
    teams: [],
    activeSpaceId: pairing.activeSpaceId ?? null,
  };
}

/**
 * The web app's view of the pairing, scoped to the asking page's origin.
 *
 * The install holds one pairing slot per environment; answering with the
 * *active* one made every web app see some other environment's account as
 * "paired to the wrong user" and hygiene-unpair it — which dropped the active
 * slot, so two environments alternately killed each other's pairing and the
 * switcher never had more than one entry. Each origin only ever sees its own
 * slot here; cross-environment slots are invisible and untouchable from it.
 *
 * Unknown / empty origin (older callers, unexpected channel) → unpaired: the
 * page then falls back to auto/manual pair, which is always safe.
 */
async function getExternalPairingState(origin: string): Promise<ExternalPairingState> {
  const key = normalizeOrigin(origin);
  if (!key) return { paired: false, user: null, tokenId: null, apiBaseUrl: getApiBaseUrl() };

  const slot = (await getPairings())[key];
  if (!slot) return { paired: false, user: null, tokenId: null, apiBaseUrl: key };

  const apiBaseUrl = slot.apiBaseUrl ?? getApiBaseUrl();
  const { valid } = await checkDeviceTokenValid(apiBaseUrl, slot.deviceToken);
  if (!valid) {
    // Slot revoked server-side (device list) — forget just this slot; other
    // environments' pairings are unaffected.
    await clearPairing(key);
    return { paired: false, user: null, tokenId: null, apiBaseUrl: key };
  }
  return { paired: true, user: slot.user, tokenId: slot.tokenId, apiBaseUrl };
}

// Auto-pairing arbitration
// Every web-app tab asks on load and on focus. Without a gate, N tabs = N
// minted tokens and N pair pushes. The background is the only process that
// sees all of them, so it hands out a short-lived claim: the first asker is
// told to pair, everyone else is told to sit still until the claim expires or
// the pairing lands.
//
// The claim lives in memory and dies with the service worker, so a race is
// still possible after an eviction. That's survivable by construction: mints
// are upserted on (userId, deviceId) server-side, so a double mint collapses
// into the same row and the extension simply keeps whichever token arrived
// last. The claim is an optimization, not a correctness requirement.
const AUTO_PAIR_CLAIM_MS = 30_000;
const autoPairClaims = new Map<string, number>();

function releaseAutoPairClaim(origin: string): void {
  autoPairClaims.delete(origin);
}

type AutoPairDecision = { pair: boolean; reason: string };

async function shouldAutoPair(origin: string, userId: string): Promise<AutoPairDecision> {
  if (!origin) return { pair: false, reason: "bad_origin" };

  // An explicit disconnect wins over everything: re-pairing behind the user's
  // back would make the disconnect button decorative.
  if (await isAutoPairOptedOut(origin)) return { pair: false, reason: "opted_out" };

  const existing = (await getPairings())[origin];
  if (existing && existing.user.id === userId) return { pair: false, reason: "already_paired" };

  const now = Date.now();
  const claimedUntil = autoPairClaims.get(origin) ?? 0;
  if (claimedUntil > now) return { pair: false, reason: "another_tab_pairing" };

  autoPairClaims.set(origin, now + AUTO_PAIR_CLAIM_MS);
  return { pair: true, reason: "needed" };
}

/**
 * Disconnect this device: best-effort revoke the token server-side (so the
 * web app's "已连接设备" list updates immediately instead of drifting out of
 * sync with the local pairing state), then forget it locally either way.
 *
 * `origin` scopes the drop to one environment's slot — used by the web app's
 * unpair, which must never touch another environment's pairing (its hygiene
 * pass used to revoke the *active* slot and two environments would alternate
 * killing each other). Without an origin (popup logout) the active pairing
 * goes, which is the single-slot behavior the popup has always had.
 *
 * Also records an auto-pair opt-out for the dropped origin — otherwise the
 * next web-app tab of that origin would silently re-pair and the user could
 * never actually disconnect.
 */
async function disconnectPairing(options: { origin?: string; optOut?: boolean } = {}): Promise<void> {
  const optOut = options.optOut !== false;
  const target = normalizeOrigin(options.origin ?? "");
  if (target) {
    const slot = (await getPairings())[target];
    if (!slot) return; // nothing paired for this origin — nothing to drop
    await revokeSelf(slot.apiBaseUrl ?? getApiBaseUrl(), slot.deviceToken);
    if (optOut) await setAutoPairOptOut(target, true);
    await clearPairing(target);
    return;
  }

  const activeOrigin = await getActiveOrigin();
  const pairing = await getPairing();
  if (pairing) {
    await revokeSelf(pairing.apiBaseUrl ?? getApiBaseUrl(), pairing.deviceToken);
  }
  const origin = normalizeOrigin(pairing?.apiBaseUrl ?? activeOrigin ?? getApiBaseUrl());
  if (optOut) await setAutoPairOptOut(origin, true);
  await clearPairing(origin);
}

/**
 * Fetch bytes for a URL. Relays through the originating tab's content script
 * only when the target is same-origin with the page (e.g. WebVPN, which
 * proxies every host under one origin) — that matches the page's own
 * cookies/Referer for origin-scoped anti-leech links. Cross-origin targets
 * (e.g. bar.cnki.net linked from kns.cnki.net) go straight to a direct
 * service-worker fetch instead: a page-context fetch is guaranteed to be
 * CORS-blocked there (no Access-Control-Allow-Origin from CNKI), and CNKI's
 * order links are single-use — letting the doomed CORS attempt fire first
 * burns the token before the working direct fetch ever runs.
 *
 * 代理页例外（proxyMapping）：webvpn 代理页上，改写器漏改的原始出版商 URL
 * （`citation_pdf_url` 等 meta）可改写成页面同源形式（见 webvpn-proxy.ts），
 * 改写成功即走 viaTab——同源 fetch 不受 CORS 约束，且带校园会话。只改写映射
 * 声明的那一个明文 origin，跨 host 目标（含单用途 CNKI 订单链接）不受影响。
 *
 * 返回的闭包整体过 per-host 限速（viaTab 降级 direct 属同一次抓取，只计一次
 * 发起），避免对同一站点高频抓取。
 */
function makeByteFetcher(
  tabId: number | null,
  pageUrl: string,
  proxyMapping: ProxyPageMapping | null = null,
): ByteFetcher {
  const sameOrigin = (url: string): boolean => {
    try {
      return new URL(url).origin === new URL(pageUrl).origin;
    } catch {
      return false;
    }
  };

  async function fetchBytesViaTab(
    tabId: number,
    url: string,
  ): Promise<Awaited<ReturnType<ByteFetcher>>> {
    try {
      const response = (await chrome.tabs.sendMessage(tabId, {
        type: "mango-write/fetch-bytes",
        url,
      })) as FetchBytesResult | undefined;
      if (!response?.ok) {
        debugLog("background", "fetchBytes:viaTab failed", url, response);
        return null;
      }
      return {
        bytes: base64ToUint8Array(response.base64),
        contentType: response.contentType,
        contentDisposition: response.contentDisposition,
      };
    } catch (error) {
      // tab closed/navigated away — caller falls back to a direct fetch.
      debugLog("background", "fetchBytes:viaTab error", url, error);
      return null;
    }
  }

  return wrapByteFetcher(async (url, onProgress) => {
    if (tabId != null) {
      let viaTabUrl: string | null = null;
      if (sameOrigin(url)) {
        viaTabUrl = url;
      } else if (proxyMapping) {
        const proxied = toProxiedUrl(proxyMapping, url);
        if (proxied && proxied !== url) {
          debugLog("background", "fetchBytes:proxied", { from: url, to: proxied });
          viaTabUrl = proxied;
        }
      }
      if (viaTabUrl) {
        const viaTab = await fetchBytesViaTab(tabId, viaTabUrl);
        if (viaTab) return viaTab;
        // fall through to a direct fetch on the ORIGINAL url (session-less on a
        // proxied page, but that's the pre-rewrite behavior — better than nothing)
      }
    }
    // 直发路径同样不带会话出网：私网/环回目标软失败（返回 null），留给
    // serve 端兜底。via-tab 路径不设闸——那是页面自己的会话权限（WebVPN 依赖）。
    if (!isPublicHttpUrl(url)) {
      debugLog("background", "fetchBytes:direct-blocked", url);
      return null;
    }
    debugLog("background", "fetchBytes:direct", url, { tabId, sameOrigin: sameOrigin(url) });
    // Cross-origin anti-leech links (bar.cnki.net linked from a kns.cnki.net
    // article page) 302 to an error shell unless the request carries the
    // article page as Referer — exactly what the browser would send on a
    // real click. `fetch()` can't set Referer (forbidden header), so inject
    // it via a scoped, short-lived declarativeNetRequest rule.
    return fetchBytesDirect(url, pageUrl, onProgress);
  });
}

async function fetchBytesDirect(
  url: string,
  referer?: string | null,
  onProgress?: (loaded: number, total?: number) => void,
): ReturnType<ByteFetcher> {
  return withRefererRule(url, referer ?? null, async () => {
    try {
      const response = await fetch(url, { method: "GET", credentials: "include" });
      debugLog("background", "fetchBytesDirect:response", url, {
        status: response.status,
        ok: response.ok,
        redirected: response.redirected,
        finalUrl: response.url,
        contentType: response.headers.get("content-type"),
      });
      if (!response.ok) return null;

      const total = parseContentLength(response.headers.get("content-length"));
      const buffer = await readResponseWithProgress(response, onProgress, total);
      debugLog("background", "fetchBytesDirect:bytes", url, { length: buffer.byteLength });
      return {
        bytes: new Uint8Array(buffer),
        contentType: response.headers.get("content-type"),
        contentDisposition: response.headers.get("content-disposition"),
      };
    } catch (error) {
      debugError("background", "fetchBytesDirect:error", url, error);
      return null;
    }
  });
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function readResponseWithProgress(
  response: Response,
  onProgress: ((loaded: number, total?: number) => void) | undefined,
  total: number | undefined,
): Promise<ArrayBuffer> {
  if (!response.body || typeof onProgress !== "function") {
    return response.arrayBuffer();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
  } finally {
    reader.releaseLock();
  }

  // Reassemble chunks.
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

let nextRefererRuleId = 1;

/**
 * Run `fetch`-ish work with a `Referer` header injected on every request to the
 * target URL's host, then tear the rule down. MV3 forbids setting `Referer` on
 * `fetch()` directly, so we rely on a declarativeNetRequest `modifyHeaders`
 * rule (the same mechanism Zotero's connector uses for anti-leech downloads).
 *
 * Scoped to the target host (not the exact single-use order URL) so a 302 to a
 * sibling bar.cnki.net file endpoint still carries the Referer. The rule is
 * short-lived — added before the fetch, removed in `finally`.
 *
 * The whole add→fetch→remove critical section runs under `withDownloadMutex`
 * so that concurrent eager downloads (two papers imported back-to-back) never
 * hold overlapping `modifyHeaders` rules on the same host — which would produce
 * an indeterminate Referer. Tab-relay fetches don't reach here, so the ones
 * that genuinely need the tab alive still run in parallel.
 */
async function withRefererRule<T>(
  url: string,
  referer: string | null,
  run: () => Promise<T>,
): Promise<T> {
  // Store-distributable builds (MW_EXT_STORE=1) ship without declarativeNetRequest
  // permission and without Referer rewriting - the cross-origin anti-leech PDF
  // path degrades to a plain credentialed fetch. See extension-store-release.md (P0-2).
  if (!STORE_DNR_REFERER) {
    return run();
  }
  const dnr = chrome.declarativeNetRequest;
  let requestDomain: string | null = null;
  try {
    requestDomain = new URL(url).hostname;
  } catch {
    requestDomain = null;
  }

  if (!referer || !requestDomain || !dnr?.updateDynamicRules) {
    return run();
  }

  return withDownloadMutex(async () => {
    const ruleId = nextRefererRuleId++;
    let ruleAdded = false;
    try {
      await dnr.updateDynamicRules({
        removeRuleIds: [ruleId],
        addRules: [
          {
            id: ruleId,
            priority: 1,
            action: {
              type: "modifyHeaders",
              requestHeaders: [{ header: "Referer", operation: "set", value: referer }],
            },
            condition: {
              requestDomains: [requestDomain],
              resourceTypes: ["xmlhttprequest", "other"],
            },
          },
        ],
      });
      ruleAdded = true;
      debugLog("background", "refererRule:set", { ruleId, requestDomain, referer });
    } catch (error) {
      // Best-effort: fetch anyway (some sites don't gate on Referer) rather than fail.
      debugError("background", "refererRule:set-failed", { ruleId, requestDomain }, error);
    }

    try {
      return await run();
    } finally {
      if (ruleAdded) {
        try {
          await dnr.updateDynamicRules({ removeRuleIds: [ruleId] });
        } catch (error) {
          debugError("background", "refererRule:cleanup-failed", { ruleId }, error);
        }
      }
    }
  });
}

/** Drop every dynamic rule; we only ever hold transient per-download rules. */
async function clearDynamicRules(): Promise<void> {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr?.getDynamicRules) return;
  try {
    const rules = await dnr.getDynamicRules();
    if (rules.length) {
      await dnr.updateDynamicRules({ removeRuleIds: rules.map((rule) => rule.id) });
      debugLog("background", "clearDynamicRules", { removed: rules.length });
    }
  } catch (error) {
    debugError("background", "clearDynamicRules:failed", error);
  }
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Serial upload queue + eager acquire + DNR download mutex

/** Serial chain — at most one upload/backend-handoff runs at a time. */
let uploadChain: Promise<void> = Promise.resolve();

/**
 * Serializes the DNR-referer critical section (see withRefererRule): concurrent
 * eager downloads to the same host must not fight over `modifyHeaders` rules.
 * Only the DNR-direct path takes this lock; tab-relay fetches (which don't touch
 * DNR and are the ones that need the tab alive) run freely in parallel.
 */
let dnrChain: Promise<unknown> = Promise.resolve();

function withDownloadMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = dnrChain.then(fn, fn);
  dnrChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Ids the user cancelled while queued — checked before an upload slot runs. */
const cancelledCaptures = new Set<string>();

// 导入日志：插件端步骤事件缓冲。事件先在内存里攒着（捕获阶段还没有服务端
// 票据），拿到 session/origin token 后整体 flush 到 /api/import/plugin/
// report-event。上报失败静默丢弃——观测绝不影响导入主流程。

const MAX_BUFFERED_EVENTS = 50;
const captureEventBuffers = new Map<string, PluginImportEventItem[]>();

function pushCaptureEvent(
  captureId: string,
  event: Omit<PluginImportEventItem, "occurredAt">,
): void {
  let buffer = captureEventBuffers.get(captureId);
  if (!buffer) {
    buffer = [];
    captureEventBuffers.set(captureId, buffer);
  }
  if (buffer.length >= MAX_BUFFERED_EVENTS) return;
  buffer.push({ ...event, occurredAt: new Date().toISOString() });
}

/** Flush buffered events once a ticket exists. Sent events are dropped. */
async function flushCaptureEvents(record: CaptureRecord, token: string): Promise<void> {
  const events = captureEventBuffers.get(record.captureId);
  if (!events?.length) return;
  captureEventBuffers.delete(record.captureId);
  await reportPluginEvents({
    apiBaseUrl: record.apiBaseUrl,
    token,
    sourceId: record.sourceId,
    events,
  });
}

/**
 * Manual capture entrypoint. Registers the task, kicks off the eager acquire
 * (which needs the source tab alive), then hands the resolved payload to the
 * serial upload queue. Returns immediately so the popup can close.
 */
/**
 * Import entry point. Registers the queue row IMMEDIATELY (so the user sees
 * the task and can close the popup / leave the tab right away), then drives
 * the in-page read from the service worker — the capture result flows
 * tab → SW, never through the popup, whose lifetime ends the moment the user
 * clicks elsewhere.
 */
async function beginCapture(
  message: { tabId: number | null; teamId: string | null; teamName?: string | null },
  senderTabId: number | null,
): Promise<{ captureId: string } | { message: string }> {
  const pairing = await getPairing();
  if (!pairing) {
    throw new Error("请先在 MangoWrite 网页端点击「连接浏览器插件」完成登录，再导入。");
  }
  const tabId = message.tabId ?? senderTabId;
  if (tabId == null) throw new Error("没有找到当前标签页");

  let tabUrl = "";
  let tabTitle: string | null = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    tabUrl = tab?.url ?? "";
    tabTitle = tab?.title ?? null;
  } catch (error) {
    debugLog("background", "beginCapture:tab-gone", tabId, error);
  }
  // The content script's canonical URL (reported on page load) is the better
  // queue identity; the raw tab URL is the fallback for tabs it never saw.
  const originUrl =
    recognizedByTab.get(tabId)?.originUrl?.trim() || sanitizeOriginUrl(tabUrl);
  if (!originUrl) throw new Error("没有找到当前标签页");

  // 补全/更正回路：这个标签正在参与某条文献的题录更新任务——「导入」接入
  // 更新任务，绝不另建条目（线上事故：用户在详情页点了普通导入，给同一篇
  // 文献建出 metadata-only 重复条）。识别到论文就落确认卡；认不出说明还在
  // 检索页，把下一步说清楚，不制造一条跑偏的队列记录。
  const completionTask = findCompletionTaskByTab(tabId);
  if (completionTask && completionTask.status === "active") {
    const capture = await requestPageCapture(tabId).catch(() => null);
    if (capture?.recognized && capture.resolverSource.startsWith("plugin-dom")) {
      completionTask.pending = {
        metadata: capture.metadata,
        resolverSource: capture.resolverSource,
        originUrl: sanitizeOriginUrl(capture.originUrl),
        capturedTitle: captureTitle(capture),
      };
      await persistCompletionTasks();
      broadcastCompletions();
      return {
        message: `已识别页面题录，请在任务列表确认「更新《${completionTask.targetTitle ?? "目标文献"}》」。`,
      };
    }
    throw new Error(
      `该标签正在参与《${completionTask.targetTitle ?? "目标文献"}》的题录更新：请点开这篇文献的详情页完成更新；想普通导入请先在弹窗里取消该更新任务。`,
    );
  }

  // 同页重复点击：读取尚未完成时 identifier 还是 null，按 originUrl 就能去重。
  const key = captureKey(null, originUrl);
  for (const existing of captures.values()) {
    if (!existing.done && captureKey(existing.identifier, existing.originUrl) === key) {
      debugLog("background", "beginCapture:dedup-hit", key);
      return { message: "该文献已在导入队列中" };
    }
  }

  const captureId = crypto.randomUUID();
  debugLog("background", "beginCapture:start", { captureId, originUrl, tabId });
  const record: CaptureRecord = {
    captureId,
    apiBaseUrl: pairing.apiBaseUrl ?? getApiBaseUrl(),
    deviceToken: pairing.deviceToken,
    tabId,
    originUrl,
    identifier: null,
    sourceSite: siteLabel(originUrl),
    title: tabTitle?.trim() || originUrl,
    teamId: message.teamId,
    teamName: message.teamName ?? undefined,
    state: "acquiring",
    step: "capturing",
    progress: 5,
    detail: "正在读取页面…",
    done: false,
    retry: "none",
    attempt: 0,
    createdAt: Date.now(),
  };
  registerCapture(record);
  void captureFromTab(record, tabId);
  return { captureId };
}

/** 读取阶段硬上限：稳定性等待 ≤3s + 快照 ≤20s 时限 + 单抓取 10s 超时的总和之外。 */
const PAGE_READ_TIMEOUT_MS = 60_000;

/**
 * Ask the tab's content script for the capture. The await is held by this
 * service worker, so the popup dying mid-read changes nothing; the tab dying
 * (navigation/close) rejects the message channel and is surfaced as an
 * actionable failure on the queue card instead of a silent loss.
 */
async function captureFromTab(record: CaptureRecord, tabId: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = chrome.tabs.sendMessage(tabId, { type: "mango-write/capture-page-context" });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("读取页面超时")), PAGE_READ_TIMEOUT_MS);
    });
    const response = await Promise.race([read, timeout]);
    if (!response || typeof response !== "object") {
      throw new Error("页面读取无响应");
    }
    if ("error" in response) {
      throw new Error(String((response as { error: unknown }).error));
    }
    handleCapturedPage(record, tabId, response as CaptureResult);
  } catch (error) {
    if (cancelledCaptures.has(record.captureId)) return;
    const text = errText(error);
    // 两种失败形态分开说：「从一开始就不在场」（内置页、页面崩溃）与
    // 「读着读着页面没了」（导航/关闭）——后者是用户中途离开造成的。
    if (/Receiving end does not exist/i.test(text)) {
      failCapture(record, { kind: "page-unreachable", raw: text }, "none");
    } else if (/message port closed/i.test(text)) {
      failCapture(record, { kind: "page-interrupted", raw: text }, "manual-reimport");
    } else if (text === "读取页面超时") {
      failCapture(record, { kind: "read-timeout" }, "manual-reimport");
    } else {
      failCapture(record, { kind: "read-failed", raw: text || undefined }, "manual-reimport");
    }
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

/**
 * The in-page read finished while the row was already visible in the queue.
 * Recognized papers proceed straight into acquire/upload (the popup is not
 * involved); unrecognized pages park as `confirm` rows awaiting the user's
 * explicit webpage-import choice on the card.
 */
function handleCapturedPage(record: CaptureRecord, tabId: number, capture: CaptureResult): void {
  if (cancelledCaptures.has(record.captureId)) {
    removeCapture(record.captureId);
    return;
  }
  const key = captureKey(capture.identifier, capture.originUrl);
  for (const existing of captures.values()) {
    if (
      existing.captureId !== record.captureId &&
      !existing.done &&
      captureKey(existing.identifier, existing.originUrl) === key
    ) {
      debugLog("background", "handleCapturedPage:dedup-hit", key);
      removeCapture(record.captureId);
      return;
    }
  }

  updateCapture(record, {
    title: capture.title?.trim() || record.title,
    identifier: capture.identifier ?? record.identifier,
  });

  if (!capture.recognized) {
    pendingWebpageCaptures.set(record.captureId, capture);
    // Terminal-but-actionable like `conflict`: the row waits for the user's
    // choice on the card. The held snapshot lives only in this worker's heap.
    updateCapture(record, {
      state: "confirm",
      step: "capturing",
      done: true,
      progress: 30,
      detail: "未识别到文献信息，确认后按网页导入",
    });
    return;
  }

  pushCaptureEvent(record.captureId, {
    step: "capture.start",
    status: "info",
    detail: {
      originUrl: capture.originUrl,
      identifier: capture.identifier,
      resolverSource: capture.resolverSource,
      attachments: capture.attachments.length,
      hasMetadata: Object.keys(capture.metadata ?? {}).length > 0,
      pageHtmlKind: capture.pageHtmlKind,
    },
  });
  void acquireThenEnqueue(record, capture, tabId);
}

/** User confirmed a `confirm` row: import the held snapshot as a webpage. */
function confirmWebpageCapture(captureId: string): void {
  const record = captures.get(captureId);
  const capture = pendingWebpageCaptures.get(captureId);
  if (!record || record.state !== "confirm") return;
  if (!capture) {
    // Worker restart emptied the held-snapshot map — the row can't proceed.
    failCapture(record, { kind: "snapshot-stale" }, "manual-reimport");
    return;
  }
  pendingWebpageCaptures.delete(captureId);
  record.state = "acquiring";
  record.done = false;
  record.detail = undefined;
  record.message = undefined;
  afterCaptureChange();
  pushCaptureEvent(captureId, {
    step: "capture.start",
    status: "info",
    detail: { originUrl: capture.originUrl, webpage: true, pageHtmlKind: capture.pageHtmlKind },
  });
  void acquireThenEnqueue(record, capture, record.tabId);
}

async function acquireThenEnqueue(
  record: CaptureRecord,
  capture: CaptureResult,
  tabId: number | null,
): Promise<void> {
  // Before downloading the file, query OpenAlex from the user's IP for
  // English-track DOI works. The server then skips its own OpenAlex fallback
  // (resolverSource="plugin-openalex"), spreading the OpenAlex budget across
  // user IPs instead of burning the server's $1/day pool. Only on begin-capture
  // (user-triggered) + English track + has DOI - never on fetch-origin
  // (server-dispatched) or Chinese track (DOI untrusted, D1).
  const openAlexSkipped = await enrichCaptureWithOpenAlex(capture);
  if (openAlexSkipped) {
    // 题录已齐全：不查 OpenAlex，也让服务端跳过它的计量池 fallback（省额度）。
    pushCaptureEvent(record.captureId, {
      step: "metadata.enrich",
      status: "info",
      reason: "bib-core-complete",
      detail: { originUrl: capture.originUrl, skipEnrichSources: ["openalex"] },
    });
  }

  let payload: AcquiredPayload | null;
  try {
    payload = await acquirePayload(record, capture, tabId, openAlexSkipped ? ["openalex"] : undefined);
  } catch (error) {
    debugError("background", "acquirePayload:unexpected", record.captureId, error);
    failCapture(record, { kind: classifyFailure(error), raw: errText(error) || undefined }, "manual-reimport");
    return;
  }

  if (cancelledCaptures.has(record.captureId)) {
    removeCapture(record.captureId);
    return;
  }
  if (!payload) return; // acquirePayload already terminated the record

  record.payload = payload;
  enqueueUpload(record);
}

/**
 * Query OpenAlex from the user's browser and merge the result into the capture
 * metadata. Only fires for English-track captures with a DOI - the Chinese
 * track's DOI is untrusted (D1) and the DOM scrape already has 卷期页 the API
 * lacks. Fills only missing fields (DOM values win); stamps resolverSource=
 * "plugin-openalex" so the server knows to skip its own OpenAlex fallback.
 *
 * Returns true when the lookup was skipped because the DOM scrape already
 * carries a complete bib-core — the caller then sends skipEnrichSources so the
 * server skips its fallback too.
 *
 * Never throws - a failed lookup leaves the capture unchanged and the server
 * falls back to its own OpenAlex.
 */
async function enrichCaptureWithOpenAlex(capture: CaptureResult): Promise<boolean> {
  if (capture.resolverSource !== "plugin-dom-en") return false;

  const doi = extractDoiFromCapture(capture);
  if (!doi) return false;

  // 不查 OpenAlex 只在六字段齐全时发生；issue 故意不要求——大量期刊本就无
  // 期号，把它算进「齐全」等于永不跳过。
  if (hasCompleteBibCore(capture.metadata as Record<string, unknown>)) return true;

  let openalex: Awaited<ReturnType<typeof lookupOpenAlexByDoi>>;
  try {
    openalex = await lookupOpenAlexByDoi(doi);
  } catch (error) {
    debugError("background", "enrichCaptureWithOpenAlex:lookup-failed", doi, error);
    return false;
  }
  if (!openalex) {
    debugLog("background", "enrichCaptureWithOpenAlex:no-result", doi);
    return false;
  }

  // Field-level merge: only fill fields the DOM scrape didn't capture. The
  // server's mergeCsl will re-arbitrate with proper provenance, but filling
  // gaps here means the upload carries the OpenAlex data in one shot.
  const metadata = capture.metadata as Record<string, unknown>;
  for (const [field, value] of Object.entries(openalex)) {
    if (value === undefined || value === null) continue;
    const existing = metadata[field];
    if (existing === undefined || existing === null || existing === "") {
      metadata[field] = value;
    }
  }

  capture.resolverSource = "plugin-openalex";
  debugLog("background", "enrichCaptureWithOpenAlex:merged", doi, {
    openalexFields: Object.keys(openalex),
  });
  return false;
}

/**
 * bib-core 是否齐全（title/刊名/作者/年/卷/页，缺一即不齐）。保守判定：
 * 误判「齐全」会漏掉一次免费补全，比多查一次 OpenAlex 代价高。
 */
function hasCompleteBibCore(metadata: Record<string, unknown>): boolean {
  const nonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.trim() !== "";
  if (!nonEmptyString(metadata["title"])) return false;
  if (!nonEmptyString(metadata["container-title"])) return false;
  const author = metadata["author"];
  if (!(Array.isArray(author) ? author.length > 0 : nonEmptyString(author))) return false;
  const dateParts = (metadata["issued"] as { "date-parts"?: unknown } | undefined)?.["date-parts"];
  if (!Array.isArray(dateParts) || !Array.isArray(dateParts[0]) || dateParts[0].length === 0) {
    return false;
  }
  const volume = metadata["volume"];
  if (!((typeof volume === "string" || typeof volume === "number") && String(volume).trim() !== "")) {
    return false;
  }
  return nonEmptyString(metadata["page"]);
}

/** Extract a clean DOI string from the capture's identifier or metadata. */
function extractDoiFromCapture(capture: CaptureResult): string | null {
  const metaDoi = capture.metadata?.["DOI"];
  if (typeof metaDoi === "string" && metaDoi.trim()) {
    return metaDoi.trim();
  }
  // The identifier field may be the bare DOI or "doi:..." prefixed.
  const id = capture.identifier?.trim();
  if (!id) return null;
  const match = id.match(/^(?:doi:)?(10\.\d{4,}(?:\.\d+)*\/\S+)$/i);
  return match?.[1] ?? null;
}

/**
 * Direct-PDF import: the active tab is itself a PDF (Chrome's native viewer, so
 * no content script ran and no translator produced a capture). We fetch the tab
 * URL's bytes, confirm they're actually a PDF, and enqueue an upload with no
 * metadata — the server resolves the record from the PDF's own text/DOI. A
 * local file:// PDF takes the same path: bytes read from disk (needs the user's
 * "Allow access to file URLs" grant), imported as a file upload rather than a
 * webpage snapshot of the viewer shell.
 */
async function runPdfUrlImport(input: {
  url: string;
  title: string | null;
  tabId: number | null;
  teamId: string | null;
  teamName: string | null;
}): Promise<{ captureId: string } | { message: string }> {
  const pairing = await getPairing();
  if (!pairing) {
    throw new Error("请先在 MangoWrite 网页端点击「连接浏览器插件」完成登录，再导入。");
  }

  const originUrl = sanitizeOriginUrl(input.url);
  const isLocalFile = /^file:/i.test(originUrl);

  // Dedup against anything already in flight (identity falls back to originUrl
  // when there's no identifier — matches captureKey's behavior).
  const key = captureKey(null, originUrl);
  for (const existing of captures.values()) {
    if (!existing.done && captureKey(existing.identifier, existing.originUrl) === key) {
      debugLog("background", "runPdfUrlImport:dedup-hit", key);
      return { message: "该文献已在导入队列中" };
    }
  }

  const captureId = crypto.randomUUID();
  debugLog("background", "runPdfUrlImport:start", { captureId, originUrl, tabId: input.tabId });

  // Chrome titles a local PDF tab with the encoded URL — a tab title like that
  // would name the queue card (and the upload fallback) with percent soup. The
  // decoded basename is the name the user gave the file; prefer it.
  const localName = isLocalFile ? localFileBaseName(originUrl) : null;

  const record: CaptureRecord = {
    captureId,
    apiBaseUrl: pairing.apiBaseUrl ?? getApiBaseUrl(),
    deviceToken: pairing.deviceToken,
    tabId: input.tabId,
    originUrl,
    identifier: null,
    sourceSite: siteLabel(originUrl),
    title: localName?.replace(/\.pdf$/i, "") || input.title?.trim() || originUrl,
    teamId: input.teamId,
    teamName: input.teamName ?? undefined,
    state: "acquiring",
    step: "downloading",
    progress: 10,
    done: false,
    retry: "none",
    attempt: 0,
    createdAt: Date.now(),
  };
  registerCapture(record);

  void acquirePdfBytesThenEnqueue(record, input.url);
  return { captureId };
}

/**
 * Last path segment of a file:// URL, percent-decoded — the human name the user
 * gave the file (Windows download folders put CJK names there). Returns null
 * for URLs without a last segment; decode failures keep the raw segment.
 */
function localFileBaseName(url: string): string | null {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    if (!last) return null;
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  } catch {
    return null;
  }
}

/**
 * Whether the user granted this extension "Allow access to file URLs" — without
 * it neither content scripts nor service-worker fetches can read file://. Falls
 * back to true (treat as allowed) when the API is missing so the generic
 * failure copy, not the toggle guidance, is shown.
 */
function isFileSchemeAccessAllowed(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.extension.isAllowedFileSchemeAccess((allowed) => resolve(Boolean(allowed)));
    } catch {
      resolve(true);
    }
  });
}

async function acquirePdfBytesThenEnqueue(record: CaptureRecord, pdfUrl: string): Promise<void> {
  updateCapture(record, { state: "acquiring", step: "downloading", progress: 25, detail: "正在下载 PDF…" });

  // A native-viewer PDF tab has no content script to relay through, so go
  // straight to a direct fetch with the page itself as Referer (some hosts gate
  // the bytes on it). Extension host permissions bypass CORS for the read.
  // 同样过 per-host 限速，与其他抓取路径共用同一个限速器。
  const fetchBytes = wrapByteFetcher((url, onProgress) => fetchBytesDirect(url, url, onProgress));
  let fetched: Awaited<ReturnType<typeof fetchBytesDirect>>;
  try {
    fetched = await fetchBytes(pdfUrl, (loaded, total) => {
      updateCapture(record, { detail: formatByteProgress(loaded, total) });
    });
  } catch (error) {
    debugError("background", "acquirePdfBytesThenEnqueue:fetch-error", record.captureId, error);
    failCapture(record, { kind: classifyFailure(error), raw: errText(error) || undefined }, "manual-reimport");
    return;
  }

  if (cancelledCaptures.has(record.captureId)) {
    removeCapture(record.captureId);
    return;
  }

  if (!fetched || !fetched.bytes.byteLength) {
    // A file:// read fails outright unless the user granted the extension
    // "Allow access to file URLs" — say exactly that instead of a generic
    // download error; with the grant, a miss means the file moved/renamed.
    if (/^file:/i.test(record.originUrl)) {
      const allowed = await isFileSchemeAccessAllowed();
      failCapture(record, { kind: allowed ? "local-file-moved" : "file-access-denied" }, "manual-reimport");
      return;
    }
    failCapture(record, { kind: "pdf-unavailable" }, "manual-reimport");
    return;
  }
  if (!looksLikePdfBytes(fetched.bytes)) {
    // HTML login/paywall page served at a .pdf URL, a chrome:// page, etc.
    failCapture(record, { kind: "not-pdf" }, "none");
    return;
  }

  record.payload = {
    file: {
      bytes: fetched.bytes,
      filename: resolvePdfFilename(pdfUrl, fetched.contentDisposition, record.title ?? "document"),
      mime: "application/pdf",
    },
    pageHtml: null,
    metadata: null,
    resolverSource: "plugin-pdf-direct",
    identifier: null,
    originUrl: record.originUrl,
  };
  enqueueUpload(record);
}

/**
 * Eager acquire (the tab-dependent half of the old executeManualCapture): pull
 * full-text bytes now, while the source tab is alive/logged in. Returns the
 * resolved payload, or null after terminating the record on a hard failure.
 */
async function acquirePayload(
  record: CaptureRecord,
  capture: CaptureResult,
  tabId: number | null,
  skipEnrichSources?: string[],
): Promise<AcquiredPayload | null> {
  const fetchBytes = makeByteFetcher(
    tabId,
    capture.originUrl,
    proxyMappingFromPage(capture.originUrl, capture.pageHtml ?? ""),
  );

  // 下载前的严格去重预检：库里已有这篇且已带文件，就别再花一次全文下载，
  // 直接走题录导入（服务端去重命中、合并 work 题录并重链）。任何拿不准——
  // 预检失败、无身份、命中条目还是纯题录——都照旧下载：宁可多下一次，
  // 不能挡导入，也不能让缺文件的条目永远补不上原文。
  const hasMetadata = Object.keys(capture.metadata ?? {}).length > 0;
  if (hasMetadata || capture.identifier) {
    try {
      const check = await checkLibraryDuplicate({
        apiBaseUrl: record.apiBaseUrl,
        deviceToken: record.deviceToken,
        metadata: (capture.metadata ?? {}) as Record<string, unknown>,
        identifier: capture.identifier,
      });
      if (check.inLibrary && check.hasContent) {
        debugLog("background", "acquirePayload:duplicate-precheck-hit", {
          captureId: record.captureId,
          originUrl: capture.originUrl,
        });
        pushCaptureEvent(record.captureId, {
          step: "duplicate.precheck",
          status: "info",
          reason: "in-library-has-content",
          detail: { skipped: "download" },
        });
        updateCapture(record, { state: "acquiring", step: "uploading", progress: 45, detail: "库里已有，跳过下载…" });
        return {
          file: null,
          gate: null,
          pageHtml: null,
          metadata: hasMetadata ? capture.metadata : null,
          resolverSource: capture.resolverSource,
          identifier: capture.identifier,
          originUrl: capture.originUrl,
          skipEnrichSources,
        };
      }
    } catch (error) {
      debugError("background", "acquirePayload:duplicate-precheck-failed", record.captureId, error);
    }
  }

  updateCapture(record, { state: "acquiring", step: "downloading", progress: 25, detail: "正在下载全文…" });
  const attempt = await downloadFirstAttachment(capture, fetchBytes, (loaded, total) => {
    updateCapture(record, { detail: formatByteProgress(loaded, total) });
  });
  let file = attempt.file;
  let gate = attempt.gate;
  debugLog("background", "acquirePayload:attachment", file ? { filename: file.filename, mime: file.mime } : { gate, failures: attempt.failures });
  pushCaptureEvent(record.captureId, {
    step: "pdf.attachment",
    status: file ? "ok" : gate ? "failed" : "info",
    reason: file ? undefined : gate ? `gated-${gate}` : "no-attachment",
    detail: file
      ? { filename: file.filename, mime: file.mime }
      : attempt.failures.length
        ? { attempts: attempt.failures.slice(0, 3) }
        : undefined,
  });

  if (!file && capture.allowGenericPdfDiscovery) {
    updateCapture(record, { step: "downloading", progress: 40, detail: "正在寻找可下载的 PDF…" });
    // 本地规则命中就不再 mint 服务端票据；0 候选才 mint 并回落服务端规则
    // （服务端永远最新）。upload 阶段本来就自己重新 mint，不受影响。
    let token = "";
    const localCandidates = extractLocalPdfCandidates({
      pageUrl: capture.originUrl,
      html: capture.pageHtml,
    });
    if (localCandidates.length === 0) {
      try {
        token = (await requestPluginSession(record.apiBaseUrl, record.deviceToken)).token;
      } catch (error) {
        handleSessionError(record, error);
        return null;
      }
    }
    const discovery = await fetchBestPdf({
      apiBaseUrl: record.apiBaseUrl,
      token,
      localCandidates,
      snapshot: capture,
      fetchBytes,
    });
    file = discovery.file;
    debugLog("background", "acquirePayload:generic-pdf", file ? { filename: file.filename, mime: file.mime } : { failures: discovery.failures });
    pushCaptureEvent(record.captureId, {
      step: "pdf.discovery",
      status: file ? "ok" : "failed",
      reason: file ? undefined : "no-pdf-candidate",
      detail: file
        ? { filename: file.filename, mime: file.mime }
        : discovery.failures.length
          ? { attempts: discovery.failures.slice(0, 3) }
          : undefined,
    });
  }

  // Raw-HTML snapshot fallback, but never of a gate: if the tab is showing a
  // login wall or an anti-bot challenge, snapshotting it would file that page as
  // the paper's content. Better a metadata-only entry the user can fill in.
  const rawHtml = !file && capture.allowRawHtmlFallback ? capture.pageHtml : null;
  const rawHtmlGate = rawHtml ? detectGate(rawHtml) : null;
  const pageHtml = rawHtmlGate ? null : rawHtml;
  gate ??= rawHtmlGate;

  if (!file && !pageHtml && !capture.identifier && !hasMetadata) {
    pushCaptureEvent(record.captureId, {
      step: "capture.failed",
      status: "failed",
      reason: gate ? `gated-${gate}` : "nothing-to-import",
      detail: { originUrl: capture.originUrl },
    });
    failCapture(
      record,
      gate ? { kind: gateFailureKind(gate) } : { kind: "nothing-to-import" },
      gate ? "manual-reimport" : "none",
    );
    return null;
  }

  return {
    file,
    gate,
    pageHtml,
    metadata: hasMetadata ? capture.metadata : null,
    resolverSource: capture.resolverSource,
    identifier: capture.identifier,
    originUrl: capture.originUrl,
    skipEnrichSources,
  };
}

/** Chain a task onto the serial upload queue. */
function enqueueUpload(record: CaptureRecord): void {
  updateCapture(record, { state: "queued", step: "uploading", progress: 55, detail: undefined });
  uploadChain = uploadChain
    .then(() => runUpload(record))
    .catch((error) => debugError("background", "uploadChain:swallowed", record.captureId, error));
}

/**
 * Serial upload — the tab-independent half. Uses the device token (not the tab),
 * so it's safe long after the source tab closed. Requests a fresh session per
 * attempt so a queued task that waited past ticket expiry still works.
 */
async function runUpload(record: CaptureRecord): Promise<void> {
  if (cancelledCaptures.has(record.captureId)) {
    removeCapture(record.captureId);
    return;
  }
  const payload = record.payload;
  if (!payload) {
    // Bytes lost (service worker was hard-killed mid-queue). Can't resume.
    failCapture(record, { kind: "browser-interrupted" }, "manual-reimport");
    return;
  }

  updateCapture(record, { state: "uploading", step: "uploading", progress: 70, detail: "正在上传到 MangoWrite…" });
  try {
    const response = await withRetry(record, async () => {
      const session = await requestPluginSession(record.apiBaseUrl, record.deviceToken);
      await flushCaptureEvents(record, session.token);
      return uploadPluginCapture({
        apiBaseUrl: record.apiBaseUrl,
        token: session.token,
        identifier: payload.identifier,
        originUrl: payload.originUrl,
        metadata: payload.metadata,
        resolverSource: payload.resolverSource,
        file: payload.file,
        pageHtml: payload.pageHtml,
        skipEnrichSources: payload.skipEnrichSources,
        // Webpage captures key their title off this; paper captures let the
        // server resolve the title from metadata/PDF instead.
        title: record.title ?? null,
        replaceSourceId: record.replaceSourceId ?? null,
        teamId: record.teamId ?? null,
        // 全文被墙挡住的降级捕获把信号带给服务端：条目留个人库、不进团队。
        attachmentGate: payload.file ? null : payload.gate ?? null,
      });
    });
    record.sourceId = response.sourceId;
    pushCaptureEvent(record.captureId, {
      step: "plugin.upload",
      status: "ok",
      detail: {
        sourceId: response.sourceId,
        uploadedFile: response.uploadedFile ?? false,
        alreadyInLibrary: response.alreadyInLibrary ?? false,
        needsReplaceConfirm: response.needsReplaceConfirm ?? false,
      },
    });
    if (response.needsReplaceConfirm) {
      // Same paper already in the library with a *different* PDF. The server kept
      // the existing file; ask the user before replacing + re-parsing.
      conflictCapture(record);
      return;
    }
    const alreadyInLibrary = response.alreadyInLibrary === true;
    // 落成形态：PDF / HTML 全文 > 网页快照 > 仅题录。仅题录不算完整的
    // 导入成功，popup 以警示样式展示（见 protocol.ts CaptureResultKind）。
    const resultKind: CaptureResultKind = payload.file
      ? /html/i.test(payload.file.mime)
        ? "html"
        : "pdf"
      : payload.pageHtml
        ? "webpage"
        : "metadata-only";
    let message = buildCompletionMessage(payload.file, payload.pageHtml, alreadyInLibrary, payload.gate);
    if (response.teamSkipped && record.teamId) {
      // 用户指定的团队目标没达成（服务端保留了个人条目、未分享），必须说出来。
      message += "本次未加入团队文库；取得全文后可在文库中再分享。";
    }
    // 完成卡的「在文库中查看」深链：此刻 sourceId、实际落库空间、环境 origin
    // 三样事实齐了，算一次存进记录，popup 只负责打开。
    record.libraryUrl = buildLibraryUrl(record, response);
    completeCapture(record, message, { alreadyInLibrary, resultKind });
    // 仅题录不是完整的导入成功（含「已在库中但只有题录」）：popup 可能已
    // 关闭，补一条系统通知保证用户看到。
    if (resultKind === "metadata-only") {
      void showMetadataOnlyNotification(record);
    }
    // 上传用的票据已被消费；补一张新票据把 upload 结果事件冲掉（失败静默）。
    try {
      const session = await requestPluginSession(record.apiBaseUrl, record.deviceToken);
      await flushCaptureEvents(record, session.token);
    } catch {
      captureEventBuffers.delete(record.captureId);
    }
  } catch (error) {
    pushCaptureEvent(record.captureId, {
      step: "plugin.upload",
      status: "failed",
      reason: errText(error).slice(0, 120) || "upload_failed",
    });
    // 尽力 flush：upload 失败时手头通常还能再取一张票据；取不到就丢。
    try {
      const session = await requestPluginSession(record.apiBaseUrl, record.deviceToken);
      await flushCaptureEvents(record, session.token);
    } catch {
      captureEventBuffers.delete(record.captureId);
    }
    if (error instanceof Error && error.message.includes("吊销")) {
      await clearPairing();
      failCapture(record, { kind: "auth-revoked", raw: errText(error) }, "manual-reimport");
      return;
    }
    // Bytes are still in hand — offer a cheap re-upload.
    failCapture(record, { kind: classifyFailure(error), raw: errText(error) || undefined }, "manual-upload");
  }
}

/** Requesting a session ticket failed during acquire. */
function handleSessionError(record: CaptureRecord, error: unknown): void {
  if (error instanceof Error && error.message.includes("吊销")) {
    void clearPairing();
    failCapture(record, { kind: "auth-revoked", raw: errText(error) }, "manual-reimport");
    return;
  }
  failCapture(record, { kind: classifyFailure(error), raw: errText(error) || undefined }, "manual-reimport");
}

/** 团队目标达成走团队路由，否则个人文库；web 路由见 apps/web router。 */
function buildLibraryUrl(
  record: CaptureRecord,
  response: { sourceId: string; teamSkipped?: "gated-fulltext" },
): string | null {
  try {
    const base = new URL(record.apiBaseUrl).origin;
    // 深链直读阅读页（/read/:sourceId，与文库列表点开文献同一条路）。
    // 旧值 /library/:sourceId 是列表聚焦高亮，用户反馈「跳过去还要再找一次」。
    return record.teamId && !response.teamSkipped
      ? `${base}/t/${record.teamId}/read/${response.sourceId}`
      : `${base}/u/read/${response.sourceId}`;
  } catch (error) {
    debugError("background", "buildLibraryUrl:failed", record.apiBaseUrl, error);
    return null;
  }
}

const MAX_AUTO_RETRIES = 2;

/**
 * Retry `fn` on transient errors (network / 5xx / 429) with exponential backoff,
 * surfacing an "auto-retrying" detail on the record. Permanent errors and the
 * final attempt rethrow. (Decision 4.)
 */
async function withRetry<T>(record: CaptureRecord, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_AUTO_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === MAX_AUTO_RETRIES) throw error;
      record.attempt = attempt + 1;
      updateCapture(record, { detail: `网络异常，正在自动重试（第 ${attempt + 1} 次）…` });
      await sleep(800 * 2 ** attempt);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

// Task actions from the popup/panel: retry, reimport, cancel, dismiss

/** Re-enqueue an upload-phase failure (bytes still in hand). */
function retryCapture(captureId: string): void {
  const record = captures.get(captureId);
  if (!record || !record.done) return;
  if (record.retry === "manual-upload" && record.payload) {
    record.failure = undefined;
    record.error = undefined;
    record.done = false;
    record.attempt = 0;
    enqueueUpload(record);
    return;
  }
  // 档位说要重传但字节已不在（payload 丢失的未来路径兜底）：当场把档位修
  // 成可执行的并广播，UI 换上「跳转原页面重试」——不给静默 no-op。
  if (record.retry === "manual-upload") {
    failCapture(record, record.failure ?? { kind: "browser-interrupted" }, "manual-reimport");
  }
}

/**
 * User confirmed a different-file conflict: re-upload the captured bytes with
 * `replaceSourceId` so the server overwrites the existing source's PDF and
 * re-parses. Bytes lost while the row waited (worker killed) → downgrade the
 * row to a reimport failure so the popup swaps the dead 更新 button out.
 */
function confirmReplaceCapture(captureId: string): void {
  const record = captures.get(captureId);
  if (!record || record.state !== "conflict") return;
  if (!record.payload || !record.sourceId) {
    failCapture(record, { kind: "browser-interrupted" }, "manual-reimport");
    return;
  }
  record.replaceSourceId = record.sourceId;
  record.failure = undefined;
  record.error = undefined;
  record.message = undefined;
  record.done = false;
  record.attempt = 0;
  enqueueUpload(record);
}

/** Download-phase failure: reopen the origin page so the user can re-import. */
async function reimportCapture(captureId: string): Promise<void> {
  const record = captures.get(captureId);
  if (!record) return;
  try {
    await chrome.tabs.create({ url: record.originUrl });
  } catch (error) {
    debugError("background", "reimportCapture:tab-open-failed", captureId, error);
  }
  // A fresh import from the reopened page replaces this one; retire the stale row.
  removeCapture(captureId);
}

/** Cancel a task that hasn't finished uploading yet. */
function cancelCapture(captureId: string): void {
  const record = captures.get(captureId);
  if (!record) return;
  if (record.state === "uploading" || record.done) return; // too late / already terminal
  // 标记必须活到队列出队：runUpload 凭它跳过已取消的任务再自行清理。
  // removeCapture 会顺手清标记，所以这里只摘行——否则取消只是藏掉 UI 行，
  // 排队任务照常上传落库。
  cancelledCaptures.add(captureId);
  if (captures.delete(captureId)) afterCaptureChange();
}

/** Remove a terminal (completed/failed) row from the list. */
function dismissCapture(captureId: string): void {
  const record = captures.get(captureId);
  if (!record || !record.done) return;
  removeCapture(captureId);
}

/**
 * Download the first attachment that resolves, in preference order. Reports
 * whether every candidate was turned away by a gate (login wall / captcha /
 * error shell) so the completion message can tell the user to sign in and retry
 * rather than just "未取到原文".
 */
async function downloadFirstAttachment(
  capture: CaptureResult,
  fetchBytes: ByteFetcher,
  onProgress?: (loaded: number, total?: number) => void,
): Promise<{
  file: PdfFileAsset | null;
  gate: GateKind | null;
  failures: Array<{ url: string; reason: string }>;
}> {
  let gate: GateKind | null = null;
  const failures: Array<{ url: string; reason: string }> = [];
  for (const attachment of capture.attachments) {
    try {
      const result = await downloadAttachment(attachment, capture.title, fetchBytes, onProgress);
      if (result.file) return { file: result.file, gate: null, failures };
      gate ??= result.gate;
      if (!result.gate) {
        failures.push({ url: attachment.url ?? "", reason: result.reason ?? "no-file" });
      }
      debugLog("background", "downloadFirstAttachment:empty", attachment, { gate: result.gate });
    } catch (error) {
      // try the next candidate (login wall, expired id, network…)
      failures.push({ url: attachment.url ?? "", reason: errText(error).slice(0, 120) || "threw" });
      debugLog("background", "downloadFirstAttachment:skip", attachment, error);
    }
  }
  return { file: null, gate, failures };
}

// 模式 B：网页派活取原文
// 网页端经 externally_connectable 推来 {originUrl, token, sourceId}，插件自己
// 开出版商标签并盯它加载完成，然后向 content script 要快照、走 runOriginAssist
// 抓 PDF 回传。pending 表镜像到 chrome.storage.session：MV3 service worker 在
// 等待标签加载期间被杀后，唤醒仍能凭 onUpdated/onRemoved/alarm 续上或收尾。

interface PendingOriginFetch {
  token: string;
  sourceId: string;
  originUrl: string;
  createdAt: number;
}

const pendingOriginFetches = new Map<number, PendingOriginFetch>();
const PENDING_ORIGIN_KEY = "pendingOriginFetches";
/** 出版商页迟迟不 complete（挂在加载中 / 被人肉晾着）就放弃并回报。 */
const ORIGIN_FETCH_TAB_TIMEOUT_MS = 15 * 60 * 1000;

void restorePendingOriginFetches();

async function restorePendingOriginFetches(): Promise<void> {
  try {
    const stored = await chrome.storage.session?.get(PENDING_ORIGIN_KEY);
    const list =
      (stored?.[PENDING_ORIGIN_KEY] as Array<[number, PendingOriginFetch]> | undefined) ?? [];
    for (const [tabId, entry] of list) {
      pendingOriginFetches.set(tabId, entry);
    }
  } catch (error) {
    debugError("background", "restorePendingOriginFetches:failed", error);
  }
}

async function persistPendingOriginFetches(): Promise<void> {
  try {
    await chrome.storage.session?.set({
      [PENDING_ORIGIN_KEY]: Array.from(pendingOriginFetches.entries()),
    });
  } catch (error) {
    debugError("background", "persistPendingOriginFetches:failed", error);
  }
}

async function runFetchOriginDispatch(input: {
  originUrl: string;
  token: string;
  sourceId: string;
}): Promise<{ message: string }> {
  for (const entry of pendingOriginFetches.values()) {
    if (entry.sourceId === input.sourceId) {
      return { message: "该文献的取原文任务已在进行中。" };
    }
  }

  debugLog("background", "runFetchOriginDispatch:open-tab", {
    sourceId: input.sourceId,
    originUrl: input.originUrl,
  });
  const tab = await chrome.tabs.create({ url: input.originUrl, active: true });
  if (tab.id == null) {
    throw new Error("无法打开出版商页面");
  }
  pendingOriginFetches.set(tab.id, {
    token: input.token,
    sourceId: input.sourceId,
    originUrl: input.originUrl,
    createdAt: Date.now(),
  });
  await persistPendingOriginFetches();
  return { message: "已打开出版商页面，正在取原文…" };
}

async function runPendingOriginFetch(tabId: number): Promise<void> {
  const entry = pendingOriginFetches.get(tabId);
  if (!entry) return;
  pendingOriginFetches.delete(tabId);
  await persistPendingOriginFetches();

  // Ask for the full translator capture, not the bare snapshot: the translator
  // is the only thing that knows where CNKI/万方/维普 keep their PDF (a `pdfDown`
  // anchor, a per-site download route), and server-side publisher rules don't
  // cover those sites at all. Without it 取原文 answered "未找到可下载的 PDF" for
  // every Chinese source no matter how well the user had fixed their login —
  // which is exactly the retry path a gated import tells them to use.
  let capture: CaptureResult | null = null;
  let snapshot: OriginSnapshotResult;
  try {
    capture = await requestPageCapture(tabId);
    if (capture?.recognized) {
      snapshot = { title: capture.title, url: capture.originUrl, html: capture.pageHtml };
    } else {
      // No translator recognized the page (or an older content script): fall
      // back to the raw snapshot + server publisher rules, as before.
      capture = null;
      const response = (await chrome.tabs.sendMessage(tabId, {
        type: "mango-write/origin-snapshot",
      })) as OriginSnapshotResult | undefined;
      if (!response?.html) throw new Error("empty_snapshot");
      snapshot = response;
    }
  } catch (error) {
    debugError("background", "runPendingOriginFetch:snapshot-failed", entry, error);
    await reportPluginFailure({
      apiBaseUrl: getApiBaseUrl(),
      token: entry.token,
      reason: "page-unreadable",
      originUrl: entry.originUrl,
      sourceId: entry.sourceId,
    });
    return;
  }

  try {
    await runOriginAssist({
      token: entry.token,
      sourceId: entry.sourceId,
      capture,
      snapshot: {
        originUrl: sanitizeOriginUrl(snapshot.url || entry.originUrl),
        title: snapshot.title?.trim() || "Untitled article",
        identifier: null,
        pageHtml: snapshot.html,
      },
      tabId,
    });
  } catch {
    // runOriginAssist 失败前已 reportPluginFailure；这里没有人等响应，吞掉即可。
    debugLog("background", "runPendingOriginFetch:assist-failed", entry.sourceId);
  }
}

async function handleOriginTabRemoved(tabId: number): Promise<void> {
  const entry = pendingOriginFetches.get(tabId);
  if (!entry) return;
  pendingOriginFetches.delete(tabId);
  await persistPendingOriginFetches();
  debugLog("background", "handleOriginTabRemoved:closed-before-load", entry);
  await reportPluginFailure({
    apiBaseUrl: getApiBaseUrl(),
    token: entry.token,
    reason: "tab-closed",
    originUrl: entry.originUrl,
    sourceId: entry.sourceId,
  });
}

async function sweepStaleOriginFetches(): Promise<void> {
  const now = Date.now();
  for (const [tabId, entry] of Array.from(pendingOriginFetches.entries())) {
    if (now - entry.createdAt < ORIGIN_FETCH_TAB_TIMEOUT_MS) continue;
    pendingOriginFetches.delete(tabId);
    await persistPendingOriginFetches();
    debugLog("background", "sweepStaleOriginFetches:timeout", entry);
    await reportPluginFailure({
      apiBaseUrl: getApiBaseUrl(),
      token: entry.token,
      reason: "timeout",
      originUrl: entry.originUrl,
      sourceId: entry.sourceId,
    });
  }
}

// 补全/更正回路（#100 D1）：网页派活「更正文献信息」。
// 一条持久文献对象的题录更新任务：按 sourceId 登记（重复派发 = 刷新同一任务，
// 幂等），携带任务环境 apiBaseUrl 与目标题名快照。任务跨「受控搜索 → 详情
// 新标签 / 登录跳转」延续（tabs.onCreated 的 openerTabId 继承），绝不按同域
// 标签泛绑。详情页认出论文后先成确认卡等用户拍板；关联标签上的普通「导入」
// 也接入这个任务（beginCapture 路由），不另建条目。绝不后台爬虫、绝不轮询：
// 一切都发生在这个用户亲手打开的标签里。

/** 按 sourceId 登记的任务表；tabIds 是当前关联标签（可空 = 用户全关了）。 */
const completionTasks = new Map<string, CompletionTask>();
const COMPLETION_TASKS_KEY = "metadataCompletionTasks";
const COMPLETION_TASK_TIMEOUT_MS = 15 * 60 * 1000;

void restoreCompletionTasks();

async function restoreCompletionTasks(): Promise<void> {
  try {
    const stored = await chrome.storage.session?.get(COMPLETION_TASKS_KEY);
    const list =
      (stored?.[COMPLETION_TASKS_KEY] as CompletionTask[] | undefined) ?? [];
    for (const task of list) {
      if (!task?.sourceId) continue;
      // 终态任务不续跑（回填结果已通知过）。applying 是「提交已在途」的
      // 瞬态——SW 重启后在途请求早已不存在，不恢复成 active 会让任务永远
      // 卡在「正在更新中，请稍候」且无处可点。恢复成 active 并明说，重试
      // 要么成功、要么拿到服务端真实结果（票已消费 → 引导重新发起）。
      const restored: CompletionTask =
        task.status === "applying"
          ? {
              ...task,
              status: "active",
              message: "上次更新中途被打断（浏览器重启了扩展），请重试。",
            }
          : { ...task };
      completionTasks.set(task.sourceId, restored);
    }
  } catch (error) {
    debugError("background", "restoreCompletionTasks:failed", error);
  }
}

async function persistCompletionTasks(): Promise<void> {
  try {
    // 只持久化非终态任务：done/failed 是回执，通知已送达，重启不续跑。
    const live = Array.from(completionTasks.values()).filter((t) => t.status === "active" || t.status === "applying");
    await chrome.storage.session?.set({ [COMPLETION_TASKS_KEY]: live });
  } catch (error) {
    debugError("background", "persistCompletionTasks:failed", error);
  }
}

function findCompletionTaskByTab(tabId: number): CompletionTask | null {
  for (const task of completionTasks.values()) {
    if (task.tabIds.includes(tabId)) return task;
  }
  return null;
}

function findActiveCompletionTaskBySource(sourceId: string): CompletionTask | null {
  const task = completionTasks.get(sourceId);
  return task && (task.status === "active" || task.status === "applying") ? task : null;
}

async function runCompleteMetadataDispatch(input: {
  searchUrl: string;
  token: string;
  sourceId: string;
  apiBaseUrl: string;
  targetTitle?: string | null;
  targetDoi?: string | null;
}): Promise<{ message: string }> {
  // 重复点击幂等：同一 source、同一环境（账号/环境/目标冻结到任务）的在途
  // 任务直接刷新——换票/换检索词都落到这个任务上，不开第二条；待确认的捕获
  // 不被打断，刷新后的票用于接下来的回填。跨环境派同一 source 不是刷新：
  // 把新 token/新环境缝到带着旧 pending 的旧任务上，会把 A 环境捕获的题录
  // 回填到 B 环境的票里——旧任务弃管（标签由超时清扫收），新建独立任务。
  const existing = findActiveCompletionTaskBySource(input.sourceId);
  if (existing && existing.apiBaseUrl === input.apiBaseUrl) {
    if (existing.status === "applying") return { message: "正在更新中，请稍候。" };
    existing.token = input.token;
    existing.targetTitle = input.targetTitle ?? existing.targetTitle;
    existing.targetDoi = input.targetDoi ?? existing.targetDoi;
    const liveTab = existing.tabIds[0];
    if (liveTab != null) {
      try {
        // 换词重派必须导航到新检索地址——只 focus 旧页等于忽略新检索词。
        await chrome.tabs.update(liveTab, { url: input.searchUrl, active: true });
      } catch {
        // 标签没了：重开一个检索标签续上。
        const tab = await chrome.tabs.create({ url: input.searchUrl, active: true });
        if (tab.id != null) existing.tabIds.push(tab.id);
      }
    } else {
      const tab = await chrome.tabs.create({ url: input.searchUrl, active: true });
      if (tab.id != null) existing.tabIds.push(tab.id);
    }
    await persistCompletionTasks();
    broadcastCompletions();
    return { message: "已刷新进行中的更新任务，请继续操作。" };
  }
  if (existing) {
    // 跨环境：旧任务弃管，不继承它的 token、pending 或标签关联。
    completionTasks.delete(input.sourceId);
  }

  debugLog("background", "runCompleteMetadataDispatch:open-tab", {
    sourceId: input.sourceId,
    searchUrl: input.searchUrl,
  });
  const tab = await chrome.tabs.create({ url: input.searchUrl, active: true });
  if (tab.id == null) {
    throw new Error("无法打开检索页面");
  }
  completionTasks.set(input.sourceId, {
    sourceId: input.sourceId,
    token: input.token,
    apiBaseUrl: input.apiBaseUrl,
    targetTitle: input.targetTitle ?? null,
    targetDoi: input.targetDoi ?? null,
    tabIds: [tab.id],
    createdAt: Date.now(),
    pending: null,
    status: "active",
    mismatch: false,
  });
  await persistCompletionTasks();
  broadcastCompletions();
  return { message: "已打开检索页，请在结果里点开这篇文献的详情页。" };
}

async function clearCompletionTask(sourceId: string): Promise<void> {
  completionTasks.delete(sourceId);
  await persistCompletionTasks();
  broadcastCompletions();
}

async function showCompletionNotification(input: {
  sourceId: string;
  title: string;
  message: string;
}): Promise<void> {
  try {
    await chrome.notifications.create(`mango-write-completion-${input.sourceId}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: input.title,
      message: input.message,
      priority: 1,
    });
  } catch (error) {
    debugError("background", "showCompletionNotification:failed", error);
  }
}

/**
 * 关联标签加载完成时尝试识别一次。检索结果页 / 未识别页**不动任务**（也不
 * 消费票据）——用户还在找，等下一次导航；识别出论文且通道是 plugin-dom-*
 * 时落成待确认捕获，等用户在弹窗确认卡上拍板。终局只有四个：用户确认回填
 * 成功 / 用户取消 / 标签全关且任务超时 / 服务端明确拒绝。
 *
 * 已有待确认捕获时**不早退**：错页识别出的捕获不再是死胡同——用户在任务
 * 标签里导航到新的已识别详情页，最新捕获顶掉旧的（确认卡跟用户最后点开
 * 的那篇走）。同一页面重复触发（SPA 重排/重载）不刷新，避免确认卡闪动。
 */
async function runPendingMetadataCompletion(tabId: number): Promise<void> {
  const task = findCompletionTaskByTab(tabId);
  if (!task || task.status !== "active") return;

  let capture: CaptureResult | null = null;
  try {
    capture = await requestPageCapture(tabId);
  } catch (error) {
    debugError("background", "runPendingMetadataCompletion:capture-failed", task, error);
    return;
  }
  if (!capture?.recognized || task.status !== "active") return;
  if (!capture.resolverSource.startsWith("plugin-dom")) return;

  const capturedTitle = captureTitle(capture);
  const originUrl = sanitizeOriginUrl(capture.originUrl);
  if (
    task.pending &&
    task.pending.capturedTitle === capturedTitle &&
    task.pending.originUrl === originUrl
  ) {
    return;
  }

  task.pending = {
    metadata: capture.metadata,
    resolverSource: capture.resolverSource,
    originUrl,
    capturedTitle,
  };
  // 新捕获顶掉旧错配：差异与归因都按新页面重新来。
  task.mismatch = false;
  task.mismatchReason = null;
  task.message = undefined;
  await persistCompletionTasks();
  broadcastCompletions();
  debugLog("background", "runPendingMetadataCompletion:awaiting-confirm", {
    sourceId: task.sourceId,
    capturedTitle: task.pending.capturedTitle,
  });
}

/** 捕获题录的题名（确认卡上与目标题名对照用）。 */
function captureTitle(capture: CaptureResult): string | null {
  const raw = capture.metadata?.title;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return capture.title ?? null;
}

/**
 * 用户在确认卡上拍板「更新」。票由服务端在提交时原子抢占：回填成功即为
 * 终态；错配 409 不终局——任务挂起等「仍要更新」或换页重抓（换页后的新
 * 捕获会顶掉错页捕获，见 runPendingMetadataCompletion）。
 */
async function applyCompletionTask(input: {
  sourceId: string;
  allowMismatch?: boolean;
}): Promise<{ message: string }> {
  const task = completionTasks.get(input.sourceId);
  if (!task || !task.pending) {
    return { message: "该更新任务没有待确认的题录，请先在原站打开详情页。" };
  }
  if (task.status === "applying") {
    return { message: "正在更新中，请稍候。" };
  }
  task.status = "applying";
  task.message = undefined;
  await persistCompletionTasks();
  broadcastCompletions();

  const pending = task.pending;
  try {
    const result = await completeOriginMetadata({
      apiBaseUrl: task.apiBaseUrl,
      token: task.token,
      sourceId: task.sourceId,
      metadata: pending.metadata,
      resolverSource: pending.resolverSource,
      originUrl: pending.originUrl,
      allowMismatch: input.allowMismatch ?? false,
    });
    task.status = "done";
    task.pending = null;
    task.mismatch = false;
    task.mismatchReason = null;
    task.absorbedSourceIds = result.absorbedSourceIds ?? [];
    task.absorbedTitles = result.absorbedTitles ?? [];
    // 成功只说一次：合并对象写进同一句，不额外铺一条「重复条目」说明。
    task.message = result.needsCompletion
      ? "已回填部分字段，仍有字段缺失，可再试或手动补全。"
      : task.absorbedTitles.length > 0
        ? `已更新到你的文库条目，并与《${task.absorbedTitles[0]}》合并为一条。`
        : "已更新到你的文库条目。";
    await persistCompletionTasks();
    broadcastCompletions();
    await showCompletionNotification({
      sourceId: task.sourceId,
      title: "题录更新完成",
      message: task.message,
    });
    broadcastLibraryChanged();
    return { message: task.message };
  } catch (error) {
    const failure = classifyCompletionSubmitError(error);
    debugError("background", "applyCompletionTask:failed", task, error);
    if (failure.kind === "mismatch") {
      // 错配不终局：差异摆给用户，允许明确确认「仍要更新」，也允许换页重抓。
      task.status = "active";
      task.mismatch = true;
      task.mismatchReason = failure.reason;
      task.expectedDoi = failure.expectedDoi;
      task.capturedDoi = failure.capturedDoi;
      task.message = mismatchTaskMessage(task, failure.reason);
      await persistCompletionTasks();
      broadcastCompletions();
      return { message: task.message };
    }
    if (failure.kind === "file-conflict") {
      // 另一条也带着不同的原文：合并会吞掉一份原件，服务端拒绝。这不是
      // 「仍要更新」能解的——用户回文库决定保留哪条后再重试，任务与捕获
      // 都留着，票还有效。
      task.status = "active";
      task.mismatch = false;
      task.mismatchReason = null;
      const other = failure.conflictTitle?.trim();
      task.message = other
        ? `文库里的《${other}》也带着不同的原文文件，为避免覆盖原件，本次没有合并。请在文库决定保留哪条后再试。`
        : "文库里有另一条同样题录的文献也带着不同的原文文件，为避免覆盖原件，本次没有合并。请在文库决定保留哪条后再试。";
      await persistCompletionTasks();
      broadcastCompletions();
      return { message: task.message };
    }
    if (failure.kind === "token") {
      // 票无效/过期/被抢占：任务没有继续的凭据，回文库重新发起是唯一出路。
      // 失败卡留在列表里当回执（popup 给「移除」），通知同步说明原因。
      task.status = "failed";
      task.message = "本次更新的授权已失效，请回文库重新发起「更正文献信息」。";
      await persistCompletionTasks();
      broadcastCompletions();
      await showCompletionNotification({
        sourceId: task.sourceId,
        title: "题录更新未完成",
        message: task.message,
      });
      return { message: task.message };
    }
    // 网络/服务端波动：任务与待确认题录都留着，直接重试即可。
    task.status = "active";
    task.message = "暂时未收到更新结果（网络或服务端异常），请重试确认；不会新增文献。";
    await persistCompletionTasks();
    broadcastCompletions();
    return { message: task.message };
  }
}

/** 错配说明按归因说：身份无从核对 / DOI 冲突 / 题名不像，各讲各的。 */
function mismatchTaskMessage(task: CompletionTask, reason: CompletionMismatchReason): string {
  const target = task.targetTitle?.trim();
  if (reason === "identity") {
    return "这条文献的题录还不足以判断是不是同一篇（缺题名）。请核对页面题录，确认无误后点「仍要更新」。";
  }
  if (reason === "doi") {
    return "页面的 DOI 与目标条目的 DOI 不一致。核对后仍要更新请点「仍要更新」，或换正确的详情页重抓。";
  }
  return target
    ? `这个页面的题名与《${target}》不一致。核对后仍要更新请点「仍要更新」，或换正确的详情页重抓。`
    : "这个页面的题名与目标文献不一致。核对后仍要更新请点「仍要更新」，或换正确的详情页重抓。";
}

type CompletionFailure =
  | { kind: "mismatch"; reason: CompletionMismatchReason; expectedDoi: string | null; capturedDoi: string | null }
  | { kind: "file-conflict"; conflictTitle: string | null }
  | { kind: "token" }
  | { kind: "transient" };

function classifyCompletionSubmitError(error: unknown): CompletionFailure {
  if (error instanceof CompletionSubmitError) {
    if (error.status === 409) {
      // 文件冲突与题录错配都是 409，但出路相反：错配可「仍要更新」，冲突
      // 只能回文库处理重复条目——按 body 的 error 码分开，不都塞进错配。
      if (error.detail?.error === "completion_file_conflict") {
        return {
          kind: "file-conflict",
          conflictTitle:
            typeof error.detail.conflictTitle === "string" ? error.detail.conflictTitle : null,
        };
      }
      const reason = error.detail?.reason;
      return {
        kind: "mismatch",
        reason: reason === "identity" || reason === "doi" ? reason : "title",
        expectedDoi: typeof error.detail?.expectedDoi === "string" ? error.detail.expectedDoi : null,
        capturedDoi: typeof error.detail?.capturedDoi === "string" ? error.detail.capturedDoi : null,
      };
    }
    if (error.status === 401) return { kind: "token" };
    return { kind: "transient" };
  }
  return { kind: "transient" };
}

async function cancelCompletionTask(sourceId: string): Promise<{ message: string }> {
  const task = completionTasks.get(sourceId);
  if (!task) return { message: "任务已结束。" };
  // 提交边界：更新一旦发出就不可撤回（服务端可能已完成写入）——进行中的
  // 任务不接取消，等它出结果。只删 map 的话取消完写照落，用户看到的是
  // 「取消了却还是更新了」。取消只对还没提交的任务开放。
  if (task.status === "applying") {
    return { message: "更新进行中，无法取消；完成后可结束任务。" };
  }
  await clearCompletionTask(sourceId);
  debugLog("background", "cancelCompletionTask", { sourceId });
  return { message: "已取消更新任务，可回文库重新发起。" };
}

async function handleCompletionTabRemoved(tabId: number): Promise<void> {
  for (const task of completionTasks.values()) {
    const index = task.tabIds.indexOf(tabId);
    if (index < 0) continue;
    task.tabIds.splice(index, 1);
    // 任务不随单个标签关闭而消失：用户可能还开着从任务延伸出去的其他标签，
    // 也可能只是关掉检索页、详情页在另一个标签里。全关了的任务由超时清扫收。
    await persistCompletionTasks();
    debugLog("background", "handleCompletionTabRemoved:detached", {
      sourceId: task.sourceId,
      tabId,
      remaining: task.tabIds.length,
    });
  }
}

async function sweepStaleMetadataCompletions(): Promise<void> {
  const now = Date.now();
  for (const task of Array.from(completionTasks.values())) {
    if (now - task.createdAt < COMPLETION_TASK_TIMEOUT_MS) continue;
    // 终态回执静默过期；只有被丢下的在途任务需要告诉用户回去重来。
    const inFlight = task.status === "active" || task.status === "applying";
    await clearCompletionTask(task.sourceId);
    debugLog("background", "sweepStaleMetadataCompletions:timeout", task);
    if (!inFlight) continue;
    await showCompletionNotification({
      sourceId: task.sourceId,
      title: "题录更新超时",
      message: "更新任务已结束（15 分钟未确认），需要时可回文库重新发起。",
    });
  }
}

/** 任务 → 弹窗视图（secret-free：token/apiBaseUrl 绝不下发到页面）。 */
function completionView(task: CompletionTask): CompletionView {
  return {
    sourceId: task.sourceId,
    tabIds: [...task.tabIds],
    targetTitle: task.targetTitle,
    targetDoi: task.targetDoi,
    status: task.status,
    mismatch: task.mismatch,
    mismatchReason: task.mismatchReason ?? null,
    expectedDoi: task.expectedDoi ?? null,
    capturedDoi: task.capturedDoi ?? null,
    capturedTitle: task.pending?.capturedTitle ?? null,
    capturedSummary: task.pending
      ? completionCaptureSummary(task.pending.metadata)
      : null,
    message: task.message,
    absorbedSourceIds: task.absorbedSourceIds,
    absorbedTitles: task.absorbedTitles,
    libraryUrl: completionLibraryUrl(task),
    createdAt: task.createdAt,
    actionable: task.pending !== null && (task.status === "active" || task.status === "applying"),
  };
}

/** 回填成功后的「在文库中查看」深链：任务环境的个人阅读页（补全只对本人条目）。 */
function completionLibraryUrl(task: CompletionTask): string | null {
  if (task.status !== "done") return null;
  try {
    return `${new URL(task.apiBaseUrl).origin}/u/read/${task.sourceId}`;
  } catch {
    return null;
  }
}

/**
 * 待确认捕获的紧凑题录摘要（确认卡上供用户核对）：作者取前两位（多的记
 * 「等」）、年份取 issued 首段、来源取 container-title、DOI 原样。认不出
 * 的字段留 null，卡片不渲染该行——不拿占位文本充数。
 */
function completionCaptureSummary(
  metadata: Record<string, unknown>,
): CompletionCaptureSummary {
  const authors: string[] = [];
  const rawAuthors = Array.isArray(metadata.author) ? metadata.author : [];
  for (const a of rawAuthors) {
    if (typeof a === "string" && a.trim()) authors.push(a.trim());
    else if (a && typeof a === "object") {
      const rec = a as Record<string, unknown>;
      const name =
        typeof rec.literal === "string" && rec.literal.trim()
          ? rec.literal.trim()
          : [rec.given, rec.family]
              .filter((v): v is string => typeof v === "string")
              .join(" ")
              .trim();
      if (name) authors.push(name);
    }
    if (authors.length >= 2) break;
  }
  const issued = metadata.issued as { "date-parts"?: number[][] } | undefined;
  const year = issued?.["date-parts"]?.[0]?.[0];
  const container = metadata["container-title"];
  const venue =
    typeof container === "string" && container.trim()
      ? container.trim()
      : Array.isArray(container) && typeof container[0] === "string"
        ? container[0]
        : null;
  return {
    authors: authors.length > 0 ? `${authors.join("、")}${rawAuthors.length > 2 ? " 等" : ""}` : null,
    year: typeof year === "number" ? String(year) : null,
    venue,
    doi: typeof metadata.DOI === "string" && metadata.DOI.trim() ? metadata.DOI.trim() : null,
  };
}

function broadcastCompletions(): void {
  const message: CaptureListMessage = { ...buildListMessage() };
  for (const port of progressPorts) {
    try {
      port.postMessage(message);
    } catch {
      progressPorts.delete(port);
    }
  }
}

/**
 * Ask the tab's content script for a full translator capture (metadata +
 * ordered attachment descriptors). Returns null when no content script answers
 * or the page yields nothing — callers fall back to the raw snapshot.
 */
async function requestPageCapture(tabId: number): Promise<CaptureResult | null> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "mango-write/capture-page-context",
    });
    if (!response || typeof response !== "object" || "error" in response) return null;
    return response as CaptureResult;
  } catch (error) {
    debugLog("background", "requestPageCapture:unavailable", tabId, error);
    return null;
  }
}

async function runOriginAssist(input: {
  token: string;
  sourceId: string;
  /** Translator capture when the page was recognized; null → snapshot only. */
  capture?: CaptureResult | null;
  snapshot: PageSnapshot;
  tabId: number | null;
}): Promise<{ message: string }> {
  debugLog("background", "runOriginAssist:start", {
    sourceId: input.sourceId,
    originUrl: input.snapshot.originUrl,
    translatorAttachments: input.capture?.attachments.length ?? 0,
    tabId: input.tabId,
  });

  const apiBaseUrl = getApiBaseUrl();
  const fetchBytes = makeByteFetcher(
    input.tabId,
    input.snapshot.originUrl,
    proxyMappingFromPage(input.snapshot.originUrl, input.snapshot.pageHtml ?? ""),
  );

  const reportStep = (event: Omit<PluginImportEventItem, "occurredAt">): Promise<void> =>
    reportPluginEvents({
      apiBaseUrl,
      token: input.token,
      sourceId: input.sourceId,
      events: [{ ...event, occurredAt: new Date().toISOString() }],
    });
  await reportStep({
    step: "origin.assist.start",
    status: "info",
    detail: {
      originUrl: input.snapshot.originUrl,
      recognized: Boolean(input.capture?.recognized),
      translatorAttachments: input.capture?.attachments.length ?? 0,
    },
  });

  try {
    // Translator attachments first — they're the site's own download links, and
    // for CNKI/万方/维普 they're the only route to the PDF. Gate detection applies
    // here too, so a login page never gets uploaded as the origin file.
    let pdf: PdfFileAsset | null = null;
    let gate: GateKind | null = null;
    if (input.capture) {
      const attempt = await downloadFirstAttachment(input.capture, fetchBytes);
      pdf = attempt.file;
      gate = attempt.gate;
      await reportStep({
        step: "origin.attachment",
        status: pdf ? "ok" : gate ? "failed" : "info",
        reason: pdf ? undefined : gate ? `gated-${gate}` : "no-attachment",
        detail: pdf
          ? { filename: pdf.filename, mime: pdf.mime }
          : attempt.failures.length
            ? { attempts: attempt.failures.slice(0, 3) }
            : undefined,
      });
    }

    // Server publisher rules as the fallback, unless the translator forbids
    // scraping its SPA shell (same rule the begin-capture path honours).
    if (!pdf && (input.capture?.allowGenericPdfDiscovery ?? true)) {
      const discovery = await fetchBestPdf({
        apiBaseUrl,
        token: input.token,
        localCandidates: extractLocalPdfCandidates({
          pageUrl: input.snapshot.originUrl,
          html: input.snapshot.pageHtml,
        }),
        snapshot: input.snapshot,
        fetchBytes,
      });
      pdf = discovery.file;
      await reportStep({
        step: "origin.discovery",
        status: pdf ? "ok" : "failed",
        reason: pdf ? undefined : "no-pdf-candidate",
        detail: pdf
          ? { filename: pdf.filename, mime: pdf.mime }
          : discovery.failures.length
            ? { attempts: discovery.failures.slice(0, 3) }
            : undefined,
      });
    }

    if (!pdf) {
      debugLog("background", "runOriginAssist:no-pdf-found", { sourceId: input.sourceId, gate });
      await reportPluginFailure({
        apiBaseUrl,
        token: input.token,
        // A gate is the user's to clear; "nothing downloadable here" is not.
        reason: gate ? `gated-${gate}` : "no-pdf-found",
        originUrl: input.snapshot.originUrl,
        sourceId: input.sourceId,
      });
      return {
        message: gate
          ? gateFailureMessage(gate)
          : `未找到可下载的 PDF（页面没有可识别的下载入口，或下载未成功）。${NO_GATE_HINT}`,
      };
    }

    // 上传成功服务端会记 origin.upload 事件；此处票据已被消费，不再上报。
    await uploadOriginPdf({
      apiBaseUrl,
      token: input.token,
      file: pdf,
    });
    broadcastLibraryChanged();

    return { message: "已把抓到的 PDF 回传给 MangoWrite。" };
  } catch (error) {
    debugError("background", "runOriginAssist:blocked", { sourceId: input.sourceId }, error);
    await reportPluginFailure({
      apiBaseUrl,
      token: input.token,
      reason: "blocked",
      originUrl: input.snapshot.originUrl,
      sourceId: input.sourceId,
    });
    throw error;
  }
}

async function fetchBestPdf(input: {
  apiBaseUrl: string;
  /** 服务端回落才用的票据；本地候选命中时为空串且绝不发请求。 */
  token: string;
  /** 共享包规则在本地的命中；非空则跳过服务端 extract-pdf。 */
  localCandidates: PluginPdfCandidate[];
  snapshot: PageSnapshot;
  fetchBytes: ByteFetcher;
}): Promise<{
  file: PdfFileAsset | null;
  failures: Array<{ url: string; reason: string }>;
}> {
  let candidates = input.localCandidates;
  if (candidates.length > 0) {
    debugLog("background", "fetchBestPdf:candidates:local", candidates);
  } else {
    debugLog("background", "fetchBestPdf:candidates:server-fallback", {
      pageUrl: input.snapshot.originUrl,
    });
    candidates = await extractPluginPdfCandidates({
      apiBaseUrl: input.apiBaseUrl,
      token: input.token,
      pageUrl: input.snapshot.originUrl,
      html: input.snapshot.pageHtml,
    });
    debugLog("background", "fetchBestPdf:candidates", candidates);
  }

  const failures: Array<{ url: string; reason: string }> = [];
  for (const candidate of candidates) {
    let result: Awaited<ReturnType<typeof downloadPdfCandidate>>;
    try {
      result = await downloadPdfCandidate(candidate, input.snapshot.title, input.fetchBytes);
    } catch (error) {
      failures.push({ url: candidate.url, reason: errText(error).slice(0, 120) || "threw" });
      continue;
    }
    if (result.file) {
      debugLog("background", "fetchBestPdf:selected", candidate);
      return { file: result.file, failures };
    }
    failures.push({ url: candidate.url, reason: result.reason ?? "no-file" });
  }

  debugLog("background", "fetchBestPdf:none-worked", { failures });
  return { file: null, failures };
}

/** What stood between us and the full text, in the user's terms. */
function gateReasonText(gate: GateKind): string {
  switch (gate) {
    case "login":
      return "站点要求登录";
    case "challenge":
      return "站点要求人机验证";
    case "forbidden":
      return "当前账号没有该文献的访问权限";
    case "error":
      return "站点返回了错误页";
  }
}

/**
 * The recovery path, named explicitly. 取不到全文最常见的原因是当前账号没有
 * 该文献的下载权限（未登录 / 未订阅），所以提示里直接给出最可靠的自救路径：
 * 在出版商页面手动下载 PDF，再回文献库上传；取原文 re-runs this same fetch
 * from the reopened page, so clearing a login wall and one click also works.
 */
const RETRY_HINT =
  "通常是当前账号没有该文献的下载权限——可在该页登录后手动下载 PDF，再到文献库对该文献手动上传；处理好权限后点「取原文」也可以补上原文。";

/**
 * Same recovery paths, but NO gate was hit: the page offered nothing we could
 * grab, or the fetch itself failed. Blaming download permissions there sends
 * entitled users chasing a login they already have (a CNKI thesis page once
 * looked exactly like that), so only gate failures get the 权限 wording.
 */
const NO_GATE_HINT =
  "可手动下载 PDF 后到文献库对该文献手动上传；若页面有下载按钮但抓取失败，稍后点「取原文」重试也可以补上。";

function gateFailureMessage(gate: GateKind): string {
  return `${gateReasonText(gate)}，未取到原文。${RETRY_HINT}`;
}

function buildCompletionMessage(
  file: PdfFileAsset | null,
  pageHtml: string | null,
  alreadyInLibrary = false,
  gate: GateKind | null = null,
): string {
  if (alreadyInLibrary) {
    if (!file && pageHtml) return "该网页已在文献库中，未重复导入。";
    if (file) return "该文献已在文献库中，未重复导入。";
    // 库中那条仍是仅题录——这不算「已导入」，照警示处理。有没有 gate 决定
    // 用户该先去登录还是先怀疑页面入口。
    return `该文献已在文献库中，但仍只有题录、未取到全文。${
      gate ? gateFailureMessage(gate) : NO_GATE_HINT
    }`;
  }
  if (file) {
    const isHtml = /html/i.test(file.mime);
    return isHtml ? "已导入并抓取 HTML 全文。" : "已导入并抓取 PDF 原文。";
  }
  if (pageHtml) return "已按网页导入。";
  // A gate is fixable by the user; "this page has no full text" is not. Saying
  // which — and naming 取原文 — is the difference between them finishing the
  // import and giving up on a paper we already filed the metadata for.
  if (gate) return `已导入题录；${gateFailureMessage(gate)}`;
  return `已导入题录，未取到全文。${NO_GATE_HINT}`;
}

function formatByteProgress(loaded: number, total?: number): string {
  const loadedMb = (loaded / 1024 / 1024).toFixed(1);
  if (total && total > 0) {
    const totalMb = (total / 1024 / 1024).toFixed(1);
    const percent = Math.round((loaded / total) * 100);
    return `已下载 ${loadedMb} / ${totalMb} MB (${percent}%)`;
  }
  return `已下载 ${loadedMb} MB`;
}

// Capture registry + progress broadcasting + persistence

function registerCapture(record: CaptureRecord): void {
  captures.set(record.captureId, record);
  afterCaptureChange();
}

/**
 * 字节进度回调按网络节奏高频到达（每个 chunk 一次），而广播 + 持久化是
 * 全列表动作——进度/字节计数类补丁限频 200ms（前沿立即、尾沿补一拍），
 * 状态类变更仍走立即同步。进度信息最多迟 200ms，不会丢。
 */
const PROGRESS_SYNC_INTERVAL_MS = 200;
let lastProgressSyncAt = 0;
let progressSyncTimer: ReturnType<typeof setTimeout> | null = null;

function updateCapture(record: CaptureRecord, patch: Partial<CaptureRecord>): void {
  Object.assign(record, patch);
  const progressOnly = Object.keys(patch).every((key) => key === "progress" || key === "detail");
  if (!progressOnly) {
    afterCaptureChange();
    return;
  }
  const elapsed = Date.now() - lastProgressSyncAt;
  if (elapsed >= PROGRESS_SYNC_INTERVAL_MS) {
    flushProgressSync();
    return;
  }
  if (progressSyncTimer == null) {
    progressSyncTimer = setTimeout(flushProgressSync, PROGRESS_SYNC_INTERVAL_MS - elapsed);
  }
}

function flushProgressSync(): void {
  if (progressSyncTimer != null) {
    clearTimeout(progressSyncTimer);
    progressSyncTimer = null;
  }
  lastProgressSyncAt = Date.now();
  afterCaptureChange();
}

/** Remove a task entirely (cancel / dismiss / reimport). */
function removeCapture(captureId: string): void {
  cancelledCaptures.delete(captureId);
  pendingWebpageCaptures.delete(captureId);
  if (captures.delete(captureId)) afterCaptureChange();
}

/**
 * Terminal success. The record stays visible for the user, but is not kept
 * forever: completed rows (incl. metadata-only warnings) auto-expire via
 * pruneCaptures; failed rows stay until the user retries/dismisses/清空记录.
 */
function completeCapture(
  record: CaptureRecord,
  message: string,
  opts: { alreadyInLibrary?: boolean; resultKind?: CaptureResultKind } = {},
): void {
  record.state = "completed";
  record.step = "completed";
  record.progress = 100;
  record.done = true;
  record.completedAt = Date.now();
  record.message = message;
  record.failure = undefined;
  record.error = undefined;
  record.detail = undefined;
  record.retry = "none";
  record.alreadyInLibrary = opts.alreadyInLibrary === true;
  record.resultKind = opts.resultKind;
  record.payload = undefined; // release the bytes; upload succeeded
  afterCaptureChange();
  broadcastLibraryChanged();
}

/**
 * Tell every open web-app tab that an import just landed so the library list
 * refreshes without a manual reload. Best-effort and fire-and-forget: tabs
 * without a live content script reject the sendMessage promise, which we
 * swallow. The content script re-checks the origin before relaying into the
 * page (it is the security boundary), so this filter is just noise reduction.
 */
function broadcastLibraryChanged(): void {
  void (async () => {
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id == null || !tab.url) continue;
        try {
          if (!isBridgeOriginAllowed(new URL(tab.url).origin)) continue;
        } catch {
          continue;
        }
        void chrome.tabs
          .sendMessage(tab.id, { type: "mango-write/library-changed" })
          .catch(() => undefined);
      }
    } catch (error) {
      debugLog("background", "broadcastLibraryChanged:skipped", error);
    }
  })();
}

/**
 * Terminal-but-actionable: the paper is already in the library with a different
 * PDF. Nothing was written. The row stays with an "更新 / 保留" choice; the bytes
 * are kept in hand (not released, unlike completeCapture) so a confirmed replace
 * can re-upload without re-downloading. Silent — no OS notification.
 */
function conflictCapture(record: CaptureRecord): void {
  record.state = "conflict";
  record.step = "uploading";
  record.progress = 100;
  record.done = true;
  record.failure = undefined;
  record.error = undefined;
  record.detail = undefined;
  record.message = "这篇已在文献库中，但检测到 PDF 与现有的不同。";
  record.retry = "none";
  afterCaptureChange();
}

/**
 * Terminal failure. The record STAYS in the list until the user retries,
 * dismisses it, or hits 清空记录. Failures fire an OS notification (decision 8).
 * 文案由 kind 查集中文案表（queue-util failureCopy），调用点只负责归因。
 */
function failCapture(record: CaptureRecord, failure: CaptureFailure, retry: RetryKind): void {
  record.state = "failed";
  record.step = "failed";
  record.done = true;
  record.failure = failure;
  record.error = undefined;
  record.detail = undefined;
  record.retry = retry;
  if (retry !== "manual-upload") record.payload = undefined; // can't resume without a reimport
  afterCaptureChange();
  void showFailureNotification(record);
}

/** 闸门 kind → 失败 kind（gate-login 这类前缀形式）。 */
function gateFailureKind(gate: GateKind): FailureKind {
  return `gate-${gate}` as FailureKind;
}

/** Persist + rebroadcast + refresh the toolbar badge after any registry change. */
function afterCaptureChange(): void {
  pruneCaptures();
  void persistCaptures();
  broadcastCaptures();
  void updateBadge();
  ensureKeepAlive();
}

/** 列表容量上限与已完成记录的保留期，防止列表无限扩张。 */
const MAX_CAPTURE_RECORDS = 20;
const COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * 自动清理只针对「已完成」：failed/conflict 在等用户裁决（重试/更新/保留），
 * 不自动消失。TTL 按完成时刻计，裁剪按导入先后从最早的已完成开始。
 */
function pruneCaptures(): boolean {
  const now = Date.now();
  let changed = false;
  const drop = (captureId: string) => {
    captures.delete(captureId);
    captureEventBuffers.delete(captureId);
    changed = true;
  };
  for (const [id, record] of captures) {
    if (
      record.state === "completed" &&
      now - (record.completedAt ?? record.createdAt) > COMPLETED_RETENTION_MS
    ) {
      drop(id);
    }
  }
  if (captures.size > MAX_CAPTURE_RECORDS) {
    const oldestCompleted = Array.from(captures.values())
      .filter((record) => record.state === "completed")
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const record of oldestCompleted) {
      if (captures.size <= MAX_CAPTURE_RECORDS) break;
      drop(record.captureId);
    }
  }
  return changed;
}

/**
 * MV3 kills the service worker after ~30s idle. An in-flight fetch keeps it
 * alive during a download/upload, but the gaps between serial queue steps can
 * exceed that. While any task is active, ping a cheap chrome API every 20s so
 * the worker's idle timer keeps resetting; stop once the queue drains.
 */
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
function ensureKeepAlive(): void {
  const active = Array.from(captures.values()).some(isActive);
  if (active && keepAliveTimer == null) {
    keepAliveTimer = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
  } else if (!active && keepAliveTimer != null) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

/**
 * 卡上可点的动作，按记录的**真实可执行条件**投影：payload（字节）只活在
 * worker 堆里，「重试/更新」要求它在手，条件失效就改发 reimport 或不给。
 * popup 只渲染这份清单，不从 retry 档位反推按钮——渲染与执行同源，
 * 「点了没反应的死按钮」在结构上画不出来。
 */
function captureActions(record: CaptureRecord): CaptureActionKind[] {
  switch (record.state) {
    case "failed":
      return record.retry === "manual-upload" && record.payload ? ["retry-upload"] : ["reimport"];
    case "conflict":
      return record.payload && record.sourceId ? ["replace"] : [];
    default:
      return [];
  }
}

function toView(record: CaptureRecord): CaptureView {
  return {
    captureId: record.captureId,
    originUrl: record.originUrl,
    title: record.title,
    sourceSite: record.sourceSite,
    teamName: record.teamName,
    state: record.state,
    step: record.step,
    progress: record.progress,
    detail: record.detail,
    // 旧持久化记录只有自由串 error：归一成 unknown（中文串会原样当 reason）。
    failure: record.failure ?? (record.error ? { kind: "unknown", raw: record.error } : undefined),
    message: record.message,
    actions: captureActions(record),
    done: record.done,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    alreadyInLibrary: record.alreadyInLibrary,
    resultKind: record.resultKind,
    libraryUrl: record.libraryUrl,
  };
}

function captureViews(): CaptureView[] {
  // 最新导入排最上面；进行中的任务不会被裁剪，降序对它们无副作用。
  return Array.from(captures.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(toView);
}

function buildListMessage(): CaptureListMessage {
  // 补全/更正任务与导入队列同端口同消息：popup 重连（SW 回收后）一次拿全，
  // 不会在两次广播之间丢掉刚恢复的在途任务。
  return { type: "mango-write/capture-list", captures: captureViews(), completions: completionViews() };
}

/** 任务 → 视图列表（新到旧；secret-free）。 */
function completionViews(): CompletionView[] {
  return Array.from(completionTasks.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(completionView);
}

function broadcastCaptures(): void {
  const message = buildListMessage();
  for (const port of progressPorts) {
    try {
      port.postMessage(message);
    } catch {
      progressPorts.delete(port);
    }
  }
}

function isActive(record: CaptureRecord): boolean {
  return !record.done;
}

/**
 * 一键清空：移除所有已结束的记录（completed / failed）。conflict 行是
 * 待用户裁决的冲突（更新或保留），不是「记录」，不在清空范围内。
 */
function clearFinishedCaptures(): void {
  let changed = false;
  for (const [id, record] of captures) {
    if (record.done && (record.state === "completed" || record.state === "failed")) {
      captures.delete(id);
      captureEventBuffers.delete(id);
      changed = true;
    }
  }
  if (changed) afterCaptureChange();
}

/** Toolbar badge: in-flight count > failures > metadata-only warnings. */
async function updateBadge(): Promise<void> {
  try {
    const records = Array.from(captures.values());
    const active = records.filter(isActive).length;
    if (active > 0) {
      await chrome.action.setBadgeText({ text: String(active) });
      await chrome.action.setBadgeBackgroundColor({ color: "#f97316" });
      return;
    }
    // 有没完全成功的导入时用警示色提醒：失败优先于仅题录。
    const failed = records.filter((r) => r.state === "failed").length;
    if (failed > 0) {
      await chrome.action.setBadgeText({ text: String(failed) });
      await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
      return;
    }
    const warnings = records.filter(
      (r) => r.state === "completed" && r.resultKind === "metadata-only",
    ).length;
    if (warnings > 0) {
      await chrome.action.setBadgeText({ text: String(warnings) });
      await chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
      return;
    }
    await chrome.action.setBadgeText({ text: "" });
  } catch (error) {
    debugLog("background", "updateBadge:skip", error);
  }
}

async function persistCaptures(): Promise<void> {
  try {
    // Strip the in-memory byte payload — bytes never touch chrome.storage.
    const serializable = Array.from(captures.values()).map(({ payload: _payload, ...rest }) => rest);
    await chrome.storage.local.set({ [RUNNING_CAPTURES_KEY]: serializable });
  } catch (error) {
    debugError("background", "persistCaptures:failed", error);
  }
}

/**
 * Service worker wakes up without the in-memory registry (and without the byte
 * payloads) when it was hard-killed. Any non-done captures left in storage died
 * mid-import and can't resume — surface them as failed with a "reimport" retry
 * so the user can reopen the origin page. (Decision 5.)
 */
async function markStaleCapturesFailed(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(RUNNING_CAPTURES_KEY);
    const list = (stored[RUNNING_CAPTURES_KEY] as CaptureRecord[] | undefined) ?? [];
    for (const record of list) {
      if (!record.captureId || captures.has(record.captureId)) continue;
      captures.set(record.captureId, record);
      if (record.done) {
        // 字节随 worker 一起死了。等字节在手的行（confirm 快照 / conflict 的
        // 更新 / manual-upload 的重传）当场降档，让记录、文案与 toView 投影
        // 出的可执行动作保持一致，别唤醒一个点了没反应的裁决行。
        if (record.state === "confirm") {
          failCapture(record, { kind: "snapshot-stale" }, "manual-reimport");
        } else if (record.state === "conflict" && !record.payload) {
          failCapture(record, { kind: "browser-interrupted" }, "manual-reimport");
        } else if (record.retry === "manual-upload" && !record.payload) {
          // 原始失败原因保留（用户见过它）；换掉的只是可执行档位。
          failCapture(record, record.failure ?? { kind: "browser-interrupted" }, "manual-reimport");
        }
        continue;
      }
      failCapture(record, { kind: "browser-interrupted" }, "manual-reimport");
    }
  } catch (error) {
    debugError("background", "markStaleCapturesFailed:failed", error);
  }
}

async function showMetadataOnlyNotification(record: CaptureRecord): Promise<void> {
  try {
    const title = record.title ? `《${record.title}》` : "文献导入";
    await chrome.notifications.create(`mango-write-capture-${record.captureId}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: `${title} 只导入了题录`,
      message: record.message || "未能获取全文 PDF，可在文献库中对该文献使用「取原文」或手动上传。",
      priority: 1,
    });
  } catch (error) {
    debugError("background", "showMetadataOnlyNotification:failed", error);
  }
}

async function showFailureNotification(record: CaptureRecord): Promise<void> {
  try {
    const title = record.title ? `《${record.title}》` : "文献导入";
    // 白话两行（原因 + 怎么办）；原始技术串留在 debug 日志，不进系统通知。
    const message =
      (record.failure ? failureText(record.failure) : undefined) ||
      record.error ||
      "导入没有成功，请打开插件查看。";
    await chrome.notifications.create(`mango-write-capture-${record.captureId}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: `${title} 导入失败`,
      message,
      priority: 1,
    });
  } catch (error) {
    debugError("background", "showFailureNotification:failed", error);
  }
}
