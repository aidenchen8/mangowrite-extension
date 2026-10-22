import type { GateKind } from "./interstitial.js";
import type { Attachment } from "./translators/types.js";

export interface PageSnapshot {
  originUrl: string;
  title: string;
  identifier: string | null;
  pageHtml: string;
}

/**
 * Rich capture produced by a translator: metadata + ordered full-text
 * attachment descriptors on top of the base page snapshot.
 */
export interface CaptureResult extends PageSnapshot {
  /** Did any translator recognize a scholarly item here? false → don't import. */
  recognized: boolean;
  /**
   * pageHtml 的形态：识别为论文 → 原始 `outerHTML`（零资源请求，够规则提取
   * 与闸门判定）；未识别网页 → single-file 快照（导入内容本身）。
   */
  pageHtmlKind: "raw" | "snapshot";
  /** Translator metadata (PartialCsl), serialized for messaging/upload. */
  metadata: Record<string, unknown>;
  /** Provenance stamp for the backend field-merge, e.g. "plugin-dom-zh". */
  resolverSource: string;
  /** Full-text candidates, most-preferred first. */
  attachments: Attachment[];
  allowGenericPdfDiscovery: boolean;
  allowRawHtmlFallback: boolean;
}

export interface PdfFileAsset {
  bytes: Uint8Array;
  filename: string;
  mime: string;
}

export type ContentMessage =
  | { type: "mango-write/capture-page-context" }
  // 模式 B：background 向它打开的出版商标签要一份轻量快照（标题 + 原始 HTML），
  // 供服务端提取 citation_pdf_url 候选。比 capture-page-context 轻——不跑
  // translator、不打 single-file 包。
  | { type: "mango-write/origin-snapshot" }
  // popup 的存活探针：区分「标签里根本没有 content script」（原生 PDF 查看器）
  // 与「有 content script 但 translator 没识别」（普通网页）。响应带 viewerShell
  // ——当前 Chrome 会在原生 PDF 查看器页注入 content script 并应答 ping，
  // 「有应答」不再等于「是网页」。
  | { type: "mango-write/ping" }
  // 导入落库后 background 向所有 web 应用标签广播的单向通知：content script
  // 校验 origin 后转 postMessage 给页面，页面刷新文库列表。无需响应。
  | { type: "mango-write/library-changed" }
  | { type: "mango-write/fetch-bytes"; url: string };

/** Response to "mango-write/ping". */
export interface PingResult {
  ok: boolean;
  /** The answering content script sits on Chrome's native PDF viewer shell. */
  viewerShell?: boolean;
}

/** Response to "mango-write/origin-snapshot". */
export interface OriginSnapshotResult {
  title: string;
  url: string;
  html: string;
}

/** Sent once per page load so the toolbar icon can reflect whether a translator recognized this page. */
export interface RecognizedStateMessage {
  type: "mango-write/recognized-state";
  recognized: boolean;
  /** Canonical URL used by the webpage queue identity, when available. */
  originUrl?: string;
}

/**
 * Result of a content-script-context byte fetch (see fetch-bytes above).
 * Downloading through the tab (rather than the background service worker)
 * matters for anti-leech / SSO-gated links (CNKI via WebVPN, etc.) whose
 * session cookies are scoped tight enough that a service-worker-initiated
 * cross-origin fetch doesn't carry them, even with credentials: "include".
 */
export type FetchBytesResult =
  | {
      ok: true;
      base64: string;
      contentType: string | null;
      contentDisposition: string | null;
    }
  | { ok: false; error: string };

export interface PairedUserInfo {
  id: string;
  email: string;
  name: string | null;
  /**
   * Avatar image URL from the web app's user profile. Optional because older
   * web builds don't send it — the popup falls back to the name initial.
   */
  image?: string | null;
}

/**
 * Fine-grained progress label within a state (e.g. which byte-fetch step the
 * "acquiring" state is on). Kept for human-readable copy; `CaptureState` is the
 * authoritative queue phase the UI branches on.
 */
export type CaptureStep =
  | "idle"
  | "capturing"
  | "downloading"
  | "uploading"
  | "parsing"
  | "completed"
  | "failed";

/**
 * Authoritative queue phase.
 * - `acquiring`  — downloading full-text bytes eagerly while the source tab is
 *   still alive/logged-in (runs concurrently across tasks; tab-relay fetches in
 *   parallel, DNR direct fetches serialized by a global mutex). Also covers the
 *   leading "reading the page" step (step: "capturing") — the queue row exists
 *   from the instant the user clicks import, so closing the popup or leaving
 *   the tab can never lose the task.
 * - `queued`     — bytes in hand (or none needed); waiting for the serial upload slot.
 * - `uploading`  — handing off to the backend (one at a time).
 * - `completed` / `failed` — terminal.
 */
export type CaptureState =
  | "acquiring"
  | "queued"
  | "uploading"
  | "completed"
  | "failed"
  // The paper is already in the library with a *different* PDF; nothing was
  // written. Awaits the user's choice: update (re-upload with replaceSourceId)
  // or keep the existing file (dismiss). Terminal-but-actionable, like `failed`.
  | "conflict"
  // The page was read but no translator recognized a paper; the snapshot is
  // held in memory awaiting the user's 按网页导入 / 取消 choice on the queue
  // card. Terminal-but-actionable, like `conflict` — and just as volatile:
  // a service-worker restart loses the held snapshot, and the row then fails
  // with a re-import hint (see markStaleCapturesFailed).
  | "confirm";

/**
 * 导入完成后实际落成的内容形态。"metadata-only" 不是完整的导入成功——
 * popup 必须把它展示成警示（只有题录、没有全文），而不是绿色「已完成」。
 */
export type CaptureResultKind = "pdf" | "html" | "webpage" | "metadata-only";

/**
 * 终态失败的机器归因。失败点（唯一知道真相的地方）只赋 kind；给用户看的
 * 文案一律查 queue-util 的集中文案表（failureCopy），不在调用点手写——
 * 原始错误串（Failed to fetch / request_failed:502 这类）只进 raw，供
 * tooltip 与调试日志，不上面向用户的正文。
 */
export type FailureKind =
  // 读取阶段
  | "page-unreachable" // 标签页里没有插件的页面脚本（内置页、脚本未注入）
  | "page-interrupted" // 读取完成前页面被导航或关闭
  | "read-timeout" // 读取页面超时
  | "read-failed" // 读取页面的其他失败
  | "snapshot-stale" // confirm 行等待期间快照随 worker 重启丢失
  // 抓取阶段
  | "gate-login" // 登录墙
  | "gate-challenge" // 人机验证
  | "gate-forbidden" // 无下载权限
  | "gate-error" // 站点错误页
  | "network" // 网络连接失败
  | "pdf-unavailable" // PDF 链接在但下载不到（空响应）
  | "not-pdf" // 字节校验不是 PDF
  | "local-file-moved" // 本地文件读不到且「允许访问文件网址」已开
  | "file-access-denied" // 本地文件读不到且「允许访问文件网址」没开
  | "nothing-to-import" // 无标识符也无内容
  // 上传阶段
  | "auth-revoked" // 配对令牌被吊销
  | "server" // 服务端 4xx/5xx
  | "browser-interrupted" // worker 被杀、字节丢失
  | "unknown";

/** 结构化失败：kind 驱动文案，raw 只作排查线索。 */
export interface CaptureFailure {
  kind: FailureKind;
  raw?: string;
}

/**
 * What a failed task's retry button should do.
 * - `auto`            — a transient error still being auto-retried; no button yet.
 * - `manual-upload`   — bytes are in hand, upload failed → re-enqueue upload.
 * - `manual-reimport` — bytes lost / download failed → reopen the origin page.
 * - `none`            — permanent (no PDF, bad page); nothing to retry.
 */
export type RetryKind = "auto" | "manual-upload" | "manual-reimport" | "none";

/**
 * 卡片上可执行的动作（「重试 / 跳转原页面重试 / 更新为新 PDF」），由
 * background 按记录的**真实可执行条件**（payload 是否在手、失败原因）投影；
 * popup 只渲染，不从 retry 档位反推——渲染与执行同源，死按钮在结构上画不出来。
 */
export type CaptureActionKind = "retry-upload" | "reimport" | "replace";

/**
 * The resolved payload produced by the acquire phase and consumed by upload.
 * In-memory only — never persisted (bytes aren't written to chrome.storage;
 * see the CaptureRecord note). Held on the record so an upload-phase retry can
 * re-run without re-downloading.
 */
export interface AcquiredPayload {
  file: PdfFileAsset | null;
  /**
   * Full text existed but a gate stood in front of it (login wall, anti-bot
   * challenge, no entitlement, vendor error), so this import is metadata-only
   * for a reason the user can act on — and then finish via 取原文. Kept separate
   * from "the page offered no full text at all", which they cannot fix.
   */
  gate?: GateKind | null;
  pageHtml: string | null;
  metadata: Record<string, unknown> | null;
  resolverSource: string;
  identifier: string | null;
  originUrl: string;
  /** 非空 = 让服务端跳过这些 enrich 来源（白名单 openalex）；题录已齐全时的省额度信号。 */
  skipEnrichSources?: string[];
}

/** 可导入目标：个人文库（teamId=null）之外的可写团队，self/status 下发。 */
export interface TeamTarget {
  id: string;
  name: string;
}

/**
 * In-memory / storage representation of a manual capture task.
 * NOTE: `payload` (which carries the downloaded bytes) is stripped before
 * persisting to chrome.storage — bytes live only in the service-worker heap.
 */
export interface CaptureRecord {
  captureId: string;
  sourceId?: string;
  apiBaseUrl: string;
  deviceToken: string;
  tabId: number | null;
  originUrl: string;
  /** Dedup key component (with originUrl) and provenance for the backend. */
  identifier: string | null;
  /** Human label of the source host, e.g. "CNKI" / "arXiv", for the list row. */
  sourceSite?: string;
  title?: string;
  /** 导入目标团队；null/缺省 = 个人文库。入队时锁定，排队/重试不丢目标。 */
  teamId?: string | null;
  /** 团队显示名（入队时快照），队列卡片展示去向用。 */
  teamName?: string;
  state: CaptureState;
  step: CaptureStep;
  progress: number;
  detail?: string;
  done: boolean;
  /** 终态完成时刻；列表自动清理的 TTL 按它计（旧持久化记录缺省回落 createdAt）。 */
  completedAt?: number;
  /** 新失败一律写这里；error 是旧持久化记录的遗留字段，读回落用、不再写。 */
  failure?: CaptureFailure;
  /** @deprecated 旧版 background 持久化的自由串错误；唤醒时归一进 failure。 */
  error?: string;
  message?: string;
  retry: RetryKind;
  /** Auto-retry attempt counter (0 on first run). */
  attempt: number;
  createdAt: number;
  /** In-memory only; excluded from persistCaptures serialization. */
  payload?: AcquiredPayload;
  /** Set when confirming a `conflict`: the existing source whose PDF to replace. */
  replaceSourceId?: string;
  /** Completed as a no-op — the paper was already in the library. */
  alreadyInLibrary?: boolean;
  /** 完成后落成的内容形态；仅 completed 时有值。 */
  resultKind?: CaptureResultKind;
  /** 完成时按 sourceId 与实际落库空间算好的文库深链；无 sourceId 为 null。 */
  libraryUrl?: string | null;
}

/**
 * Serialized, secret-free view of a CaptureRecord for the popup/panel list.
 * Excludes deviceToken and the byte payload.
 */
export interface CaptureView {
  captureId: string;
  originUrl: string;
  title?: string;
  sourceSite?: string;
  /** 导入目标团队名；个人文库或缺省不显示。 */
  teamName?: string;
  state: CaptureState;
  step: CaptureStep;
  progress: number;
  detail?: string;
  failure?: CaptureFailure;
  message?: string;
  /** 卡上可点的动作集合（见 CaptureActionKind）；空数组 = 无动作可执行。 */
  actions: CaptureActionKind[];
  done: boolean;
  createdAt: number;
  /** 终态完成时刻（相对时间展示用）；缺省回落 createdAt。 */
  completedAt?: number;
  /** Completed as a no-op — the paper was already in the library. */
  alreadyInLibrary?: boolean;
  /** 完成后落成的内容形态；仅 completed 时有值。 */
  resultKind?: CaptureResultKind;
  /** 完成后指向文库条目的深链（完成时按 sourceId 与目标空间算好）；无则不出「在文库中查看」。 */
  libraryUrl?: string | null;
}

/** Whole-list broadcast over the progress port — the UI renders it verbatim. */
export interface CaptureListMessage {
  type: "mango-write/capture-list";
  captures: CaptureView[];
  /** 补全/更正任务（与导入队列同端口下发，弹窗把两者渲染进同一个任务列表）。 */
  completions?: CompletionView[];
}

/**
 * 补全/更正回路任务。一条持久文献对象的题录更新：
 * 派发时快照目标 sourceId + 任务环境 + 可读题名；任务跨「受控搜索 → 详情
 * 新标签 / 登录跳转」延续（openerTabId 继承），绝不按同域标签泛绑。详情页
 * 识别出的题录先成确认卡（awaiting-confirm），用户明确拍板后才回填；错配
 * （mismatch）展示差异、允许「仍要更新」，不凭原错误标题永久挡更正。
 */
export interface CompletionTask {
  sourceId: string;
  token: string;
  /** 任务环境：派发时快照的 apiBaseUrl，绝不用 active 环境取代任务环境。 */
  apiBaseUrl: string;
  /** 目标可读题名/DOI：确认卡与错配对照用。 */
  targetTitle: string | null;
  targetDoi: string | null;
  /** 已关联标签（派发检索标签 + 从它新开/登录跳转延续的标签）。 */
  tabIds: number[];
  createdAt: number;
  /** 待确认的详情页捕获；null = 还在等用户点到详情页。 */
  pending: CompletionPendingCapture | null;
  status: "active" | "applying" | "done" | "failed";
  /** 识别出的题名与目标题名明显冲突（服务端 409）：展示差异，待明确确认。 */
  mismatch: boolean;
  /** 服务端 409 的错配归因：题名不像 / 目标无可核对身份 / DOI 冲突。 */
  mismatchReason?: CompletionMismatchReason | null;
  /** 错配归因 = doi 时两边 DOI 都摆出来（identity 时有几展几）。 */
  expectedDoi?: string | null;
  capturedDoi?: string | null;
  message?: string;
  /** 回填成功时被吸收的重复 sourceId（服务端撞库合并结果）。 */
  absorbedSourceIds?: string[];
  /** 被吸收重复条目的题名（确认卡说明实际合并对象用）。 */
  absorbedTitles?: string[];
}

/** 服务端 409 错配归因（与 API CompletionMismatchReason 同值）。 */
export type CompletionMismatchReason = "title" | "identity" | "doi";

/** 详情页识别出、等待用户确认的题录（只带回填必需字段，不带页面字节）。 */
export interface CompletionPendingCapture {
  metadata: Record<string, unknown>;
  resolverSource: string;
  originUrl: string | null;
  capturedTitle: string | null;
}

/** Serialized, secret-free view of a CompletionTask for the popup list. */
export interface CompletionView {
  sourceId: string;
  tabIds?: number[];
  targetTitle: string | null;
  targetDoi: string | null;
  status: CompletionTask["status"];
  mismatch: boolean;
  mismatchReason?: CompletionMismatchReason | null;
  expectedDoi?: string | null;
  capturedDoi?: string | null;
  capturedTitle: string | null;
  /** 待确认捕获的紧凑题录摘要（作者/年/来源/DOI），确认卡上供用户核对。 */
  capturedSummary?: CompletionCaptureSummary | null;
  message?: string;
  absorbedSourceIds?: string[];
  absorbedTitles?: string[];
  /** 回填成功后「在文库中查看」的深链（任务环境的阅读页）。 */
  libraryUrl?: string | null;
  createdAt: number;
  /** 有待确认捕获时可执行「更新」；否则只是等待/说明卡。 */
  actionable: boolean;
}

/** 待确认捕获的紧凑题录摘要：确认前让用户核对的正是这些字段。 */
export interface CompletionCaptureSummary {
  authors: string | null;
  year: string | null;
  venue: string | null;
  doi: string | null;
}

/**
 * The observed fact about a tab's main document: the Content-Type of its
 * main-frame response, as recorded by the background's webRequest listener.
 * `kind: "pdf"` is the authoritative signal that the tab is Chrome's native
 * PDF viewer — content scripts run and answer pings there, so "no content
 * script" can no longer be used to detect it.
 */
export interface TabDocumentInfo {
  kind: "pdf" | "html" | "unknown";
  /** Raw Content-Type header value of the main-frame response, when seen. */
  contentType: string | null;
  /** URL the record was observed for (the final response after redirects). */
  url: string;
}

/** Persisted extension settings surfaced in the popup's settings sub-page. */
export interface ExtensionSettings {
  /** Whether the on-page floating action button (FAB) is shown. */
  fabEnabled: boolean;
}

export type BackgroundMessage =
  | {
      // Import entry point: the popup (or panel) hands over the active tab and
      // the chosen target; the background immediately registers the queue row
      // and orchestrates the in-page read itself. The sender's lifetime ends
      // here — closing the popup right after clicking can no longer lose the
      // capture, because the read's result flows tab → service worker, never
      // through the popup.
      type: "mango-write/begin-capture";
      tabId: number | null;
      teamId: string | null;
      /** 目标团队显示名快照，队列卡片展示去向（个人文库不传）。 */
      teamName?: string | null;
    }
  // User confirmed the queue card of a "confirm"-state row: import the held
  // webpage snapshot as a webpage entry.
  | { type: "mango-write/confirm-webpage-capture"; captureId: string }
  // The active tab IS a PDF (native viewer → no content script/translator). The
  // popup hands over the tab URL; the background fetches + verifies the bytes.
  | {
      type: "mango-write/import-pdf-url";
      url: string;
      title: string | null;
      tabId: number | null;
      teamId: string | null;
      teamName?: string | null;
    }
  | { type: "mango-write/get-recognized-state"; tabId: number }
  // popup → background：这个标签页的主文档是什么（webRequest 观察到的
  // main-frame Content-Type 事实），PDF/网页路由的权威判据。
  | { type: "mango-write/get-tab-document"; tabId: number }
  // popup → background：标签页早于监听器/扩展更新，content script 失效且无
  // Content-Type 记录时，直接 GET 一段头字节判定该 URL 是 PDF 还是网页。
  | { type: "mango-write/probe-url"; url: string }
  // Content script → background: fetch a cross-origin stylesheet for the
  // single-file snapshot (content-script fetches are CORS-bound to the page).
  | { type: "mango-write/fetch-css-text"; url: string }
  // Content script → background: fetch a cross-origin image as a data: URI
  // so the snapshot can inline it (same CORS constraint as stylesheets).
  | { type: "mango-write/fetch-image-datauri"; url: string }
  | { type: "mango-write/get-pairing-state" }
  | { type: "mango-write/logout" }
  // Popup switching which paired environment captures go to (admins only —
  // the entry point is gated on the server-resolved canSwitchEnv flag).
  | { type: "mango-write/switch-env"; origin: string }
  | { type: "mango-write/get-captures" }
  | { type: "mango-write/retry-capture"; captureId: string }
  | { type: "mango-write/reimport-capture"; captureId: string }
  | { type: "mango-write/confirm-replace-capture"; captureId: string }
  | { type: "mango-write/cancel-capture"; captureId: string }
  | { type: "mango-write/dismiss-capture"; captureId: string }
  | { type: "mango-write/clear-finished-captures" }
  | { type: "mango-write/get-settings" }
  | { type: "mango-write/set-settings"; settings: Partial<ExtensionSettings> }
  // 补全回路：用户在确认卡上拍板。allowMismatch = 已核对题名/DOI 差异仍要更新。
  | { type: "mango-write/apply-completion"; sourceId: string; allowMismatch?: boolean }
  // 补全回路：放弃这个任务（票作废，回文库可重新发起）。
  | { type: "mango-write/cancel-completion"; sourceId: string }
  // Content-script relay of a web-app bridge message (see bridge.ts). The
  // payload is an ExternalBackgroundMessage; the background routes it to the
  // same handler as onMessageExternal.
  | { type: "mango-write/bridge"; message: ExternalBackgroundMessage };

/**
 * Sent by the web app — either via the postMessage bridge (bridge.ts, the
 * primary channel, no extension ID needed) or directly over
 * chrome.runtime.sendMessage(extensionId, ...) with the origin whitelisted in
 * manifest.json `externally_connectable` (fallback for older web builds).
 * See extension-token.ts on the API side for the paired mint-then-push design
 * this implements.
 */
export type ExternalBackgroundMessage =
  | {
      // 模式 B：网页端点「取原文」后把一次性票据直接推给插件——
      // 票据不走出版商 URL query（浏览器历史 / Referer 泄漏，规格见
      // import.md）。插件自己开出版商标签并盯它加载完成。
      type: "mango-write/fetch-origin";
      originUrl: string;
      token: string;
      sourceId: string;
    }
  | {
      // 补全/更正回路（#100 D1）：网页端点「更正文献信息」后推来一次性补全票
      // + 站点检索链接 + 目标快照。插件开检索标签，任务跨新标签/登录跳转延续
      // （openerTabId 继承）；详情页认出论文后先出确认卡，用户明确确认才把
      // plugin-dom-* 题录回填到票面指定的 source。同一绑定语义：只对指定
      // source、回填成功才消费票、失败不串用户。apiBaseUrl 是派发时的任务
      // 环境——插件所有这个任务的请求都用它，绝不用 active 环境取代。
      type: "mango-write/complete-metadata";
      searchUrl: string;
      token: string;
      sourceId: string;
      apiBaseUrl: string;
      targetTitle?: string | null;
      targetDoi?: string | null;
    }
  | { type: "mango-write/ping" }
  | {
      type: "mango-write/pair";
      /** Raw `mwx_...` token from POST /api/import/extension/pair — shown once. */
      token: string;
      /** extension_tokens row id, for revoke calls from the web app's device list. */
      tokenId: string;
      user: PairedUserInfo;
      /**
       * Origin of the web app that minted the token above (e.g.
       * https://mangowrite.com or http://localhost:5173). The extension
       * uses this — not its own build-time API_BASE_URL — for every call made
       * with this pairing, so a locally-loaded unpacked build can pair against
       * whichever environment served the page without a rebuild.
       */
      apiBaseUrl: string;
      /**
       * Server-resolved (capability `extension.env.switch`): may this account
       * point the extension at non-production environments? Sent as a boolean
       * so the extension never handles role strings. Controls whether the
       * switcher is offered, which is product visibility — not an access
       * boundary; that boundary is each environment's own sign-in.
       */
      canSwitchEnv?: boolean;
    }
  | {
      /**
       * This origin's own pairing slot, scoped by the sender's origin (the
       * install holds one slot per environment; a page never sees or affects
       * the others). Response shape: { paired, user, tokenId, apiBaseUrl }.
       */
      type: "mango-write/get-pairing-state";
    }
  | {
      /**
       * "Should I pair this origin?" — asked by every web-app tab on load and
       * on focus, answered by the background so only one tab mints a token.
       * See shouldAutoPair() in background.ts.
       */
      type: "mango-write/should-auto-pair";
      apiBaseUrl: string;
      userId: string;
    }
  /** Web app reads the install id so the mint can dedupe this device's row. */
  | { type: "mango-write/get-device-id" }
  | {
      /**
       * 网页端把「当前所在空间」（个人 = null，团队 = team id）推给插件，
       * 作为插件导入目标选择器的默认项。只影响默认选择，不是授权事实——
       * 服务端导入时仍按 resolveTeamEntityAccess 重新判权。按发送方 origin
       * 写进它自己的配对槽位。
       */
      type: "mango-write/set-active-space";
      spaceId: string | null;
    }
  | {
      type: "mango-write/unpair";
      /**
       * Whether this disconnect is the user's own decision (default true) and
       * should therefore suppress auto-pairing for the origin. The web app
       * passes false when it drops a pairing for hygiene — e.g. this origin's
       * slot belongs to a different account than the one signed in here —
       * because that must not read as "the user opted out of auto-connect".
       *
       * The drop is scoped to the sender's origin: other environments' slots
       * survive (they were killed by mistake when this cleared the active
       * slot).
       */
      optOut?: boolean;
    }
  /**
   * Manual-upgrade final step: the guide page asks the extension to
   * chrome.runtime.reload() itself after the user has overwritten the install
   * directory with the new zip's contents. Only meaningful for sideloaded
   * (load-unpacked) installs; store builds update via the store.
   */
  | { type: "mango-write/reload-self" };

export type { Attachment };
