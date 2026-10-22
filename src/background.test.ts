/**
 * Service-worker 侧导入队列的生命周期测试。
 *
 * background.ts 在模块顶层注册全部 chrome 事件监听并立即跑唤醒收尾逻辑，
 * 所以每个用例都先装一个全新的 chrome mock、再动态 import 拿到干净的模块态
 * （captures 注册表是模块级 Map）。
 *
 * api.js 被整体 mock：这些用例验证的是队列编排（进度广播、持久化、续跑），
 * 不是 HTTP 层——HTTP 层的职责由 api.test.ts 覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureListMessage, CaptureRecord, CaptureResult, CaptureView } from "./protocol.js";

const apiMocks = vi.hoisted(() => {
  // 与 api.ts 的同名类同形（status + message + detail）：api.js 被整体 mock，
  // background 的 instanceof 分支必须认这个。detail 是服务端 409 body——
  // 文件冲突与题录错配都是 409，靠 body 的 error 码分开。
  class CompletionSubmitError extends Error {
    readonly status: number;
    readonly detail: Record<string, unknown> | null;

    constructor(status: number, message: string, detail: Record<string, unknown> | null = null) {
      super(message);
      this.status = status;
      this.detail = detail;
    }
  }
  return {
    checkDeviceTokenValid: vi.fn(async () => ({ valid: true, membership: null, teams: [] })),
    checkLibraryDuplicate: vi.fn(async () => ({ inLibrary: false, hasContent: false })),
    completeOriginMetadata: vi.fn(async () => ({
      appliedFields: ["DOI"],
      needsCompletion: false,
      absorbedSourceIds: [] as string[],
      absorbedTitles: [] as string[],
    })),
    CompletionSubmitError,
    downloadAttachment: vi.fn(),
    downloadPdfCandidate: vi.fn(async () => ({ file: null })),
    extractPluginPdfCandidates: vi.fn(async () => []),
    reportPluginEvents: vi.fn(async () => {}),
    reportPluginFailure: vi.fn(async () => {}),
    requestPluginSession: vi.fn(async () => ({ token: "sess-ticket" })),
    resolvePdfFilename: vi.fn(() => "document.pdf"),
    revokeSelf: vi.fn(async () => {}),
    uploadOriginPdf: vi.fn(async () => ({})),
    uploadPluginCapture: vi.fn(),
  };
});

vi.mock("./api.js", () => apiMocks);

const openalexMocks = vi.hoisted(() => ({
  lookupOpenAlexByDoi: vi.fn(async () => null),
}));

vi.mock("./openalex-lookup.js", () => openalexMocks);

// 日志与构建横幅对本测试正交；mock 掉避免 chrome.runtime.getManifest 依赖与噪音。
vi.mock("./env.js", () => ({
  VERSION: "0.0.0-test",
  BUILD_ID: "test",
  BUILD_ENV: "test",
  IS_DEV: false,
  STORE_DNR_REFERER: true,
  logBuildBanner: () => {},
  debugLog: () => {},
  debugWarn: () => {},
  debugError: () => {},
  isContextInvalidatedError: () => false,
}));

const PAIRING = {
  deviceToken: "mwx_test_device",
  tokenId: "tok-1",
  user: { id: "u1", email: "u@example.com", name: null },
  pairedAt: 1,
  apiBaseUrl: "https://api.example.com",
};

const CAPTURE: CaptureResult = {
  originUrl: "https://arxiv.org/abs/2401.00001",
  title: "A Paper",
  identifier: "doi:10.0000/test",
  pageHtml: "",
  pageHtmlKind: "raw",
  recognized: true,
  metadata: { title: "A Paper" },
  resolverSource: "plugin-dom",
  attachments: [
    { kind: "pdf", url: "https://arxiv.org/pdf/2401.00001", mime: "application/pdf", filename: "a.pdf" },
  ],
  allowGenericPdfDiscovery: false,
  allowRawHtmlFallback: false,
};

type Listener = (...args: never[]) => unknown;

interface FakePort {
  name: string;
  posted: CaptureListMessage[];
  onMessage: { addListener: (fn: (msg: CaptureListMessage) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  postMessage: (msg: CaptureListMessage) => void;
  disconnect: () => void;
}

function makeChromeHarness(storageSeed: { local?: Record<string, unknown>; session?: Record<string, unknown> } = {}) {
  const localStore = new Map<string, unknown>(Object.entries(storageSeed.local ?? {}));
  const sessionStore = new Map<string, unknown>(Object.entries(storageSeed.session ?? {}));
  const storageSetSpy = vi.fn((obj: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(obj)) localStore.set(k, v);
    return Promise.resolve();
  });

  const listeners = {
    connect: [] as Array<(port: FakePort) => void>,
    message: [] as Array<(msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean>,
    externalMessage: [] as Array<(msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean>,
    alarm: [] as Array<(alarm: { name: string }) => void>,
    tabUpdated: [] as Listener[],
    tabCreated: [] as Listener[],
    tabRemoved: [] as Listener[],
    installed: [] as Listener[],
    webRequestHeaders: [] as Array<(details: unknown) => unknown>,
  };

  const chromeMock = {
    runtime: {
      getManifest: () => ({ version: "0.0.0-test" }),
      getURL: (p: string) => `chrome-extension://test/${p}`,
      getPlatformInfo: vi.fn(async () => ({})),
      onConnect: { addListener: (fn: (port: FakePort) => void) => listeners.connect.push(fn) },
      onMessage: {
        addListener: (fn: (typeof listeners.message)[number]) => listeners.message.push(fn),
      },
      onMessageExternal: {
        addListener: (fn: (typeof listeners.externalMessage)[number]) => listeners.externalMessage.push(fn),
      },
      onInstalled: { addListener: (fn: Listener) => listeners.installed.push(fn) },
    },
    tabs: {
      onUpdated: { addListener: (fn: Listener) => listeners.tabUpdated.push(fn) },
      onCreated: { addListener: (fn: Listener) => listeners.tabCreated.push(fn) },
      onRemoved: { addListener: (fn: Listener) => listeners.tabRemoved.push(fn) },
      create: vi.fn(async () => ({ id: 42 })),
      update: vi.fn(async () => ({ id: 42 })),
      sendMessage: vi.fn(async () => undefined),
      query: vi.fn(async () => []),
      // begin-capture 用它取当前标签的 URL/title 作为队列身份（内容脚本的
      // canonical 报告缺席时）。默认对准 CAPTURE 的页面，用例按需覆盖。
      get: vi.fn(async (tabId: number) => ({
        id: tabId,
        url: "https://arxiv.org/abs/2401.00001",
        title: "A Paper",
      })),
    },
    action: {
      setIcon: vi.fn(async () => {}),
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
    },
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: (fn: (alarm: { name: string }) => void) => listeners.alarm.push(fn) },
    },
    // file:// 读权限探针（本地 PDF 导入失败时区分「没开允许访问文件网址」
    // 与「文件被移走」）。默认开，用例按需覆盖。
    extension: {
      isAllowedFileSchemeAccess: vi.fn((cb: (allowed: boolean) => void) => cb(true)),
    },
    storage: {
      local: {
        // 真实 chrome.storage.local.get 收 string | string[] | object；
        // 这里必须同样宽，否则多键读取（配对表 + 遗留键一次取回）在假实现下
        // 静默返回 {}，测试会以"没配对"的形式假失败。
        get: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const key of list) {
            if (localStore.has(key)) out[key] = localStore.get(key);
          }
          return out;
        }),
        set: storageSetSpy,
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) localStore.delete(key);
        }),
      },
      session: {
        get: vi.fn(async (key: string) => (sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {})),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
        }),
      },
    },
    notifications: { create: vi.fn(async () => "notif-id") },
    declarativeNetRequest: {
      getDynamicRules: vi.fn(async () => []),
      updateDynamicRules: vi.fn(async () => {}),
    },
    webRequest: {
      onHeadersReceived: {
        addListener: (fn: (details: unknown) => unknown) => listeners.webRequestHeaders.push(fn),
      },
    },
  };

  vi.stubGlobal("chrome", chromeMock);
  return { chromeMock, listeners, localStore, sessionStore, storageSetSpy };
}

function connectPopup(listeners: ReturnType<typeof makeChromeHarness>["listeners"]): FakePort {
  const messageListeners: Array<(msg: CaptureListMessage) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const port: FakePort = {
    name: "mango-write/capture-progress",
    posted: [],
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    postMessage(msg) {
      this.posted.push(msg);
      for (const fn of messageListeners) fn(msg);
    },
    disconnect() {
      for (const fn of disconnectListeners) fn();
    },
  };
  for (const fn of listeners.connect) fn(port);
  return port;
}

function sendBackgroundMessage(
  listeners: ReturnType<typeof makeChromeHarness>["listeners"],
  message: unknown,
  sender: { tab?: { id?: number; url?: string }; url?: string } = { tab: { id: 1 } },
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const handler = listeners.message[0];
    if (!handler) return reject(new Error("no onMessage listener registered"));
    handler(message, sender, resolve);
  });
}

/** 以「某个 web 应用标签页里的 content script」身份发桥接消息。 */
function sendBridgeMessage(
  listeners: ReturnType<typeof makeChromeHarness>["listeners"],
  pageUrl: string,
  message: unknown,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return sendBackgroundMessage(listeners, { type: "mango-write/bridge", message }, {
    tab: { id: 1, url: pageUrl },
  });
}

/** 等待 condition 为真（vi.waitFor 只等「不抛错」，真值等待要用 waitUntil）。 */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  try {
    await vi.waitUntil(condition, { timeout: 2000, interval: 5 });
  } catch {
    throw new Error(`waitFor 超时：${label}`);
  }
}

/** 纯微任务冲刷 —— 假定时器下也能用（队列编排全是 promise 链，不靠 setTimeout）。 */
async function flushUntil(condition: () => boolean, label: string, maxTurns = 500): Promise<void> {
  for (let i = 0; i < maxTurns; i++) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error(`flushUntil 超时：${label}`);
}

function persistedCaptures(localStore: Map<string, unknown>): Array<Record<string, unknown>> {
  return (localStore.get("runningCaptures") as Array<Record<string, unknown>> | undefined) ?? [];
}

function flattenViews(port: FakePort, captureId: string): CaptureView[] {
  return port.posted
    .flatMap((msg) => msg.captures)
    .filter((view) => view.captureId === captureId);
}

async function loadBackground(seed?: { local?: Record<string, unknown>; session?: Record<string, unknown> }) {
  vi.resetModules();
  const harness = makeChromeHarness(seed);
  await import("./background.js");
  return harness;
}

type Harness = Awaited<ReturnType<typeof loadBackground>>;

/**
 * 点击即入队的入口：把内容脚本的「页面读取」结果 mock 到 tabs.sendMessage 上，
 * 再发 begin-capture。读取是后台 fire-and-forget 编排的，begin 返回时读取
 * 尚未落地——调用方后续用 flushUntil/waitFor 等队列推进即可。
 */
async function beginCaptureWith(
  harness: Harness,
  capture: CaptureResult | Error,
  tabId = 1,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  harness.chromeMock.tabs.sendMessage = vi.fn(async () => {
    if (capture instanceof Error) throw capture;
    return capture;
  }) as never;
  return sendBackgroundMessage(harness.listeners, {
    type: "mango-write/begin-capture",
    tabId,
  });
}

beforeEach(() => {
  apiMocks.downloadAttachment.mockResolvedValue({
    file: {
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      filename: "a.pdf",
      mime: "application/pdf",
    },
    gate: null,
  });
  apiMocks.uploadPluginCapture.mockResolvedValue({ sourceId: "src-1", alreadyInLibrary: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("后台续跑：popup 关闭不中断", () => {
  it("读取阶段关闭 popup：任务点击即入队，读取结果稍后落地，下载上传在 SW 里跑完", async () => {
    // 页面读取挂起，模拟用户点完导入立刻关掉弹窗（读取结果还没回来）。
    let releaseRead: (v: CaptureResult) => void = () => {};
    const { listeners, localStore, chromeMock } = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    const popup = connectPopup(listeners);
    chromeMock.tabs.sendMessage = vi.fn(
      () => new Promise<CaptureResult>((resolve) => (releaseRead = resolve)),
    ) as never;

    const response = await sendBackgroundMessage(listeners, {
      type: "mango-write/begin-capture",
      tabId: 1,
    });
    expect(response.ok).toBe(true);
    const captureId = (response.result as { captureId: string }).captureId;

    // 点击后立刻入队：队列里已能看到「正在读取页面」的任务。
    await flushUntil(() => {
      const view = popup.posted.at(-1)?.captures.find((v) => v.captureId === captureId);
      return view?.state === "acquiring" && view.step === "capturing";
    }, "点击即入队（读取中）");

    // 关闭 popup，然后页面读取才返回——结果直接回后台，与弹窗死活无关。
    popup.disconnect();
    releaseRead(CAPTURE);
    await flushUntil(() => apiMocks.uploadPluginCapture.mock.calls.length === 1, "上传开始");

    await waitFor(
      () => persistedCaptures(localStore).some((r) => r.captureId === captureId && r.done === true),
      "popup 关闭后捕获跑完",
    );
    const [record] = persistedCaptures(localStore);
    expect(record).toMatchObject({ captureId, state: "completed", progress: 100, sourceId: "src-1" });
  });

  it("上传进行中关闭 popup：任务不中断，重开的 popup 立即追上队列现状", async () => {
    // 上传挂起，让「进行中」窗口可被观察。
    let releaseUpload: (v: { sourceId: string }) => void = () => {};
    apiMocks.uploadPluginCapture.mockImplementation(
      () => new Promise((resolve) => (releaseUpload = resolve)),
    );
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    const popup = connectPopup(harness.listeners);

    const response = await beginCaptureWith(harness, CAPTURE);
    expect(response.ok).toBe(true);
    const captureId = (response.result as { captureId: string }).captureId;
    await flushUntil(() => apiMocks.uploadPluginCapture.mock.calls.length === 1, "上传开始");

    // 上传进行中关闭 popup —— 任务不中断。
    popup.disconnect();

    // 中途重开的 popup 连接即收到全量列表，直接看到进行中的任务。
    const reopened = connectPopup(harness.listeners);
    expect(reopened.posted.length).toBeGreaterThan(0);
    const inFlight = reopened.posted[0].captures.find((v) => v.captureId === captureId);
    expect(inFlight).toMatchObject({ state: "uploading", done: false });
    reopened.disconnect();

    // 再次没有任何端口连着，上传照样跑完并持久化终态。
    releaseUpload({ sourceId: "src-1" });
    await flushUntil(
      () => persistedCaptures(harness.localStore).some((r) => r.captureId === captureId && r.done === true),
      "popup 关闭后捕获跑完",
    );
    const [record] = persistedCaptures(harness.localStore);
    expect(record).toMatchObject({ captureId, state: "completed", progress: 100, sourceId: "src-1" });
  });

  it("读取期间页面跳转（消息通道随 content script 死亡）：任务判失败并提示回原页重导", async () => {
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    connectPopup(harness.listeners);

    const response = await beginCaptureWith(
      harness,
      new Error("Error: The message port closed before a response was received."),
    );
    expect(response.ok).toBe(true);

    await waitFor(
      () => persistedCaptures(harness.localStore).some((r) => r.state === "failed"),
      "读取中断落账",
    );
    const [record] = persistedCaptures(harness.localStore);
    expect(record).toMatchObject({ state: "failed", retry: "manual-reimport" });
    expect(record.failure?.kind).toBe("page-interrupted");
  });

  it("标签页压根没有 content script（内置页）：判失败并说明页面未接入", async () => {
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    connectPopup(harness.listeners);

    await beginCaptureWith(
      harness,
      new Error("Could not establish connection. Receiving end does not exist."),
    );

    await waitFor(
      () => persistedCaptures(harness.localStore).some((r) => r.state === "failed"),
      "未接入落账",
    );
    const [record] = persistedCaptures(harness.localStore);
    expect(record.failure?.kind).toBe("page-unreachable");
  });

  it("同一页面重复点击：begin 按 originUrl 去重，不建第二条任务", async () => {
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    connectPopup(harness.listeners);
    // 读取永远挂起，第一条任务停在读取中。
    harness.chromeMock.tabs.sendMessage = vi.fn(
      () => new Promise<CaptureResult>(() => {}),
    ) as never;

    const first = await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/begin-capture",
      tabId: 1,
    });
    const second = await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/begin-capture",
      tabId: 1,
    });

    expect(first.ok).toBe(true);
    expect(second.result).toEqual({ message: "该文献已在导入队列中" });
    expect(persistedCaptures(harness.localStore)).toHaveLength(1);
  });

  it("字节负载只活在 service worker 堆内，持久化与对外视图都不泄漏敏感字段", async () => {
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    const { listeners, localStore, storageSetSpy } = harness;
    connectPopup(listeners);

    const response = await beginCaptureWith(harness, CAPTURE);
    const captureId = (response.result as { captureId: string }).captureId;
    await waitFor(() => persistedCaptures(localStore).some((r) => r.done === true), "捕获跑完");

    // 全流程每一次持久化（含上传中 payload 在手的时刻）都不许把字节写进 storage。
    for (const call of storageSetSpy.mock.calls) {
      const [obj] = call as [Record<string, unknown>];
      const list = obj["runningCaptures"] as Array<Record<string, unknown>> | undefined;
      if (!list) continue;
      for (const record of list) {
        expect(record).not.toHaveProperty("payload");
      }
    }

    // popup 拿到的 CaptureView 是脱敏视图：不带 deviceToken，也不带字节。
    const listResponse = await sendBackgroundMessage(listeners, { type: "mango-write/get-captures" });
    const views = listResponse.result as Array<Record<string, unknown>>;
    const view = views.find((v) => v.captureId === captureId);
    expect(view).toBeDefined();
    expect(view).not.toHaveProperty("deviceToken");
    expect(view).not.toHaveProperty("payload");
    // 个人文库导入：完成时算好「在文库中查看」深链（环境 origin + 阅读页 /u/read/:id，
    // 与文库列表点开文献同一条路；旧值 /u/library/:id 是列表聚焦，用户要多找一次）。
    expect(view?.libraryUrl).toBe("https://api.example.com/u/read/src-1");
  });

  it("service worker 被杀后唤醒：storage 里未完成的捕获被判失败并提示重新导入", async () => {
    const stale: Partial<CaptureRecord> = {
      captureId: "dead-capture",
      apiBaseUrl: PAIRING.apiBaseUrl,
      deviceToken: PAIRING.deviceToken,
      tabId: null,
      originUrl: "https://arxiv.org/abs/2401.00002",
      identifier: null,
      state: "acquiring",
      step: "downloading",
      progress: 25,
      done: false,
      retry: "none",
      attempt: 0,
      createdAt: Date.now(),
    };
    const { localStore, chromeMock } = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING, runningCaptures: [stale] },
    });

    await waitFor(() => persistedCaptures(localStore).some((r) => r.captureId === "dead-capture" && r.done), "唤醒收尾");

    const [record] = persistedCaptures(localStore);
    expect(record).toMatchObject({
      captureId: "dead-capture",
      state: "failed",
      retry: "manual-reimport",
    });
    expect(record.failure?.kind).toBe("browser-interrupted");
    // 失败会发系统通知（静默成功、响铃失败的决策 8）。
    expect(chromeMock.notifications.create).toHaveBeenCalledWith(
      "mango-write-capture-dead-capture",
      expect.objectContaining({ title: expect.stringContaining("导入失败") }),
    );
  });

  it("队列有活动任务时保持 service worker 存活，跑完后停止心跳", async () => {
    // 假定时器必须在 import background 之前装好——keep-alive 的 setInterval
    // 在注册捕获时创建，之后换定时器就接管不到它了。
    vi.useFakeTimers();
    try {
      let releaseUpload: (v: { sourceId: string }) => void = () => {};
      apiMocks.uploadPluginCapture.mockImplementation(
        () => new Promise((resolve) => (releaseUpload = resolve)),
      );
      const harness = await loadBackground({
        local: { "mangoWrite.pairing": PAIRING },
      });
      connectPopup(harness.listeners);

      await beginCaptureWith(harness, CAPTURE);
      await flushUntil(() => apiMocks.uploadPluginCapture.mock.calls.length === 1, "上传开始");

      // 活动期内每 20s 一次心跳，重置 MV3 的 30s 空闲杀死计时。
      await vi.advanceTimersByTimeAsync(41_000);
      expect(harness.chromeMock.runtime.getPlatformInfo.mock.calls.length).toBeGreaterThanOrEqual(2);

      // 队列排空后心跳停止，worker 可以正常休眠。
      releaseUpload({ sourceId: "src-1" });
      await flushUntil(() => true, "flush");
      const callsAfterDone = harness.chromeMock.runtime.getPlatformInfo.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(harness.chromeMock.runtime.getPlatformInfo.mock.calls.length).toBe(callsAfterDone);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("导入进度数据：步骤与 0–100%", () => {
  it("begin-capture 全流程广播 capturing→downloading→queued→uploading→completed，进度单调升至 100", async () => {
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    const popup = connectPopup(harness.listeners);

    const response = await beginCaptureWith(harness, CAPTURE);
    const captureId = (response.result as { captureId: string }).captureId;
    await waitFor(() => {
      const views = flattenViews(popup, captureId);
      return views.length > 0 && views[views.length - 1].done;
    }, "进度广播到终态");

    const views = flattenViews(popup, captureId);
    const states = views.map((v) => v.state);
    // 关键阶段依次出现：读取+下载（acquiring）→ 排队 → 上传 → 完成。
    expect(states[0]).toBe("acquiring");
    expect(states).toContain("queued");
    expect(states).toContain("uploading");
    expect(states[states.length - 1]).toBe("completed");
    expect(states.indexOf("queued")).toBeLessThan(states.indexOf("uploading"));
    expect(states.indexOf("uploading")).toBeLessThan(states.lastIndexOf("completed"));

    // 进度始终在 [0,100]、单调不减、以 100 收尾。
    for (const view of views) {
      expect(view.progress).toBeGreaterThanOrEqual(0);
      expect(view.progress).toBeLessThanOrEqual(100);
    }
    const progresses = views.map((v) => v.progress);
    expect(progresses).toEqual([...progresses].sort((a, b) => a - b));
    expect(progresses[progresses.length - 1]).toBe(100);

    // 步骤标签随阶段推进：读取页面 → 下载 → 上传 → 完成。
    const steps = views.map((v) => v.step);
    expect(steps[0]).toBe("capturing");
    expect(steps).toContain("downloading");
    expect(steps).toContain("uploading");
    expect(steps[steps.length - 1]).toBe("completed");
  });

  it("下载阶段附带可读的字节进度 detail", async () => {
    apiMocks.downloadAttachment.mockImplementation(
      async (_attachment: unknown, _title: unknown, _fetchBytes: unknown, onProgress?: (l: number, t?: number) => void) => {
        onProgress?.(512 * 1024, 1024 * 1024);
        return { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), filename: "a.pdf", mime: "application/pdf" };
      },
    );
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    const popup = connectPopup(harness.listeners);

    const response = await beginCaptureWith(harness, CAPTURE);
    const captureId = (response.result as { captureId: string }).captureId;
    await waitFor(() => {
      const views = flattenViews(popup, captureId);
      return views.length > 0 && views[views.length - 1].done;
    }, "跑完");

    const details = flattenViews(popup, captureId)
      .map((v) => v.detail)
      .filter((d): d is string => Boolean(d));
    expect(details.some((d) => d.includes("已下载 0.5 / 1.0 MB (50%)"))).toBe(true);
  });

  it("进度广播限频：首拍前沿立即可见，窗口内的后续拍合并成一拍尾沿广播", async () => {
    let emitProgress: ((loaded: number, total?: number) => void) | undefined;
    let finishDownload!: (value: { bytes: Uint8Array; filename: string; mime: string }) => void;
    apiMocks.downloadAttachment.mockImplementation(
      (_a: unknown, _t: unknown, _f: unknown, onProgress?: (l: number, t?: number) => void) => {
        emitProgress = onProgress;
        return new Promise((resolve) => {
          finishDownload = resolve;
        });
      },
    );
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const popup = connectPopup(harness.listeners);

    await beginCaptureWith(harness, CAPTURE);
    await waitFor(() => typeof emitProgress === "function", "进入下载阶段");

    // 首拍：前沿立即广播。
    emitProgress!(512 * 1024, 1024 * 1024);
    await flushUntil(
      () => popup.posted.some((m) => m.captures.some((v) => v.detail?.includes("0.5 / 1.0"))),
      "前沿广播",
    );
    const baseline = popup.posted.length;

    // 窗口内连续 10 拍：一拍都不广播（等尾沿合并）。
    for (let i = 0; i < 10; i++) emitProgress!(600 * 1024 + i, 1024 * 1024);
    await new Promise((r) => setTimeout(r, 30));
    expect(popup.posted.length).toBe(baseline);

    // 窗口过后尾沿补一拍（且内容是最新的）。
    await new Promise((r) => setTimeout(r, 300));
    expect(popup.posted.length).toBe(baseline + 1);
    expect(popup.posted[popup.posted.length - 1]!.captures.some((v) => v.detail?.includes("0.6"))).toBe(true);

    finishDownload({ bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), filename: "a.pdf", mime: "application/pdf" });
    await waitFor(() => persistedCaptures(harness.localStore).some((r) => r.done === true), "跑完");
  });
});

describe("闸门页拦下后的用户提示", () => {
  // 取原文时撞上登录页/人机验证，是用户自己能解决的失败：必须说清「登录后重新
  // 导入」，而不是和「这页压根没有全文」一样只说「未取到原文」。
  it("附件全被闸门拦下时，完成消息告诉用户登录后重导，且绝不上传闸门页字节", async () => {
    apiMocks.downloadAttachment.mockResolvedValue({ file: null, gate: "login" });
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    connectPopup(harness.listeners);

    const response = await beginCaptureWith(harness, CAPTURE);
    const captureId = (response.result as { captureId: string }).captureId;
    await flushUntil(
      () => persistedCaptures(harness.localStore).some((r) => r.captureId === captureId && r.done === true),
      "闸门降级跑完",
    );

    // 题录照样入库（CAPTURE 带 identifier + metadata），但没有任何 file/pageHtml。
    expect(apiMocks.uploadPluginCapture).toHaveBeenCalledTimes(1);
    const uploaded = apiMocks.uploadPluginCapture.mock.calls[0]![0] as Record<string, unknown>;
    expect(uploaded.file).toBeNull();
    expect(uploaded.pageHtml).toBeNull();

    const [record] = persistedCaptures(harness.localStore);
    expect(record.state).toBe("completed");
    // 说清原因（登录）+ 说清补救入口（取原文），两者缺一用户就只能干瞪眼。
    expect(String(record.message)).toContain("站点要求登录");
    expect(String(record.message)).toContain("未取到原文");
    expect(String(record.message)).toContain("取原文");
  });

  it("没有闸门、只是这页没全文时，沿用原来的中性提示", async () => {
    apiMocks.downloadAttachment.mockResolvedValue({ file: null, gate: null });
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    connectPopup(harness.listeners);

    await beginCaptureWith(harness, CAPTURE);
    await flushUntil(
      () => persistedCaptures(harness.localStore).some((r) => r.done === true),
      "降级跑完",
    );

    const [record] = persistedCaptures(harness.localStore);
    expect(String(record.message)).toContain("已导入题录");
    expect(String(record.message)).toContain("手动下载 PDF");
    expect(String(record.message)).toContain("取原文");
  });

  // 下载前严格去重预检：库里已有且带文件 → 一次全文下载都不花，题录导入由
  // 服务端去重命中（合并 work 题录 + 重链）。
  it("预检命中（库里已有且带文件）：跳过下载，题录导入不带 file", async () => {
    apiMocks.checkLibraryDuplicate.mockResolvedValueOnce({ inLibrary: true, hasContent: true });
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    connectPopup(harness.listeners);

    await beginCaptureWith(harness, CAPTURE);
    await flushUntil(
      () => persistedCaptures(harness.localStore).some((r) => r.done === true),
      "预检命中跑完",
    );

    expect(apiMocks.checkLibraryDuplicate).toHaveBeenCalledTimes(1);
    expect(apiMocks.downloadAttachment).not.toHaveBeenCalled();
    expect(apiMocks.uploadPluginCapture).toHaveBeenCalledTimes(1);
    const uploaded = apiMocks.uploadPluginCapture.mock.calls[0]![0] as Record<string, unknown>;
    expect(uploaded.file).toBeNull();
    // 题录与标识照带：服务端靠它们走到去重命中与 work 合并。
    expect(uploaded.metadata).toEqual(CAPTURE.metadata);
    expect(uploaded.identifier).toBe(CAPTURE.identifier);
  });

  it("预检命中但库里条目还是纯题录（hasContent=false）：仍下载补文件", async () => {
    apiMocks.checkLibraryDuplicate.mockResolvedValueOnce({ inLibrary: true, hasContent: false });
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    connectPopup(harness.listeners);

    await beginCaptureWith(harness, CAPTURE);
    await flushUntil(
      () => persistedCaptures(harness.localStore).some((r) => r.done === true),
      "补文件跑完",
    );

    expect(apiMocks.downloadAttachment).toHaveBeenCalledTimes(1);
    const uploaded = apiMocks.uploadPluginCapture.mock.calls[0]![0] as Record<string, unknown>;
    expect(uploaded.file).not.toBeNull();
  });

  it("预检失败按未命中处理，照常下载——预检绝不挡导入", async () => {
    apiMocks.checkLibraryDuplicate.mockRejectedValueOnce(new Error("network"));
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    connectPopup(harness.listeners);

    await beginCaptureWith(harness, CAPTURE);
    await flushUntil(
      () => persistedCaptures(harness.localStore).some((r) => r.done === true),
      "失败开放跑完",
    );

    expect(apiMocks.downloadAttachment).toHaveBeenCalledTimes(1);
    const [record] = persistedCaptures(harness.localStore);
    expect(record.state).toBe("completed");
  });

  // 2026-08-26 线上排查：springer 找到 1 个附件候选但 fetch 硬失败，事件流里
  // 只剩光秃秃的 no-attachment，线上永远查不到是哪个 URL、什么原因挂的。
  it("附件下载失败时，pdf.attachment 事件的 detail 带上失败的 URL 与原因", async () => {
    apiMocks.downloadAttachment.mockResolvedValue({ file: null, gate: null, reason: "fetch-failed" });
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    connectPopup(harness.listeners);

    await beginCaptureWith(harness, CAPTURE);
    await flushUntil(
      () => persistedCaptures(harness.localStore).some((r) => r.done === true),
      "降级跑完",
    );

    const flushed = apiMocks.reportPluginEvents.mock.calls
      .flatMap((call) => (call[0]!.events as Array<Record<string, unknown>>));
    const event = flushed.find((e) => e.step === "pdf.attachment");
    expect(event).toMatchObject({
      status: "info",
      reason: "no-attachment",
    });
    expect(event!.detail).toEqual({
      attempts: [{ url: "https://arxiv.org/pdf/2401.00001", reason: "fetch-failed" }],
    });
  });
});

describe("未识别页面按网页导入", () => {
  const WEBPAGE_CAPTURE: CaptureResult = {
    recognized: false,
    originUrl: "https://blog.example/post-1",
    title: "A plain page",
    identifier: null,
    pageHtml: "<html><body><article>plain page body</article></body></html>",
    pageHtmlKind: "snapshot",
    metadata: {},
    resolverSource: "none",
    attachments: [],
    allowGenericPdfDiscovery: false,
    allowRawHtmlFallback: true,
  };

  /** 网页捕获先停在 confirm 态等用户裁决；这张卡片的 originUrl 对准 blog.example。 */
  async function beginWebpageCapture(webpageCapture: CaptureResult = WEBPAGE_CAPTURE) {
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    harness.chromeMock.tabs.get = vi.fn(async (tabId: number) => ({
      id: tabId,
      url: webpageCapture.originUrl,
      title: webpageCapture.title,
    })) as never;
    const response = await beginCaptureWith(harness, webpageCapture);
    const captureId = (response.result as { captureId: string }).captureId;
    await flushUntil(
      () => persistedCaptures(harness.localStore).some((r) => r.captureId === captureId && r.state === "confirm"),
      "网页捕获停到待确认",
    );
    return { harness, captureId };
  }

  it("读取完先停在 confirm 态，不自动落库；用户确认后才上传网页快照", async () => {
    const { harness, captureId } = await beginWebpageCapture();

    // 确认前：任务可见但什么都没传。
    expect(apiMocks.uploadPluginCapture).not.toHaveBeenCalled();
    const pending = persistedCaptures(harness.localStore).find((r) => r.captureId === captureId);
    expect(pending).toMatchObject({ state: "confirm", done: true });

    const confirmed = await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/confirm-webpage-capture",
      captureId,
    });
    expect(confirmed.ok).toBe(true);

    await flushUntil(
      () => persistedCaptures(harness.localStore).some((r) => r.captureId === captureId && r.done === true),
      "网页导入跑完",
    );

    expect(apiMocks.downloadAttachment).not.toHaveBeenCalled();
    expect(apiMocks.extractPluginPdfCandidates).not.toHaveBeenCalled();
    expect(openalexMocks.lookupOpenAlexByDoi).not.toHaveBeenCalled();

    expect(apiMocks.uploadPluginCapture).toHaveBeenCalledTimes(1);
    const uploaded = apiMocks.uploadPluginCapture.mock.calls[0]![0] as Record<string, unknown>;
    expect(uploaded.file).toBeNull();
    expect(uploaded.pageHtml).toContain("plain page body");
    expect(uploaded.metadata).toBeNull();
    expect(uploaded.identifier).toBeNull();
    expect(uploaded.title).toBe("A plain page");

    const [record] = persistedCaptures(harness.localStore);
    expect(record.state).toBe("completed");
    expect(String(record.message)).toBe("已按网页导入。");
  });

  it("确认前点取消：快照直接丢弃，不产生任何上传", async () => {
    const { harness, captureId } = await beginWebpageCapture();

    await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/dismiss-capture",
      captureId,
    });

    expect(apiMocks.uploadPluginCapture).not.toHaveBeenCalled();
    expect(persistedCaptures(harness.localStore)).toHaveLength(0);
  });

  it("网页快照本身是登录墙时，确认后不上传，按闸门失败处理", async () => {
    const gatedCapture: CaptureResult = {
      ...WEBPAGE_CAPTURE,
      pageHtml: '<html><head><title>用户登录</title></head><body><input type="password"/></body></html>',
    };
    const { harness, captureId } = await beginWebpageCapture(gatedCapture);

    await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/confirm-webpage-capture",
      captureId,
    });
    await flushUntil(
      () => persistedCaptures(harness.localStore).some((r) => r.captureId === captureId && r.done === true),
      "闸门判定跑完",
    );

    expect(apiMocks.uploadPluginCapture).not.toHaveBeenCalled();
    const [record] = persistedCaptures(harness.localStore);
    expect(record.state).toBe("failed");
    expect(record.failure?.kind).toBe("gate-login");
  });

  it("导入完成后向 web 应用标签广播 library-changed（仅白名单 origin）", async () => {
    const { harness, captureId } = await beginWebpageCapture();
    const { listeners, localStore, chromeMock } = harness;
    chromeMock.tabs.query = vi.fn(async () => [
      { id: 11, url: "https://mangowrite.com/library" },
      { id: 12, url: "http://localhost:5173/library" },
      { id: 13, url: "https://news.example.com/x" },
      { id: 14 },
    ]);

    await sendBackgroundMessage(listeners, {
      type: "mango-write/confirm-webpage-capture",
      captureId,
    });
    await flushUntil(() => persistedCaptures(localStore).some((r) => r.captureId === captureId && r.done === true), "网页导入跑完");
    // 广播在 completeCapture 里 fire-and-forget，等它追上来。
    await waitFor(
      () =>
        chromeMock.tabs.sendMessage.mock.calls.some(
          ([, msg]) => (msg as { type?: string }).type === "mango-write/library-changed",
        ),
      "library-changed 广播发出",
    );

    const broadcastTabIds = chromeMock.tabs.sendMessage.mock.calls
      .filter(([, msg]) => (msg as { type?: string }).type === "mango-write/library-changed")
      .map(([tabId]) => tabId)
      .sort();
    expect(broadcastTabIds).toEqual([11, 12]);
  });

  it("service worker 重启后，storage 里等确认的快照已丢失：判失败并提示重导", async () => {
    const stale: Partial<CaptureRecord> = {
      captureId: "confirm-lost",
      apiBaseUrl: PAIRING.apiBaseUrl,
      deviceToken: PAIRING.deviceToken,
      tabId: null,
      originUrl: "https://blog.example/post-1",
      identifier: null,
      state: "confirm",
      step: "capturing",
      progress: 30,
      done: true,
      retry: "none",
      attempt: 0,
      createdAt: Date.now(),
    };
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING, runningCaptures: [stale] },
    });

    await waitFor(
      () => persistedCaptures(harness.localStore).some((r) => r.captureId === "confirm-lost" && r.state === "failed"),
      "失效确认落账",
    );
    const [record] = persistedCaptures(harness.localStore);
    expect(record.failure?.kind).toBe("snapshot-stale");
    expect(apiMocks.uploadPluginCapture).not.toHaveBeenCalled();
  });

  it("唤醒后恢复的 manual-upload 失败行：字节已不在，降档成跳转原页面档位", async () => {
    const stale: Partial<CaptureRecord> = {
      captureId: "lost-bytes",
      apiBaseUrl: PAIRING.apiBaseUrl,
      deviceToken: PAIRING.deviceToken,
      tabId: null,
      originUrl: "https://arxiv.org/abs/2401.00003",
      identifier: null,
      state: "failed",
      step: "failed",
      progress: 70,
      done: true,
      failure: { kind: "network" },
      retry: "manual-upload",
      attempt: 3,
      createdAt: Date.now(),
    };
    const { localStore } = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING, runningCaptures: [stale] },
    });

    await waitFor(
      () => persistedCaptures(localStore).some((r) => r.captureId === "lost-bytes" && r.retry === "manual-reimport"),
      "降档落账",
    );
    const [record] = persistedCaptures(localStore);
    // 原始失败原因保留（换掉的只是可执行档位）；绝不重发上传。
    expect(record.failure?.kind).toBe("network");
    expect(apiMocks.uploadPluginCapture).not.toHaveBeenCalled();
  });

  it("唤醒后恢复的 conflict 行字节已不在：转失败行，不再空等更新裁决", async () => {
    const stale: Partial<CaptureRecord> = {
      captureId: "conflict-lost",
      apiBaseUrl: PAIRING.apiBaseUrl,
      deviceToken: PAIRING.deviceToken,
      tabId: null,
      originUrl: "https://arxiv.org/abs/2401.00004",
      identifier: null,
      state: "conflict",
      step: "uploading",
      progress: 100,
      done: true,
      retry: "none",
      attempt: 0,
      message: "这篇已在文献库中，但检测到 PDF 与现有的不同。",
      createdAt: Date.now(),
    };
    const { localStore } = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING, runningCaptures: [stale] },
    });

    await waitFor(
      () => persistedCaptures(localStore).some((r) => r.captureId === "conflict-lost" && r.state === "failed"),
      "降档落账",
    );
    const [record] = persistedCaptures(localStore);
    expect(record.retry).toBe("manual-reimport");
    expect(record.failure?.kind).toBe("browser-interrupted");
  });
});

describe("自动配对仲裁（一台浏览器开 N 个标签页只 mint 一次）", () => {
  const ask = (origin: string, userId = "u1") => ({
    type: "mango-write/bridge" as const,
    message: { type: "mango-write/should-auto-pair", apiBaseUrl: origin, userId },
  });

  const pair = (origin: string, userId = "u1") => ({
    type: "mango-write/bridge" as const,
    message: {
      type: "mango-write/pair",
      token: "mwx_test",
      tokenId: "tok-1",
      user: { id: userId, email: `${userId}@example.com`, name: null },
      apiBaseUrl: origin,
    },
  });

  it("只有第一个问的标签页被叫去配对，其余原地等着", async () => {
    const { listeners } = await loadBackground();

    const first = await sendBackgroundMessage(listeners, ask("https://mangowrite.com"));
    const second = await sendBackgroundMessage(listeners, ask("https://mangowrite.com"));
    const third = await sendBackgroundMessage(listeners, ask("https://mangowrite.com"));

    expect(first.result).toMatchObject({ pair: true });
    expect(second.result).toMatchObject({ pair: false, reason: "another_tab_pairing" });
    expect(third.result).toMatchObject({ pair: false, reason: "another_tab_pairing" });
  });

  it("已经配好同一个账号就不再配", async () => {
    const { listeners } = await loadBackground();
    await sendBackgroundMessage(listeners, pair("https://mangowrite.com"));

    const decision = await sendBackgroundMessage(listeners, ask("https://mangowrite.com"));

    expect(decision.result).toMatchObject({ pair: false, reason: "already_paired" });
  });

  it("换了账号要重新配——旧配对属于别人", async () => {
    const { listeners } = await loadBackground();
    await sendBackgroundMessage(listeners, pair("https://mangowrite.com", "u1"));

    const decision = await sendBackgroundMessage(listeners, ask("https://mangowrite.com", "u2"));

    expect(decision.result).toMatchObject({ pair: true });
  });

  it("不同 origin 各自独立：连了正式环境不妨碍本地环境再连", async () => {
    const { listeners } = await loadBackground();
    await sendBackgroundMessage(listeners, pair("https://mangowrite.com"));

    const decision = await sendBackgroundMessage(listeners, ask("http://localhost:5173"));

    expect(decision.result).toMatchObject({ pair: true });
  });

  it("用户主动断开后不再自动重连，否则断开按钮形同虚设", async () => {
    const { listeners } = await loadBackground();
    await sendBackgroundMessage(listeners, pair("https://mangowrite.com"));
    await sendBackgroundMessage(listeners, {
      type: "mango-write/bridge",
      message: { type: "mango-write/unpair" },
    });

    const decision = await sendBackgroundMessage(listeners, ask("https://mangowrite.com"));

    expect(decision.result).toMatchObject({ pair: false, reason: "opted_out" });
  });

  it("卫生清理（optOut:false）不算主动断开，之后照常自动连", async () => {
    const { listeners } = await loadBackground();
    await sendBackgroundMessage(listeners, pair("https://mangowrite.com", "u1"));
    await sendBackgroundMessage(listeners, {
      type: "mango-write/bridge",
      message: { type: "mango-write/unpair", optOut: false },
    });

    const decision = await sendBackgroundMessage(listeners, ask("https://mangowrite.com", "u2"));

    expect(decision.result).toMatchObject({ pair: true });
  });

  it("重新配对会解除 opt-out：用户显式连过就等于收回了断开的意思", async () => {
    const { listeners } = await loadBackground();
    await sendBackgroundMessage(listeners, pair("https://mangowrite.com"));
    await sendBackgroundMessage(listeners, {
      type: "mango-write/bridge",
      message: { type: "mango-write/unpair" },
    });
    await sendBackgroundMessage(listeners, pair("https://mangowrite.com", "u2"));

    const decision = await sendBackgroundMessage(listeners, ask("https://mangowrite.com", "u3"));

    expect(decision.result).toMatchObject({ pair: true });
  });
});

describe("多环境切换", () => {
  const pair = (origin: string, canSwitchEnv = false) => ({
    type: "mango-write/bridge" as const,
    message: {
      type: "mango-write/pair",
      token: "mwx_test",
      tokenId: `tok-${origin}`,
      user: { id: "u1", email: "u@example.com", name: null },
      apiBaseUrl: origin,
      canSwitchEnv,
    },
  });

  it("配对状态列出全部环境并标出 active", async () => {
    const { listeners } = await loadBackground();
    await sendBackgroundMessage(listeners, pair("https://mangowrite.com", true));
    await sendBackgroundMessage(listeners, pair("http://localhost:5173", true));

    const state = await sendBackgroundMessage(listeners, {
      type: "mango-write/get-pairing-state",
    });

    expect(state.result).toMatchObject({ canSwitchEnv: true, apiBaseUrl: "https://mangowrite.com" });
    const envs = (state.result as { environments: Array<{ origin: string; active: boolean }> })
      .environments;
    expect(envs.map((e) => e.origin).sort()).toEqual([
      "http://localhost:5173",
      "https://mangowrite.com",
    ]);
    expect(envs.filter((e) => e.active).map((e) => e.origin)).toEqual(["https://mangowrite.com"]);
  });

  it("切换后导入目标跟着换", async () => {
    const { listeners } = await loadBackground();
    await sendBackgroundMessage(listeners, pair("https://mangowrite.com", true));
    await sendBackgroundMessage(listeners, pair("http://localhost:5173", true));

    const switched = await sendBackgroundMessage(listeners, {
      type: "mango-write/switch-env",
      origin: "http://localhost:5173",
    });

    expect(switched.result).toMatchObject({ apiBaseUrl: "http://localhost:5173" });
  });

  it("canSwitchEnv 由服务端下发，普通账号配对后拿不到切换入口", async () => {
    const { listeners } = await loadBackground();
    await sendBackgroundMessage(listeners, pair("https://mangowrite.com", false));

    const state = await sendBackgroundMessage(listeners, {
      type: "mango-write/get-pairing-state",
    });

    expect(state.result).toMatchObject({ canSwitchEnv: false });
  });

  // 网页端的 get-pairing-state 按「问话页面的 origin」回答自己的槽位。早期实现
  // 回 active 槽位：每个环境都看到"配的是别人"，卫生清理 unpair 又清掉 active
  // 槽位，两个环境轮流互相清空——多环境永远只剩一个，切换器形同虚设。
  it("网页端查配对只见自己的环境：active 在别处也不串台", async () => {
    const { listeners } = await loadBackground();
    await sendBridgeMessage(listeners, "https://mangowrite.com/library", pair("https://mangowrite.com").message);
    // 第二个环境（不同账号）连上；active 仍是正式环境。
    await sendBridgeMessage(listeners, "http://localhost:5173/library", {
      type: "mango-write/pair",
      token: "mwx_local",
      tokenId: "tok-local",
      user: { id: "u-local", email: "dev@local.test", name: null },
      apiBaseUrl: "http://localhost:5173",
    });

    const fromProd = await sendBridgeMessage(listeners, "https://mangowrite.com/library", {
      type: "mango-write/get-pairing-state",
    });
    const fromLocal = await sendBridgeMessage(listeners, "http://localhost:5173/library", {
      type: "mango-write/get-pairing-state",
    });
    const fromUnknown = await sendBridgeMessage(listeners, "https://write.aidenchen.cn/library", {
      type: "mango-write/get-pairing-state",
    });

    expect(fromProd.result).toMatchObject({ paired: true, user: { id: "u1" }, apiBaseUrl: "https://mangowrite.com" });
    expect(fromLocal.result).toMatchObject({ paired: true, user: { id: "u-local" }, apiBaseUrl: "http://localhost:5173" });
    expect(fromUnknown.result).toMatchObject({ paired: false });
  });

  it("卫生清理只清自己环境的槽位，不再误杀别的环境", async () => {
    const { listeners } = await loadBackground();
    await sendBridgeMessage(listeners, "https://mangowrite.com/library", pair("https://mangowrite.com").message);
    await sendBridgeMessage(listeners, "http://localhost:5173/library", {
      type: "mango-write/pair",
      token: "mwx_local",
      tokenId: "tok-local",
      user: { id: "u-local", email: "dev@local.test", name: null },
      apiBaseUrl: "http://localhost:5173",
    });

    // localhost 页面发现本环境槽位属于另一个账号 → 卫生清理（optOut:false）。
    await sendBridgeMessage(listeners, "http://localhost:5173/library", {
      type: "mango-write/unpair",
      optOut: false,
    });

    // 正式环境槽位必须活着，且仍是 active。
    const state = await sendBackgroundMessage(listeners, {
      type: "mango-write/get-pairing-state",
    });
    const envs = (state.result as { environments: Array<{ origin: string; active: boolean }> })
      .environments;
    expect(envs.map((e) => e.origin)).toEqual(["https://mangowrite.com"]);
    expect(envs.filter((e) => e.active).map((e) => e.origin)).toEqual(["https://mangowrite.com"]);

    // 被清的环境此后查状态是未连接，正式环境不受影响。
    const fromLocal = await sendBridgeMessage(listeners, "http://localhost:5173/library", {
      type: "mango-write/get-pairing-state",
    });
    const fromProd = await sendBridgeMessage(listeners, "https://mangowrite.com/library", {
      type: "mango-write/get-pairing-state",
    });
    expect(fromLocal.result).toMatchObject({ paired: false });
    expect(fromProd.result).toMatchObject({ paired: true, user: { id: "u1" } });
  });

  it("用户主动断开也只断自己环境：opt-out 按 origin 记录", async () => {
    const { listeners } = await loadBackground();
    await sendBridgeMessage(listeners, "https://mangowrite.com/library", pair("https://mangowrite.com").message);
    await sendBridgeMessage(listeners, "http://localhost:5173/library", {
      type: "mango-write/pair",
      token: "mwx_local",
      tokenId: "tok-local",
      user: { id: "u-local", email: "dev@local.test", name: null },
      apiBaseUrl: "http://localhost:5173",
    });

    // 在 localhost 页面点「断开」。
    await sendBridgeMessage(listeners, "http://localhost:5173/library", {
      type: "mango-write/unpair",
    });

    const localAsk = await sendBridgeMessage(listeners, "http://localhost:5173/library", {
      type: "mango-write/should-auto-pair",
      apiBaseUrl: "http://localhost:5173",
      userId: "u-local",
    });
    const prodAsk = await sendBridgeMessage(listeners, "https://mangowrite.com/library", {
      type: "mango-write/should-auto-pair",
      apiBaseUrl: "https://mangowrite.com",
      userId: "u1",
    });
    expect(localAsk.result).toMatchObject({ pair: false, reason: "opted_out" });
    expect(prodAsk.result).toMatchObject({ pair: false, reason: "already_paired" });
  });
});

describe("会员数据随 get-pairing-state 下发", () => {
  // popup 打开时只发一条 get-pairing-state；membership 搭 self/status 校验的
  // 顺风车带回，popup 会员条随现有调用刷新，没有独立的轮询。
  it("self/status 校验令牌时顺带带回 membership", async () => {
    const membership = {
      tier: "pro",
      plan: { id: "plan-pro", name: "专业版", tierRank: 2 },
      expiresAt: null,
      parseWeek: { used: 3, limit: 20 },
    };
    apiMocks.checkDeviceTokenValid.mockResolvedValueOnce({ valid: true, membership });
    const { listeners } = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });

    const state = await sendBackgroundMessage(listeners, { type: "mango-write/get-pairing-state" });

    expect(state.result).toMatchObject({ paired: true, membership });
  });

  it("无会员或未配对时 membership 为 null（popup 不渲染会员条）", async () => {
    const { listeners } = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const paired = await sendBackgroundMessage(listeners, { type: "mango-write/get-pairing-state" });
    expect(paired.result).toMatchObject({ paired: true, membership: null });

    const fresh = await loadBackground();
    const unpaired = await sendBackgroundMessage(fresh.listeners, { type: "mango-write/get-pairing-state" });
    expect(unpaired.result).toMatchObject({ paired: false, membership: null });
  });
});

describe("导入目标：团队列表与网页端当前空间", () => {
  // 团队列表搭 self/status 校验的顺风车（与 membership 同一通道）；
  // 网页端经 set-active-space 推「当前空间」，按 origin 写进配对槽位。
  it("self/status 校验令牌时顺带带回 teams，槽位里的当前空间一并下发", async () => {
    const teams = [{ id: "t1", name: "团队一" }];
    apiMocks.checkDeviceTokenValid.mockResolvedValueOnce({
      valid: true,
      membership: null,
      teams,
    });
    const { listeners } = await loadBackground({
      local: { "mangoWrite.pairings": { "https://api.example.com": { ...PAIRING, activeSpaceId: "t1" } } },
    });

    const state = await sendBackgroundMessage(listeners, { type: "mango-write/get-pairing-state" });

    expect(state.result).toMatchObject({ paired: true, teams, activeSpaceId: "t1" });
  });

  it("set-active-space 写进发送方 origin 的槽位；未配对的 origin 不落盘", async () => {
    const { listeners, localStore } = await loadBackground({
      local: { "mangoWrite.pairings": { "http://localhost:3000": { ...PAIRING, apiBaseUrl: "http://localhost:3000" } } },
    });

    const paired = await sendBridgeMessage(listeners, "http://localhost:3000/library", {
      type: "mango-write/set-active-space",
      spaceId: "t9",
    });
    expect(paired).toEqual({ ok: true, result: { ok: true } });

    const state = await sendBackgroundMessage(listeners, { type: "mango-write/get-pairing-state" });
    expect(state.result).toMatchObject({ paired: true, activeSpaceId: "t9" });

    // 另一个 origin 没有配对槽位——推送被忽略，不新建槽位。
    const stranger = await sendBridgeMessage(listeners, "https://other.example/paper", {
      type: "mango-write/set-active-space",
      spaceId: "t1",
    });
    expect(stranger).toEqual({ ok: true, result: { ok: true } });
    const slots = localStore.get("mangoWrite.pairings") as Record<string, unknown>;
    expect(Object.keys(slots)).toEqual(["http://localhost:3000"]);
    expect((slots["http://localhost:3000"] as { activeSpaceId: string }).activeSpaceId).toBe("t9");
  });
});

describe("网页桥接（postMessage → content script 中转）", () => {
  it("mango-write/bridge 复用外部消息处理器：ping 回 pong", async () => {
    const { listeners } = await loadBackground();

    const response = await sendBackgroundMessage(listeners, {
      type: "mango-write/bridge",
      message: { type: "mango-write/ping" },
    });

    expect(response).toEqual({ ok: true, result: { pong: true, version: expect.any(String) } });
  });

  it("配对/查配对状态也走同一条桥", async () => {
    const { listeners } = await loadBackground();

    const pair = await sendBridgeMessage(listeners, "http://localhost:3000/library", {
      type: "mango-write/pair",
      token: "mwx_test",
      tokenId: "tok-1",
      user: { id: "u1", email: "u@example.com", name: null },
      apiBaseUrl: "http://localhost:3000",
    });
    expect(pair).toEqual({
      ok: true,
      result: {
        paired: true,
        user: { id: "u1", email: "u@example.com", name: null },
        tokenId: "tok-1",
        // 回给调用方的是这台设备真正连上的 origin——popup 的环境标据此判定，
        // 不能退回构建期常量（同一个包可以配对到任意环境）。
        apiBaseUrl: "http://localhost:3000",
        deviceId: expect.any(String),
        canSwitchEnv: false,
        // 配对（describePairingState）不打网络，会员只在 getPairingState 的
        // self/status 往返里带回（见「会员数据」describe 的用例）。
        membership: null,
        // 团队目标与网页端当前空间同上——只在探测路径带回；describe 只给
        // 槽位里记的空间（未推送 = null）。
        teams: [],
        activeSpaceId: null,
        // 配对按 origin 登记进环境表，并成为 active（此前没有别的环境）。
        environments: [
          {
            origin: "http://localhost:3000",
            user: { id: "u1", email: "u@example.com", name: null },
            active: true,
          },
        ],
      },
    });

    const state = await sendBridgeMessage(listeners, "http://localhost:3000/library", {
      type: "mango-write/get-pairing-state",
    });
    expect(state.result).toMatchObject({ paired: true, apiBaseUrl: "http://localhost:3000" });
  });

  it("未知外部消息类型经桥也回 error 而不是静默吞掉", async () => {
    const { listeners } = await loadBackground();

    const response = await sendBackgroundMessage(listeners, {
      type: "mango-write/bridge",
      message: { type: "mango-write/bogus" },
    });

    expect(response.ok).toBe(false);
    expect(response.error).toBe("unknown_external_message_type");
  });
});

describe("本地 PDF 文件导入（file://）", () => {
  // 用户把本地 PDF 拖进 Chrome 再点导入：走 import-pdf-url → SW fetch(file://)
  // → 校验 %PDF- → 无 metadata 上传，服务端从 PDF 自身解析题录并按 sha256 去重。
  // 修复前这条路只在 http(s) 生效，本地文件被网页快照通道吞掉（标题=编码 URL）。
  const FILE_URL =
    "file:///D:/%E5%BA%94%E7%94%A8%E8%BD%AF%E4%BB%B6/%E4%BA%A7%E6%95%99%E6%99%BA%E5%BA%93%E8%81%94%E7%9B%9F%E8%B5%8B%E8%83%BD%E2%80%9C%E8%81%8C%E6%95%99%E5%87%BA%E6%B5%B7%E2%80%9D%E7%9A%84%E5%A4%9A%E7%BB%B4%E7%BC%96%E8%BE%91%E3%80%81%E7%8E%B0%E5%AE%9E%E6%8C%91%E6%88%98%E5%8F%8A%E8%A1%8C%E5%8A%A8%E7%AD%96%E7%95%A5_%E7%8E%8B%E8%8A%B3.pdf";
  const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

  function stubFetchOk() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(PDF_BYTES, {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-length": String(PDF_BYTES.byteLength),
          },
        }),
      ),
    );
  }

  it("队列卡片用解码后的文件名（去 .pdf），上传不带 metadata，站点标为本地文件", async () => {
    stubFetchOk();
    const { listeners, localStore } = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });

    const response = await sendBackgroundMessage(listeners, {
      type: "mango-write/import-pdf-url",
      url: FILE_URL,
      // Chrome 给本地 PDF 标签页的 title 就是编码 URL——不许让它进展示名。
      title: FILE_URL,
      tabId: 7,
    });
    expect(response.ok).toBe(true);

    await flushUntil(() => apiMocks.uploadPluginCapture.mock.calls.length === 1, "上传开始");
    await waitFor(
      () => persistedCaptures(localStore).some((r) => r.done === true),
      "本地文件导入跑完",
    );

    const [record] = persistedCaptures(localStore);
    expect(record.title).toBe("产教智库联盟赋能“职教出海”的多维编辑、现实挑战及行动策略_王芳");
    expect(record.title).not.toContain("%");
    expect(record.sourceSite).toBe("本地文件");

    const uploaded = apiMocks.uploadPluginCapture.mock.calls[0]![0] as Record<string, unknown>;
    expect(uploaded.metadata).toBeNull();
    expect(uploaded.originUrl).toBe(FILE_URL);
    expect(uploaded.resolverSource).toBe("plugin-pdf-direct");
    expect(uploaded.file).toMatchObject({ mime: "application/pdf" });
  });

  it("读不到字节且用户没开「允许访问文件网址」：失败文案指向开关，而不是通用下载错误", async () => {
    // fetch 直接失败（toggle 关闭时 SW 对 file:// 的 fetch 必然 reject）。
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const { listeners, localStore, chromeMock } = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    (chromeMock.extension.isAllowedFileSchemeAccess as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (allowed: boolean) => void) => cb(false),
    );

    await sendBackgroundMessage(listeners, {
      type: "mango-write/import-pdf-url",
      url: FILE_URL,
      title: null,
      tabId: 7,
    });

    await waitFor(
      () => persistedCaptures(localStore).some((r) => r.state === "failed"),
      "失败落账",
    );
    const [record] = persistedCaptures(localStore);
    expect(record.failure?.kind).toBe("file-access-denied");
    expect(apiMocks.uploadPluginCapture).not.toHaveBeenCalled();
  });

  it("开关已开但读不到：提示文件可能被移动/删除", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gone", { status: 404 })),
    );
    const { listeners, localStore } = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });

    await sendBackgroundMessage(listeners, {
      type: "mango-write/import-pdf-url",
      url: FILE_URL,
      title: null,
      tabId: 7,
    });

    await waitFor(
      () => persistedCaptures(localStore).some((r) => r.state === "failed"),
      "失败落账",
    );
    const [record] = persistedCaptures(localStore);
    expect(record.failure?.kind).toBe("local-file-moved");
  });
});

describe("取原文（模式 B）走 translator 附件", () => {
  // 服务端的 publisher 规则不覆盖知网/万方/维普——那几家的 PDF 只有 translator
  // 知道在哪。取原文原来只跑 fetchBestPdf，所以中文源不管用户有没有登录好，
  // 一律回「未找到可下载的 PDF」，而那恰恰是被闸门降级的导入让用户去点的补救入口。
  const ORIGIN = "https://kns.cnki.net/kcms2/article/abstract?v=tok";

  /** 派活 → 开标签 → 标签 complete → 后台接管。返回内容脚本收到的消息类型。 */
  async function runFetchOrigin(
    harness: Awaited<ReturnType<typeof loadBackground>>,
    captureResponse: unknown,
  ): Promise<string[]> {
    const asked: string[] = [];
    harness.chromeMock.tabs.sendMessage = vi.fn(async (_tabId: number, msg: { type: string }) => {
      asked.push(msg.type);
      if (msg.type === "mango-write/capture-page-context") return captureResponse;
      return { title: "T", url: ORIGIN, html: "<html><body>shell</body></html>" };
    }) as never;

    const handler = harness.listeners.externalMessage[0]!;
    await new Promise((resolve) => {
      handler({ type: "mango-write/fetch-origin", originUrl: ORIGIN, token: "tk", sourceId: "src-9" }, {}, resolve);
    });
    for (const fn of harness.listeners.tabUpdated) {
      (fn as (id: number, info: { status: string }) => void)(42, { status: "complete" });
    }
    return asked;
  }

  const CNKI_CAPTURE = {
    recognized: true,
    originUrl: ORIGIN,
    title: "迈向第三代人工智能",
    identifier: null,
    pageHtml: "<html><body>知网详情页</body></html>",
    pageHtmlKind: "raw" as const,
    metadata: { title: "迈向第三代人工智能", nativeId: "cnki:pzkx202009002" },
    resolverSource: "plugin-dom-zh",
    attachments: [
      { kind: "pdf", url: "https://bar.cnki.net/bar/download/order?id=P", mime: "application/pdf", filename: "a.pdf" },
    ],
    allowGenericPdfDiscovery: false,
    allowRawHtmlFallback: false,
  };

  it("拿 translator 的下载链接取到 PDF 并回传，不再空跑 publisher 规则", async () => {
    apiMocks.downloadAttachment.mockResolvedValue({
      file: { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), filename: "cnki.pdf", mime: "application/pdf" },
      gate: null,
    });
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const asked = await runFetchOrigin(harness, CNKI_CAPTURE);

    await flushUntil(() => apiMocks.uploadOriginPdf.mock.calls.length === 1, "原文回传");
    expect(asked).toContain("mango-write/capture-page-context");
    expect(apiMocks.downloadAttachment).toHaveBeenCalledTimes(1);
    // allowGenericPdfDiscovery:false —— 不去刮 SPA 外壳。
    expect(apiMocks.extractPluginPdfCandidates).not.toHaveBeenCalled();
    expect(apiMocks.reportPluginFailure).not.toHaveBeenCalled();
  });

  it("撞上闸门时回报具体原因，而不是笼统的 no-pdf-found", async () => {
    apiMocks.downloadAttachment.mockResolvedValue({ file: null, gate: "login" });
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    await runFetchOrigin(harness, CNKI_CAPTURE);

    await flushUntil(() => apiMocks.reportPluginFailure.mock.calls.length === 1, "回报失败");
    const reported = apiMocks.reportPluginFailure.mock.calls[0]![0] as Record<string, unknown>;
    expect(reported.reason).toBe("gated-login");
    expect(apiMocks.uploadOriginPdf).not.toHaveBeenCalled();
  });

  it("页面没被任何 translator 认出来时，仍回退到快照 + 服务端 publisher 规则", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const asked = await runFetchOrigin(harness, { recognized: false, attachments: [] });

    await flushUntil(() => apiMocks.extractPluginPdfCandidates.mock.calls.length === 1, "回退到 publisher 规则");
    expect(asked).toContain("mango-write/origin-snapshot");
    expect(apiMocks.downloadAttachment).not.toHaveBeenCalled();
  });
});

describe("插件端 OpenAlex 题录查询", () => {
  // Factory: enrichCaptureWithOpenAlex mutates the capture (stamps a new
  // resolverSource + merges metadata), so each test needs a fresh copy.
  function makeEnCapture(overrides: Partial<CaptureResult> = {}): CaptureResult {
    return {
      ...CAPTURE,
      resolverSource: "plugin-dom-en",
      identifier: "10.1234/example",
      metadata: { title: "A Paper", DOI: "10.1234/example" },
      ...overrides,
    };
  }

  it("begin-capture + 英文 track + 有 DOI 时调 OpenAlex，合并后 resolverSource 改为 plugin-openalex", async () => {
    openalexMocks.lookupOpenAlexByDoi.mockResolvedValue({
      type: "article-journal",
      title: "A Paper",
      DOI: "10.1234/example",
      "container-title": "NeurIPS",
      volume: "30",
      issue: "1",
      page: "5998-6008",
      issued: { "date-parts": [[2017]] },
    });
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    connectPopup(harness.listeners);

    await beginCaptureWith(harness, makeEnCapture());
    await flushUntil(() => apiMocks.uploadPluginCapture.mock.calls.length === 1, "上传完成");

    // OpenAlex was queried with the DOI from metadata.
    expect(openalexMocks.lookupOpenAlexByDoi).toHaveBeenCalledWith("10.1234/example");

    // The upload carries the merged metadata and the new resolverSource.
    const uploaded = apiMocks.uploadPluginCapture.mock.calls[0]![0] as Record<string, unknown>;
    expect(uploaded.resolverSource).toBe("plugin-openalex");
    const meta = uploaded.metadata as Record<string, unknown>;
    expect(meta["container-title"]).toBe("NeurIPS");
    expect(meta.volume).toBe("30");
    expect(meta.page).toBe("5998-6008");

    // The DOM-scraped title is preserved (not overwritten by OpenAlex).
    expect(meta.title).toBe("A Paper");
  });

  it("OpenAlex 返回 null 时保留原 resolverSource，不阻断导入", async () => {
    openalexMocks.lookupOpenAlexByDoi.mockResolvedValue(null);
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    connectPopup(harness.listeners);

    await beginCaptureWith(harness, makeEnCapture());
    await flushUntil(() => apiMocks.uploadPluginCapture.mock.calls.length === 1, "上传完成");

    expect(openalexMocks.lookupOpenAlexByDoi).toHaveBeenCalledWith("10.1234/example");
    const uploaded = apiMocks.uploadPluginCapture.mock.calls[0]![0] as Record<string, unknown>;
    // No OpenAlex data -> resolverSource unchanged.
    expect(uploaded.resolverSource).toBe("plugin-dom-en");
  });

  it("中文 track (plugin-dom-zh) 不调 OpenAlex", async () => {
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    connectPopup(harness.listeners);

    await beginCaptureWith(
      harness,
      makeEnCapture({
        resolverSource: "plugin-dom-zh",
        identifier: "10.3969/x",
        metadata: { title: "一篇中文论文", language: "zh", DOI: "10.3969/x" },
      }),
    );
    await flushUntil(() => apiMocks.uploadPluginCapture.mock.calls.length === 1, "上传完成");

    expect(openalexMocks.lookupOpenAlexByDoi).not.toHaveBeenCalled();
  });

  it("没有 DOI 时不调 OpenAlex", async () => {
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    connectPopup(harness.listeners);

    await beginCaptureWith(
      harness,
      makeEnCapture({
        resolverSource: "plugin-dom-en",
        identifier: null,
        metadata: { title: "A Paper" },
      }),
    );
    await flushUntil(() => apiMocks.uploadPluginCapture.mock.calls.length === 1, "上传完成");

    expect(openalexMocks.lookupOpenAlexByDoi).not.toHaveBeenCalled();
  });

  it("fetch-origin（网页派活）流程不调 OpenAlex", async () => {
    // fetch-origin opens a tab and runs runPendingOriginFetch -> runOriginAssist,
    // which must NOT trigger the OpenAlex lookup (only begin-capture does).
    const enOriginCapture = {
      recognized: true,
      originUrl: "https://publisher.example/article",
      title: "A Paper",
      identifier: "10.1234/example",
      pageHtml: "<html></html>",
      pageHtmlKind: "raw" as const,
      metadata: { title: "A Paper", DOI: "10.1234/example" },
      resolverSource: "plugin-dom-en",
      attachments: [
        { kind: "pdf", url: "https://publisher.example/paper.pdf", mime: "application/pdf", filename: "a.pdf" },
      ],
      allowGenericPdfDiscovery: false,
      allowRawHtmlFallback: false,
    };

    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    harness.chromeMock.tabs.sendMessage = vi.fn(async (_tabId: number, msg: { type: string }) => {
      if (msg.type === "mango-write/capture-page-context") return enOriginCapture;
      return { title: "T", url: enOriginCapture.originUrl, html: "<html></html>" };
    }) as never;

    const handler = harness.listeners.externalMessage[0]!;
    await new Promise((resolve) => {
      handler(
        {
          type: "mango-write/fetch-origin",
          originUrl: enOriginCapture.originUrl,
          token: "tk",
          sourceId: "src-9",
        },
        {},
        resolve,
      );
    });
    for (const fn of harness.listeners.tabUpdated) {
      (fn as (id: number, info: { status: string }) => void)(42, { status: "complete" });
    }

    await flushUntil(() => apiMocks.uploadOriginPdf.mock.calls.length === 1, "原文回传");
    // OpenAlex must NOT be called on the fetch-origin path, even though the
    // capture is English-track with a DOI.
    expect(openalexMocks.lookupOpenAlexByDoi).not.toHaveBeenCalled();
  });

  it("OpenAlex 的字段只填 DOM 没抓到的空位，不覆盖已有值", async () => {
    openalexMocks.lookupOpenAlexByDoi.mockResolvedValue({
      type: "article-journal",
      title: "WRONG TITLE from OpenAlex",
      DOI: "10.1234/example",
      "container-title": "NeurIPS",
      volume: "30",
    });
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    connectPopup(harness.listeners);

    await beginCaptureWith(
      harness,
      makeEnCapture({
        metadata: { title: "Correct DOM Title", DOI: "10.1234/example" },
      }),
    );
    await flushUntil(() => apiMocks.uploadPluginCapture.mock.calls.length === 1, "上传完成");

    const uploaded = apiMocks.uploadPluginCapture.mock.calls[0]![0] as Record<string, unknown>;
    const meta = uploaded.metadata as Record<string, unknown>;
    // DOM title preserved; OpenAlex title NOT overlaid.
    expect(meta.title).toBe("Correct DOM Title");
    // OpenAlex-only field filled in.
    expect(meta["container-title"]).toBe("NeurIPS");
    expect(meta.volume).toBe("30");
  });
});

describe("排队任务取消：真停，不是藏行", () => {
  it("队列忙时取消排队任务：行消失，轮到它时不上传、不落库", async () => {
    // 占住上传队列：第一篇卡在上传中，第二篇进排队态。
    let releaseUpload: (v: { sourceId: string }) => void = () => {};
    apiMocks.uploadPluginCapture.mockImplementationOnce(
      () => new Promise((resolve) => (releaseUpload = resolve)),
    );
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    const popup = connectPopup(harness.listeners);

    const first = await beginCaptureWith(harness, CAPTURE);
    const firstId = (first.result as { captureId: string }).captureId;
    await flushUntil(() => apiMocks.uploadPluginCapture.mock.calls.length === 1, "第一篇上传开始");

    // 第二篇换 tab URL 绕开 begin-capture 的同页去重，identifier 也换掉。
    harness.chromeMock.tabs.get = vi.fn(async (tabId: number) => ({
      id: tabId,
      url: "https://journal.example.org/article-2",
      title: "Another Paper",
    })) as never;
    const second = await beginCaptureWith(harness, {
      ...CAPTURE,
      originUrl: "https://journal.example.org/article-2",
      identifier: "doi:10.0000/test-2",
      title: "Another Paper",
    }, 2);
    const secondId = (second.result as { captureId: string }).captureId;
    await flushUntil(() => {
      const view = popup.posted.at(-1)?.captures.find((v) => v.captureId === secondId);
      return view?.state === "queued";
    }, "第二篇排队");

    await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/cancel-capture",
      captureId: secondId,
    });
    await flushUntil(
      () => !persistedCaptures(harness.localStore).some((r) => r.captureId === secondId),
      "行已摘除",
    );

    // 释放第一篇，让队列推进到被取消任务的回合——它必须被跳过。
    releaseUpload({ sourceId: "src-1" });
    await flushUntil(() => {
      const view = popup.posted.at(-1)?.captures.find((v) => v.captureId === firstId);
      return view?.done === true;
    }, "第一篇完成");

    expect(apiMocks.uploadPluginCapture).toHaveBeenCalledTimes(1);
    expect(persistedCaptures(harness.localStore).some((r) => r.captureId === secondId)).toBe(false);
    expect(popup.posted.at(-1)!.captures.some((v) => v.captureId === secondId)).toBe(false);
  });
});

describe("队列卡可执行动作投影（渲染与执行同源）", () => {
  it("上传失败且字节在手 → retry-upload；完成行 → 无动作", async () => {
    apiMocks.uploadPluginCapture.mockRejectedValueOnce(new Error("request_failed:400"));
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const popup = connectPopup(harness.listeners);
    const response = await beginCaptureWith(harness, CAPTURE);
    const captureId = (response.result as { captureId: string }).captureId;
    await flushUntil(() => {
      const view = popup.posted.at(-1)?.captures.find((v) => v.captureId === captureId);
      return view?.state === "failed";
    }, "上传失败落账");
    expect(popup.posted.at(-1)!.captures.find((v) => v.captureId === captureId)?.actions).toEqual([
      "retry-upload",
    ]);

    // 走完一遍正常流程：完成行的动作集为空。
    const ok = await beginCaptureWith(harness, {
      ...CAPTURE,
      originUrl: "https://arxiv.org/abs/2401.00002",
      identifier: "doi:10.0000/test-2",
    }, 2);
    const okId = (ok.result as { captureId: string }).captureId;
    await flushUntil(() => {
      const view = popup.posted.at(-1)?.captures.find((v) => v.captureId === okId);
      return view?.state === "completed";
    }, "正常流程完成");
    expect(popup.posted.at(-1)!.captures.find((v) => v.captureId === okId)?.actions).toEqual([]);
  });

  it("读取页面失败 → reimport（无 PDF 可取是仅题录完成，不算失败）", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const popup = connectPopup(harness.listeners);
    const response = await beginCaptureWith(harness, new Error("读取页面失败"));
    const captureId = (response.result as { captureId: string }).captureId;
    await flushUntil(() => {
      const view = popup.posted.at(-1)?.captures.find((v) => v.captureId === captureId);
      return view?.state === "failed";
    }, "读取失败落账");
    expect(popup.posted.at(-1)!.captures.find((v) => v.captureId === captureId)?.actions).toEqual([
      "reimport",
    ]);
  });
});

describe("已结束记录的留存、自动清理与清空", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const BASE = {
    apiBaseUrl: "https://api.example",
    deviceToken: "dt",
    tabId: null,
    originUrl: "https://arxiv.org/abs/2401.00001",
    identifier: "doi:10.0000/test",
    progress: 100,
    done: true,
    retry: "none",
    attempt: 0,
  };
  const completed = (captureId: string, createdAt: number, extra: Record<string, unknown> = {}) => ({
    ...BASE,
    captureId,
    state: "completed",
    step: "completed",
    createdAt,
    ...extra,
  });
  const failed = (captureId: string, createdAt: number) => ({
    ...BASE,
    captureId,
    state: "failed",
    step: "failed",
    error: "boom",
    createdAt,
  });

  it("重开 popup 不清已结束记录：failed 长期留存，1 天内完成的（含仅题录）也留下", async () => {
    const now = Date.now();
    const { listeners, localStore } = await loadBackground({
      local: {
        "mangoWrite.pairing": PAIRING,
        runningCaptures: [
          failed("done-2", 1),
          completed("done-1", now, { completedAt: now, resultKind: "metadata-only" }),
        ],
      },
    });
    connectPopup(listeners);
    connectPopup(listeners);

    const ids = persistedCaptures(localStore).map((r) => r.captureId);
    expect(ids).toContain("done-1");
    expect(ids).toContain("done-2");
  });

  it("已完成记录满 1 天自动清除，failed 不受影响", async () => {
    const now = Date.now();
    const { listeners, localStore } = await loadBackground({
      local: {
        "mangoWrite.pairing": PAIRING,
        runningCaptures: [
          completed("stale", now - 2 * DAY),
          completed("fresh", now, { completedAt: now, resultKind: "pdf" }),
          failed("kept", 1),
        ],
      },
    });

    await flushUntil(() => {
      const ids = persistedCaptures(localStore).map((r) => r.captureId);
      return ids.length === 2 && ids.includes("fresh") && ids.includes("kept");
    }, "过期已完成记录被清除");
    expect(persistedCaptures(localStore).map((r) => r.captureId)).not.toContain("stale");
  });

  it("超过 20 条时从最早的已完成开始裁剪，failed 保留", async () => {
    const now = Date.now();
    // createdAt 用近期时刻，避免撞上 1 天 TTL——本用例只验证容量上限。
    // c-1 最早、c-22 最新。
    const records = [
      ...Array.from({ length: 22 }, (_, i) => completed(`c-${i + 1}`, now - (22 - i) * 60_000)),
      failed("f-1", now - 30 * 60_000),
      failed("f-2", now - 31 * 60_000),
    ];
    const { listeners, localStore } = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING, runningCaptures: records },
    });

    await flushUntil(() => persistedCaptures(localStore).length === 20, "裁剪到 20 条");
    const ids = persistedCaptures(localStore).map((r) => r.captureId);
    expect(ids).toContain("f-1");
    expect(ids).toContain("f-2");
    // 被裁掉的是最早的 4 条已完成（c-1..c-4），留下的都是较新的。
    for (const gone of ["c-1", "c-2", "c-3", "c-4"]) expect(ids).not.toContain(gone);
    expect(ids.filter((id) => id.startsWith("c-"))).toHaveLength(18);
  });

  it("clear-finished-captures 一键清空 completed/failed，保留进行中的任务", async () => {
    const now = Date.now();
    const { listeners, localStore } = await loadBackground({
      local: {
        "mangoWrite.pairing": PAIRING,
        runningCaptures: [completed("done-1", now, { completedAt: now }), failed("done-2", now)],
      },
    });
    connectPopup(listeners);

    const response = await sendBackgroundMessage(listeners, {
      type: "mango-write/clear-finished-captures",
    });
    expect(response.ok).toBe(true);
    await flushUntil(() => persistedCaptures(localStore).length === 0, "清空完成");
  });
});

describe("工具栏 badge 警示", () => {
  it("仅题录完成时 badge 用琥珀色提示有未完整的导入", async () => {
    apiMocks.downloadAttachment.mockResolvedValue({ file: null, gate: null });
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    connectPopup(harness.listeners);

    await beginCaptureWith(harness, CAPTURE);
    await waitFor(
      () =>
        harness.chromeMock.action.setBadgeBackgroundColor.mock.calls.some(
          (c) => (c[0] as { color: string }).color === "#f59e0b",
        ),
      "琥珀色 badge",
    );
    const lastText = harness.chromeMock.action.setBadgeText.mock.calls.at(-1)![0] as { text: string };
    expect(lastText.text).toBe("1");
  });

  it("有失败记录时 badge 用红色", async () => {
    apiMocks.uploadPluginCapture.mockRejectedValue(new Error("request_failed:400"));
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
    });
    connectPopup(harness.listeners);

    await beginCaptureWith(harness, CAPTURE);
    await waitFor(
      () =>
        harness.chromeMock.action.setBadgeBackgroundColor.mock.calls.some(
          (c) => (c[0] as { color: string }).color === "#dc2626",
        ),
      "红色 badge",
    );
  });
});

describe("直达 PDF 标签页：主框架 Content-Type 事实表", () => {
  interface HeadersReceivedDetails {
    tabId: number;
    url: string;
    responseHeaders?: Array<{ name: string; value: string }>;
  }

  function fireHeadersReceived(
    listeners: ReturnType<typeof makeChromeHarness>["listeners"],
    details: HeadersReceivedDetails,
  ): void {
    for (const fn of listeners.webRequestHeaders) fn(details);
  }

  function getTabDocument(
    listeners: ReturnType<typeof makeChromeHarness>["listeners"],
    tabId: number,
  ): Promise<{ ok: boolean; result?: { kind?: string; contentType?: string | null } }> {
    return sendBackgroundMessage(listeners, { type: "mango-write/get-tab-document", tabId });
  }

  it("记录 application/pdf 主框架响应，get-tab-document 回 kind=pdf", async () => {
    const { listeners } = await loadBackground();
    fireHeadersReceived(listeners, {
      tabId: 7,
      url: "https://darwin-online.org.uk/converted/pdf/1879_Bary_Symbiose_A3450.pdf",
      responseHeaders: [{ name: "Content-Type", value: "application/pdf" }],
    });

    const res = await getTabDocument(listeners, 7);
    expect(res.result).toMatchObject({ kind: "pdf", contentType: "application/pdf" });
  });

  it("text/html 记为 html；同一标签的重定向后写覆盖先写（最终响应胜出）", async () => {
    const { listeners } = await loadBackground();
    fireHeadersReceived(listeners, {
      tabId: 8,
      url: "https://a.org/redirector",
      responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
    });
    fireHeadersReceived(listeners, {
      tabId: 8,
      url: "https://a.org/final.pdf",
      responseHeaders: [{ name: "Content-Type", value: "application/pdf" }],
    });

    const res = await getTabDocument(listeners, 8);
    expect(res.result).toMatchObject({ kind: "pdf", url: "https://a.org/final.pdf" });
  });

  it("无记录的标签返回 unknown（popup 退化到 URL/DOM 启发式）", async () => {
    const { listeners } = await loadBackground();
    const res = await getTabDocument(listeners, 404);
    expect(res.result).toMatchObject({ kind: "unknown", contentType: null });
  });

  it("标签重新导航 / 关闭时清除记录", async () => {
    const { listeners } = await loadBackground();
    fireHeadersReceived(listeners, {
      tabId: 9,
      url: "https://a.org/p.pdf",
      responseHeaders: [{ name: "Content-Type", value: "application/pdf" }],
    });
    expect((await getTabDocument(listeners, 9)).result).toMatchObject({ kind: "pdf" });

    for (const fn of listeners.tabUpdated) fn(9, { status: "loading", url: "https://a.org/next-page" });
    expect((await getTabDocument(listeners, 9)).result).toMatchObject({ kind: "unknown" });

    fireHeadersReceived(listeners, {
      tabId: 9,
      url: "https://a.org/next-page",
      responseHeaders: [{ name: "Content-Type", value: "text/html" }],
    });
    expect((await getTabDocument(listeners, 9)).result).toMatchObject({ kind: "html" });

    for (const fn of listeners.tabRemoved) fn(9);
    expect((await getTabDocument(listeners, 9)).result).toMatchObject({ kind: "unknown" });
  });

  it("service worker 回收后凭 chrome.storage.session 恢复事实表", async () => {
    const first = await loadBackground();
    fireHeadersReceived(first.listeners, {
      tabId: 11,
      url: "https://a.org/legacy-tab.pdf",
      responseHeaders: [{ name: "Content-Type", value: "application/pdf" }],
    });
    await flushUntil(() => first.sessionStore.has("tabDocumentTypes"), "session 镜像落盘");

    // 模拟 SW 重启：全新 chrome 桩与模块态，仅 session 存量还在。
    const second = await loadBackground({
      session: { tabDocumentTypes: first.sessionStore.get("tabDocumentTypes") },
    });
    const res = await getTabDocument(second.listeners, 11);
    expect(res.result).toMatchObject({ kind: "pdf", url: "https://a.org/legacy-tab.pdf" });
  });
});

function flushedEvents(): Array<Record<string, unknown>> {
  return apiMocks.reportPluginEvents.mock.calls.flatMap(
    (call) => call[0]!.events as Array<Record<string, unknown>>,
  );
}

describe("论文路径不建快照（pageHtmlKind 透传）", () => {
  it("识别为论文：capture.start 事件 detail 带 pageHtmlKind=raw", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    connectPopup(harness.listeners);

    await beginCaptureWith(harness, CAPTURE);
    await flushUntil(() => apiMocks.uploadPluginCapture.mock.calls.length === 1, "上传完成");

    const start = flushedEvents().find((e) => e.step === "capture.start");
    expect(start?.detail).toMatchObject({ pageHtmlKind: "raw" });
  });

  it("未识别网页确认导入：capture.start 事件 detail 带 pageHtmlKind=snapshot", async () => {
    const webpageCapture: CaptureResult = {
      ...CAPTURE,
      recognized: false,
      pageHtmlKind: "snapshot",
      pageHtml: "<html><body>page</body></html>",
      metadata: {},
      identifier: null,
      attachments: [],
      resolverSource: "none",
      allowGenericPdfDiscovery: false,
      allowRawHtmlFallback: true,
    };
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    connectPopup(harness.listeners);
    const response = await beginCaptureWith(harness, webpageCapture);
    const captureId = (response.result as { captureId: string }).captureId;
    await flushUntil(
      () => persistedCaptures(harness.localStore).some((r) => r.captureId === captureId && r.state === "confirm"),
      "confirm 态",
    );

    await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/confirm-webpage-capture",
      captureId,
    });
    await flushUntil(() => apiMocks.uploadPluginCapture.mock.calls.length === 1, "上传完成");

    const start = flushedEvents().find((e) => e.step === "capture.start");
    expect(start?.detail).toMatchObject({ webpage: true, pageHtmlKind: "snapshot" });
  });
});

describe("通用 PDF 发现：本地候选优先，服务端只做回落", () => {
  const META_HTML =
    '<html><head><meta name="citation_pdf_url" content="https://pub.example/pdf/paper.pdf"/></head><body>landing</body></html>';

  function makeDiscoveryCapture(overrides: Partial<CaptureResult> = {}): CaptureResult {
    return {
      ...CAPTURE,
      // 非 arXiv origin：arXiv 的 abs→pdf 规则会凭 URL 凭空造出本地候选。
      originUrl: "https://journal.example/article/xyz",
      allowGenericPdfDiscovery: true,
      attachments: [],
      ...overrides,
    };
  }

  it("本地规则命中：直接下载候选，不 mint 服务端票据、不打 extract-pdf", async () => {
    apiMocks.downloadAttachment.mockResolvedValue({ file: null, gate: null });
    apiMocks.downloadPdfCandidate.mockResolvedValue({
      file: { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), filename: "paper.pdf", mime: "application/pdf" },
    });
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    connectPopup(harness.listeners);

    await beginCaptureWith(harness, makeDiscoveryCapture({ pageHtmlKind: "raw", pageHtml: META_HTML }));
    await waitFor(
      () => persistedCaptures(harness.localStore).some((r) => r.done === true),
      "导入跑完",
    );
    // 终态后再等一拍：确认后续的事件 flush 票据也不会多 mint（discovery 零 mint）。
    await flushUntil(() => apiMocks.requestPluginSession.mock.calls.length >= 2, "上传票据收齐");

    expect(apiMocks.extractPluginPdfCandidates).not.toHaveBeenCalled();
    expect(apiMocks.downloadPdfCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://pub.example/pdf/paper.pdf" }),
      expect.anything(),
      expect.any(Function),
    );
    // 正常上传固定 mint 两次（上传票据 + 事件 flush 票据）；本地命中不加第三张。
    expect(apiMocks.requestPluginSession).toHaveBeenCalledTimes(2);
  });

  it("本地 0 候选：mint 票据回落服务端 extract-pdf（携带透传的原始 HTML）", async () => {
    apiMocks.downloadAttachment.mockResolvedValue({ file: null, gate: null });
    apiMocks.extractPluginPdfCandidates.mockResolvedValue([
      { url: "https://server.example/files/paper.pdf", strategy: "meta:citation_pdf_url", publisher: "generic-meta" },
    ]);
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    connectPopup(harness.listeners);

    const bareHtml = "<html><body>no candidates here</body></html>";
    await beginCaptureWith(
      harness,
      makeDiscoveryCapture({ pageHtmlKind: "raw", pageHtml: bareHtml }),
    );
    await waitFor(
      () => persistedCaptures(harness.localStore).some((r) => r.done === true),
      "导入跑完",
    );
    await flushUntil(() => apiMocks.requestPluginSession.mock.calls.length >= 3, "全部票据收齐");

    expect(apiMocks.extractPluginPdfCandidates).toHaveBeenCalledTimes(1);
    expect(apiMocks.extractPluginPdfCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ pageUrl: "https://journal.example/article/xyz", html: bareHtml }),
    );
    // discovery 回落多 mint 一张：2（上传）+ 1（discovery）= 3。
    expect(apiMocks.requestPluginSession).toHaveBeenCalledTimes(3);
  });
});

describe("OpenAlex：题录齐全时按需跳过", () => {
  const COMPLETE_META = {
    title: "A Paper",
    DOI: "10.1234/example",
    "container-title": "Journal of Example",
    author: [{ given: "A", family: "Author" }],
    issued: { "date-parts": [[2020]] },
    volume: "12",
    page: "1-10",
  };

  const makeEnCapture = (metadata: Record<string, unknown>): CaptureResult => ({
    ...CAPTURE,
    resolverSource: "plugin-dom-en",
    identifier: "10.1234/example",
    metadata,
  });

  it("六字段齐全（无期号）：不查 OpenAlex，上传带 skipEnrichSources=[openalex]", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    connectPopup(harness.listeners);

    await beginCaptureWith(harness, makeEnCapture({ ...COMPLETE_META }));
    await flushUntil(() => apiMocks.uploadPluginCapture.mock.calls.length === 1, "上传完成");

    expect(openalexMocks.lookupOpenAlexByDoi).not.toHaveBeenCalled();
    const uploaded = apiMocks.uploadPluginCapture.mock.calls[0]![0] as Record<string, unknown>;
    expect(uploaded.skipEnrichSources).toEqual(["openalex"]);
    expect(uploaded.resolverSource).toBe("plugin-dom-en");
    const enrich = flushedEvents().find((e) => e.step === "metadata.enrich");
    expect(enrich).toMatchObject({ status: "info", reason: "bib-core-complete" });
  });

  it("缺 volume 视为不齐：照常查 OpenAlex，上传不带 skipEnrichSources", async () => {
    openalexMocks.lookupOpenAlexByDoi.mockResolvedValue(null);
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    connectPopup(harness.listeners);

    const incomplete = { ...COMPLETE_META };
    delete incomplete.volume;
    await beginCaptureWith(harness, makeEnCapture(incomplete));
    await flushUntil(() => apiMocks.uploadPluginCapture.mock.calls.length === 1, "上传完成");

    expect(openalexMocks.lookupOpenAlexByDoi).toHaveBeenCalledWith("10.1234/example");
    const uploaded = apiMocks.uploadPluginCapture.mock.calls[0]![0] as Record<string, unknown>;
    expect(uploaded.skipEnrichSources).toBeUndefined();
  });
});

describe("SW 抓资源的安全闸门（fetch-guard）", () => {
  it("fetch-css-text：私网地址直接拒收，不发起 fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { listeners } = await loadBackground();

    const res = await sendBackgroundMessage(listeners, {
      type: "mango-write/fetch-css-text",
      url: "http://192.168.1.10/theme.css",
    });
    expect(res.result).toEqual({ cssText: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetch-css-text：公网 CSS 不带凭证抓取（credentials omit）", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("body{color:red}", { status: 200, headers: { "content-type": "text/css" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { listeners } = await loadBackground();

    const res = await sendBackgroundMessage(listeners, {
      type: "mango-write/fetch-css-text",
      url: "https://cdn.example.com/theme.css",
    });
    expect(res.result).toEqual({ cssText: "body{color:red}" });
    expect(fetchMock).toHaveBeenCalledWith("https://cdn.example.com/theme.css", { credentials: "omit" });
  });

  it("fetch-css-text：content-type 非 text/css 拒收；无 content-type 放行", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      )
      // 字节 body 才不会被 undici 自动补 content-type。
      .mockResolvedValueOnce(new Response(new TextEncoder().encode("body{}")));
    vi.stubGlobal("fetch", fetchMock);
    const { listeners } = await loadBackground();

    const rejected = await sendBackgroundMessage(listeners, {
      type: "mango-write/fetch-css-text",
      url: "https://cdn.example.com/a.css",
    });
    expect(rejected.result).toEqual({ cssText: null });

    const accepted = await sendBackgroundMessage(listeners, {
      type: "mango-write/fetch-css-text",
      url: "https://other.example.com/b.css",
    });
    expect(accepted.result).toEqual({ cssText: "body{}" });
  });

  it("fetch-image-datauri：私网拒绝；公网图片不带凭证内联", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array([0x89, 0x50]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { listeners } = await loadBackground();

    const blocked = await sendBackgroundMessage(listeners, {
      type: "mango-write/fetch-image-datauri",
      url: "http://127.0.0.1:8080/fig.png",
    });
    expect(blocked.result).toEqual({ dataUri: null });

    const ok = await sendBackgroundMessage(listeners, {
      type: "mango-write/fetch-image-datauri",
      url: "https://cdn.example.com/fig.png",
    });
    expect(String((ok.result as { dataUri: string }).dataUri)).toMatch(/^data:image\/png;base64,/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://cdn.example.com/fig.png", { credentials: "omit" });
  });

  // probe-url：旧标签页 content script 失效且无 Content-Type 记录时的兜底
  // 事实来源。判定复用 documentKindFromContentType + %PDF- 字节校验。
  it("probe-url：按 Content-Type 分类，公网不带凭证、Range 限传输", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<html></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { listeners } = await loadBackground();

    const res = await sendBackgroundMessage(listeners, {
      type: "mango-write/probe-url",
      url: "https://scholarworks.gsu.edu/items/71dfb819-4230-479c-a862-eafe9cde787d",
    });
    expect(res.result).toEqual({ kind: "html" });
    const [calledUrl, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(calledUrl).toBe("https://scholarworks.gsu.edu/items/71dfb819-4230-479c-a862-eafe9cde787d");
    expect(init.credentials).toBe("omit");
    expect((init.headers as Record<string, string>).Range).toBe("bytes=0-1023");
  });

  it("probe-url：无 Content-Type 时以 %PDF- 字节判定；私网拒绝；请求失败回 unknown", async () => {
    const fetchMock = vi.fn()
      // 无 content-type 的 %PDF- 直链 → pdf
      .mockResolvedValueOnce(new Response(new TextEncoder().encode("%PDF-1.7 …")))
      // 无 content-type 的 HTML → unknown
      .mockResolvedValueOnce(new Response(new TextEncoder().encode("<html></html>")));
    vi.stubGlobal("fetch", fetchMock);
    const { listeners } = await loadBackground();

    const pdf = await sendBackgroundMessage(listeners, {
      type: "mango-write/probe-url",
      url: "https://repo.example.org/bitstreams/abc/download",
    });
    expect(pdf.result).toEqual({ kind: "pdf" });

    const unknown = await sendBackgroundMessage(listeners, {
      type: "mango-write/probe-url",
      url: "https://repo.example.org/bitstreams/def/download",
    });
    expect(unknown.result).toEqual({ kind: "unknown" });

    const blocked = await sendBackgroundMessage(listeners, {
      type: "mango-write/probe-url",
      url: "http://192.168.1.10/paper",
    });
    expect(blocked.result).toEqual({ kind: "unknown" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("makeByteFetcher 直发路径：私网目标软失败返回 null，公网照常", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    connectPopup(harness.listeners);

    let fetchBytes: ((url: string) => Promise<unknown>) | null = null;
    apiMocks.downloadAttachment.mockImplementation(
      async (_attachment: unknown, _title: unknown, relay: (url: string) => Promise<unknown>) => {
        fetchBytes = relay;
        return { file: null, gate: null };
      },
    );

    await beginCaptureWith(harness, CAPTURE);
    await flushUntil(() => fetchBytes != null, "拿到 ByteFetcher");

    expect(await fetchBytes!("http://10.0.0.5/secret.pdf")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    expect(await fetchBytes!("https://pub.example/paper.pdf")).toMatchObject({
      contentType: "application/pdf",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("补全/更正回路（#100 D1）：任务注册表、确认卡与失败分类", () => {
  // 事故原型：PDF 导入的源缺 DOI，用户在知网详情页确认了题录后点了「导入」，
  // 插件按普通导入建出 metadata-only 重复条。本组钉死回路语义：
  // 派发 → 关联标签 → 详情页识别成确认卡（绝不静默回填）→ 用户拍板才回填；
  // 重复派发幂等；失败分类决定「可重试 / 回文库重来」。
  const SEARCH_URL = "https://kns.cnki.net/kns/defaultresult/index?kw=%E7%9B%AE%E6%A0%87%E6%96%87%E7%8C%AE";
  const DETAIL_CAPTURE: CaptureResult = {
    originUrl: "https://kns.cnki.net/kcms2/article/abstract?v=tok",
    title: "迈向第三代人工智能",
    identifier: "doi:10.13530/j.cnki.jlis.2024011",
    pageHtml: "<html><body>知网详情页</body></html>",
    pageHtmlKind: "raw",
    recognized: true,
    metadata: { title: "迈向第三代人工智能", DOI: "10.13530/j.cnki.jlis.2024011" },
    resolverSource: "plugin-dom-zh",
    attachments: [],
    allowGenericPdfDiscovery: false,
    allowRawHtmlFallback: false,
  };

  /** 以 web 应用身份派发「补全/更正」（complete-metadata 走 onMessageExternal）。 */
  async function dispatchCompletion(
    harness: Harness,
    input: {
      searchUrl?: string;
      token?: string;
      sourceId?: string;
      apiBaseUrl?: string;
      targetTitle?: string | null;
      targetDoi?: string | null;
    } = {},
  ): Promise<{ ok: boolean; result?: { message: string }; error?: string }> {
    const handler = harness.listeners.externalMessage[0]!;
    return new Promise((resolve, reject) => {
      handler(
        {
          type: "mango-write/complete-metadata",
          searchUrl: input.searchUrl ?? SEARCH_URL,
          token: input.token ?? "ticket-1",
          sourceId: input.sourceId ?? "src-1",
          apiBaseUrl: input.apiBaseUrl ?? PAIRING.apiBaseUrl,
          targetTitle: input.targetTitle ?? "目标文献",
          targetDoi: input.targetDoi ?? null,
        },
        {},
        resolve,
      );
    });
  }

  /** 让关联标签的详情页识别走通：内容脚本应答 recognized 的 translator 捕获。 */
  function stubDetailCapture(harness: Harness, capture: CaptureResult = DETAIL_CAPTURE): void {
    harness.chromeMock.tabs.sendMessage = vi.fn(async () => capture) as never;
  }

  function fireTabComplete(listeners: Harness["listeners"], tabId: number): void {
    for (const fn of listeners.tabUpdated) {
      (fn as (id: number, info: { status: string }) => void)(tabId, { status: "complete" });
    }
  }

  function latestCompletions(port: FakePort): CompletionViewLoose[] {
    return (port.posted.at(-1)?.completions ?? []) as CompletionViewLoose[];
  }

  type CompletionViewLoose = {
    sourceId: string;
    status: string;
    mismatch: boolean;
    mismatchReason?: string | null;
    expectedDoi?: string | null;
    capturedDoi?: string | null;
    actionable: boolean;
    targetTitle: string | null;
    capturedTitle: string | null;
    message?: string;
    absorbedSourceIds?: string[];
    absorbedTitles?: string[];
    libraryUrl?: string | null;
  };

  it("派发即开检索标签并登记 active 任务；视图脱敏（token/apiBaseUrl 不下发）", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const popup = connectPopup(harness.listeners);

    const res = await dispatchCompletion(harness, { targetTitle: "中文标题一" });
    expect(res.ok).toBe(true);
    expect(harness.chromeMock.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: SEARCH_URL, active: true }),
    );

    const completions = latestCompletions(popup);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      sourceId: "src-1",
      status: "active",
      targetTitle: "中文标题一",
      actionable: false,
    });
    expect(completions[0]).not.toHaveProperty("token");
    expect(completions[0]).not.toHaveProperty("apiBaseUrl");
  });

  it("同一文献重复派发：刷新在途任务（换票/换检索词），不开第二条、不重开标签", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    connectPopup(harness.listeners);

    await dispatchCompletion(harness, { token: "ticket-1" });
    const second = await dispatchCompletion(harness, {
      token: "ticket-2",
      searchUrl: "https://kns.cnki.net/other?kw=x",
    });

    expect(second.result).toEqual({ message: "已刷新进行中的更新任务，请继续操作。" });
    expect(harness.chromeMock.tabs.create).toHaveBeenCalledTimes(1);
    // 换词重派必须导航到新检索地址——只 focus 旧页等于忽略新检索词。
    expect(harness.chromeMock.tabs.update).toHaveBeenCalledWith(42, {
      url: "https://kns.cnki.net/other?kw=x",
      active: true,
    });
  });

  it("详情页新标签经 openerTabId 继承任务；识别出题录先成确认卡，绝不静默回填", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const popup = connectPopup(harness.listeners);
    await dispatchCompletion(harness);

    // 受控搜索 → 详情新标签：onCreated 的 openerTabId 把任务关联延到新标签。
    for (const fn of harness.listeners.tabCreated) {
      (fn as (tab: { id: number; openerTabId: number }) => void)({ id: 43, openerTabId: 42 });
    }
    stubDetailCapture(harness);
    fireTabComplete(harness.listeners, 43);

    await waitFor(
      () => latestCompletions(popup).some((c) => c.actionable && c.sourceId === "src-1"),
      "确认卡广播",
    );
    const view = latestCompletions(popup).find((c) => c.sourceId === "src-1")!;
    expect(view).toMatchObject({
      status: "active",
      actionable: true,
      capturedTitle: "迈向第三代人工智能",
      targetTitle: "目标文献",
    });
    // 关键语义：识别成功 ≠ 回填。票没消费，服务端一个请求都没发。
    expect(apiMocks.completeOriginMetadata).not.toHaveBeenCalled();
  });

  it("用户确认后回填：用任务自带的环境快照与票据；成功后 done + 通知 + library-changed", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const popup = connectPopup(harness.listeners);
    // 任务环境 ≠ 当前配对环境：回填必须用派发时快照的 apiBaseUrl。
    await dispatchCompletion(harness, { apiBaseUrl: "http://localhost:3002" });
    stubDetailCapture(harness);
    // library-changed 是完成时的 fire-and-forget 广播：白名单标签要先就位。
    harness.chromeMock.tabs.query = vi.fn(async () => [{ id: 11, url: "https://mangowrite.com/library" }]);
    fireTabComplete(harness.listeners, 42);
    await waitFor(
      () => latestCompletions(popup).some((c) => c.actionable),
      "确认卡出现",
    );

    const res = await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/apply-completion",
      sourceId: "src-1",
    });
    expect(res.ok).toBe(true);

    await waitFor(
      () => latestCompletions(popup).some((c) => c.status === "done"),
      "任务完成广播",
    );
    expect(apiMocks.completeOriginMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        apiBaseUrl: "http://localhost:3002",
        token: "ticket-1",
        sourceId: "src-1",
        metadata: DETAIL_CAPTURE.metadata,
        resolverSource: "plugin-dom-zh",
        allowMismatch: false,
      }),
    );
    const view = latestCompletions(popup).find((c) => c.sourceId === "src-1")!;
    expect(view).toMatchObject({ status: "done", message: "已更新到你的文库条目。" });
    expect(harness.chromeMock.notifications.create).toHaveBeenCalledWith(
      "mango-write-completion-src-1",
      expect.objectContaining({ title: "题录更新完成" }),
    );

    await waitFor(
      () =>
        harness.chromeMock.tabs.sendMessage.mock.calls.some(
          ([, msg]) => (msg as { type?: string }).type === "mango-write/library-changed",
        ),
      "library-changed 广播",
    );
  });

  it("409 错配不终局：差异挂任务等「仍要更新」，确认后带 allowMismatch 重试成功", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const popup = connectPopup(harness.listeners);
    await dispatchCompletion(harness);
    stubDetailCapture(harness);
    fireTabComplete(harness.listeners, 42);
    await waitFor(() => latestCompletions(popup).some((c) => c.actionable), "确认卡出现");

    apiMocks.completeOriginMetadata.mockRejectedValueOnce(
      new apiMocks.CompletionSubmitError(409, "标题不匹配"),
    );
    const first = await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/apply-completion",
      sourceId: "src-1",
    });
    expect(first.ok).toBe(true);

    await waitFor(
      () => latestCompletions(popup).some((c) => c.mismatch && c.sourceId === "src-1"),
      "错配挂起",
    );
    const mismatched = latestCompletions(popup).find((c) => c.sourceId === "src-1")!;
    // 任务仍在（可重试）、待确认捕获还在（pending 未清）。
    expect(mismatched).toMatchObject({ status: "active", mismatch: true, actionable: true });

    // 用户核对后明确「仍要更新」：同一张票，allowMismatch 放行标题闸门。
    const second = await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/apply-completion",
      sourceId: "src-1",
      allowMismatch: true,
    });
    expect(second.ok).toBe(true);
    await waitFor(
      () => latestCompletions(popup).some((c) => c.status === "done"),
      "确认后完成",
    );
    expect(apiMocks.completeOriginMetadata).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceId: "src-1", allowMismatch: true }),
    );
  });

  it("401 票据失效是终局：失败卡留作回执（可移除），通知指向回文库重新发起", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const popup = connectPopup(harness.listeners);
    await dispatchCompletion(harness);
    stubDetailCapture(harness);
    fireTabComplete(harness.listeners, 42);
    await waitFor(() => latestCompletions(popup).some((c) => c.actionable), "确认卡出现");

    apiMocks.completeOriginMetadata.mockRejectedValueOnce(
      new apiMocks.CompletionSubmitError(401, "ticket invalid"),
    );
    const res = await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/apply-completion",
      sourceId: "src-1",
    });
    expect(res.ok).toBe(true);

    await waitFor(
      () => latestCompletions(popup).some((c) => c.status === "failed"),
      "失败回执落列表",
    );
    const failed = latestCompletions(popup).find((c) => c.sourceId === "src-1")!;
    expect(failed.message).toContain("请回文库重新发起");
    expect(harness.chromeMock.notifications.create).toHaveBeenCalledWith(
      "mango-write-completion-src-1",
      expect.objectContaining({ title: "题录更新未完成" }),
    );

    // 失败卡可移除（cancel-completion 删除任务），列表清空。
    await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/cancel-completion",
      sourceId: "src-1",
    });
    await waitFor(() => latestCompletions(popup).length === 0, "失败卡移除");
  });

  it("网络/5xx 是暂态：任务与待确认题录都留着，直接重试即可", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const popup = connectPopup(harness.listeners);
    await dispatchCompletion(harness);
    stubDetailCapture(harness);
    fireTabComplete(harness.listeners, 42);
    await waitFor(() => latestCompletions(popup).some((c) => c.actionable), "确认卡出现");

    apiMocks.completeOriginMetadata.mockRejectedValueOnce(
      new apiMocks.CompletionSubmitError(503, "upstream down"),
    );
    await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/apply-completion",
      sourceId: "src-1",
    });

    await waitFor(
      () =>
        latestCompletions(popup).some(
          (c) => c.status === "active" && c.actionable && c.sourceId === "src-1",
        ),
      "暂态失败后可重试",
    );
    // 待确认题录没被清：再来一次确认就直接走回填。
    await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/apply-completion",
      sourceId: "src-1",
    });
    await waitFor(
      () => latestCompletions(popup).some((c) => c.status === "done"),
      "重试后完成",
    );
    expect(apiMocks.completeOriginMetadata).toHaveBeenCalledTimes(2);
  });

  it("关联标签上的普通「导入」接入更新任务，绝不另建条目", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const popup = connectPopup(harness.listeners);
    await dispatchCompletion(harness);
    stubDetailCapture(harness);

    // 用户在任务关联的详情页标签上点了「导入此页」。
    const res = await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/begin-capture",
      tabId: 42,
    });

    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ message: expect.stringContaining("请在任务列表确认") });
    // 导入队列一行都没有；识别到的题录进了任务的确认卡。
    expect(persistedCaptures(harness.localStore)).toHaveLength(0);
    await waitFor(
      () => latestCompletions(popup).some((c) => c.actionable),
      "确认卡出现",
    );
    expect(apiMocks.completeOriginMetadata).not.toHaveBeenCalled();
  });

  it("任务标签被逐个关闭：任务不消失（还有从任务延伸的标签时）；全关由超时清扫收", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const popup = connectPopup(harness.listeners);
    await dispatchCompletion(harness);
    for (const fn of harness.listeners.tabCreated) {
      (fn as (tab: { id: number; openerTabId: number }) => void)({ id: 43, openerTabId: 42 });
    }

    // 关掉最初的检索标签（42）：任务关联还剩详情页标签（43），详情页照常确认。
    for (const fn of harness.listeners.tabRemoved) (fn as (id: number) => void)(42);
    stubDetailCapture(harness);
    fireTabComplete(harness.listeners, 43);
    await flushUntil(
      () => latestCompletions(popup).some((c) => c.actionable),
      "剩下的关联标签上仍能确认",
    );

    // 最后一个关联标签也关掉：任务仍在（等超时清扫），不随标签立刻消失。
    for (const fn of harness.listeners.tabRemoved) (fn as (id: number) => void)(43);
    await flushUntil(() => true, "flush");
    expect(latestCompletions(popup)).toHaveLength(1);
    expect(apiMocks.completeOriginMetadata).not.toHaveBeenCalled();
  });

  it("15 分钟未确认的在途任务被清扫，通知说明回去重来；终态回执静默过期", async () => {
    // 假定时器：waitUntil 内部的轮询也是定时器，会被冻住——全程用微任务
    // 冲刷（flushUntil）等异步链落地。
    vi.useFakeTimers();
    try {
      const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
      const popup = connectPopup(harness.listeners);
      await dispatchCompletion(harness);
      stubDetailCapture(harness);
      fireTabComplete(harness.listeners, 42);
      await flushUntil(
        () => latestCompletions(popup).some((c) => c.actionable),
        "确认卡出现",
      );

      // 先确认成功一条（done 回执），再推进 16 分钟——done 的不该发超时通知。
      await sendBackgroundMessage(harness.listeners, {
        type: "mango-write/apply-completion",
        sourceId: "src-1",
      });
      await flushUntil(
        () => latestCompletions(popup).some((c) => c.status === "done"),
        "第一条完成",
      );
      await dispatchCompletion(harness, { sourceId: "src-2", token: "ticket-2" });
      await flushUntil(() => latestCompletions(popup).length === 2, "第二条任务登记");
      (harness.chromeMock.notifications.create as ReturnType<typeof vi.fn>).mockClear();

      await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
      for (const fn of harness.listeners.alarm) fn({ name: "mango-write/reconcile" });
      await flushUntil(() => latestCompletions(popup).length === 0, "过期任务被清扫");

      const timeoutNotifications = harness.chromeMock.notifications.create.mock.calls.filter(
        ([id]) => id === "mango-write-completion-src-2",
      );
      expect(timeoutNotifications).toHaveLength(1);
      expect(
        harness.chromeMock.notifications.create.mock.calls.filter(
          ([id]) => id === "mango-write-completion-src-1",
        ),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("取消任务：从列表摘除，不再识别、不再回填", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const popup = connectPopup(harness.listeners);
    await dispatchCompletion(harness);

    const res = await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/cancel-completion",
      sourceId: "src-1",
    });
    expect(res.result).toMatchObject({ message: expect.stringContaining("已取消") });
    await flushUntil(() => latestCompletions(popup).length === 0, "取消后列表清空");

    // 取消后原标签再识别出详情页题录：不落确认卡、不回填。
    stubDetailCapture(harness);
    fireTabComplete(harness.listeners, 42);
    await flushUntil(() => true, "flush");
    expect(latestCompletions(popup)).toHaveLength(0);
    expect(apiMocks.completeOriginMetadata).not.toHaveBeenCalled();
  });

  it("service worker 重启后：session 里在途任务恢复，终态不续跑", async () => {
    const first = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    connectPopup(first.listeners);
    await dispatchCompletion(first);
    await flushUntil(() => first.sessionStore.has("metadataCompletionTasks"), "任务落 session");

    // 模拟 SW 回收重启：全新模块态，仅 session 存量还在。
    const second = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
      session: { metadataCompletionTasks: first.sessionStore.get("metadataCompletionTasks") },
    });
    const popup = connectPopup(second.listeners);
    const completions = latestCompletions(popup);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ sourceId: "src-1", status: "active" });
  });

  it("SW 重启时 applying 任务恢复成可重试的 active，并明说上次被打断", async () => {
    // 事故形状：用户点了「更新题录」，SW 被回收——在途请求早不存在了。
    // 不恢复成 active 的话任务永远卡在「更新中」且无处可点。
    const applying = {
      sourceId: "src-1",
      token: "ticket-1",
      apiBaseUrl: PAIRING.apiBaseUrl,
      targetTitle: "目标文献",
      targetDoi: null,
      tabIds: [42],
      createdAt: Date.now(),
      pending: null,
      status: "applying",
      mismatch: false,
    };
    const harness = await loadBackground({
      local: { "mangoWrite.pairing": PAIRING },
      session: { metadataCompletionTasks: [applying] },
    });
    const popup = connectPopup(harness.listeners);

    const view = latestCompletions(popup).find((c) => c.sourceId === "src-1")!;
    expect(view).toMatchObject({ status: "active" });
    expect(view.message).toContain("中途被打断");
  });

  it("提交边界：更新进行中不接取消，也不接第二次 apply；出结果后才可结束", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const popup = connectPopup(harness.listeners);
    await dispatchCompletion(harness);
    stubDetailCapture(harness);
    fireTabComplete(harness.listeners, 42);
    await waitFor(() => latestCompletions(popup).some((c) => c.actionable), "确认卡出现");

    // 让回填请求挂在途：apply 的 status 翻转先于 HTTP 落地。
    let release: (value: unknown) => void = () => {};
    apiMocks.completeOriginMetadata.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }) as never,
    );
    const applying = sendBackgroundMessage(harness.listeners, {
      type: "mango-write/apply-completion",
      sourceId: "src-1",
    });
    await flushUntil(
      () => latestCompletions(popup).some((c) => c.status === "applying"),
      "任务进入 applying",
    );

    // 取消被拒：请求已发出，服务端可能已完成写入——取消了反而对不上真实状态。
    const cancelled = await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/cancel-completion",
      sourceId: "src-1",
    });
    expect(cancelled.result).toMatchObject({ message: expect.stringContaining("无法取消") });
    // 任务还在（没被删），也不能再叠一次提交。
    expect(latestCompletions(popup).some((c) => c.sourceId === "src-1")).toBe(true);
    const again = await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/apply-completion",
      sourceId: "src-1",
    });
    expect(again.result).toMatchObject({ message: expect.stringContaining("正在更新中") });

    release({ appliedFields: ["DOI"], needsCompletion: false, absorbedSourceIds: [], absorbedTitles: [] });
    await applying;
    await flushUntil(
      () => latestCompletions(popup).some((c) => c.status === "done"),
      "请求落定后任务完成",
    );
    // 完成后「结束任务」照常可删。
    const dismissed = await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/cancel-completion",
      sourceId: "src-1",
    });
    expect(dismissed.ok).toBe(true);
    await flushUntil(() => latestCompletions(popup).length === 0, "结束后列表清空");
  });

  it("409 归因 doi：任务挂起摆两边 DOI 等「仍要更新」，确认后放行", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const popup = connectPopup(harness.listeners);
    await dispatchCompletion(harness);
    stubDetailCapture(harness);
    fireTabComplete(harness.listeners, 42);
    await waitFor(() => latestCompletions(popup).some((c) => c.actionable), "确认卡出现");

    apiMocks.completeOriginMetadata.mockRejectedValueOnce(
      new apiMocks.CompletionSubmitError(409, "DOI 冲突", {
        error: "completion_title_mismatch",
        reason: "doi",
        expectedDoi: "10.13530/j.cnki.jlis.2024011",
        capturedDoi: "10.9999/other",
      }),
    );
    await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/apply-completion",
      sourceId: "src-1",
    });
    await flushUntil(
      () => latestCompletions(popup).some((c) => c.mismatch && c.sourceId === "src-1"),
      "DOI 错配挂起",
    );
    const view = latestCompletions(popup).find((c) => c.sourceId === "src-1")!;
    expect(view).toMatchObject({
      status: "active",
      mismatch: true,
      mismatchReason: "doi",
      expectedDoi: "10.13530/j.cnki.jlis.2024011",
      capturedDoi: "10.9999/other",
    });
    expect(view.message).toContain("DOI 与目标条目的 DOI 不一致");

    // 核对后仍要更新：同一张票带 allowMismatch 重试。
    await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/apply-completion",
      sourceId: "src-1",
      allowMismatch: true,
    });
    await flushUntil(
      () => latestCompletions(popup).some((c) => c.status === "done"),
      "确认后完成",
    );
    expect(apiMocks.completeOriginMetadata).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceId: "src-1", allowMismatch: true }),
    );
  });

  it("409 文件冲突：不合并不删文件，任务与捕获都留着，点名冲突条目", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const popup = connectPopup(harness.listeners);
    await dispatchCompletion(harness);
    stubDetailCapture(harness);
    fireTabComplete(harness.listeners, 42);
    await waitFor(() => latestCompletions(popup).some((c) => c.actionable), "确认卡出现");

    apiMocks.completeOriginMetadata.mockRejectedValueOnce(
      new apiMocks.CompletionSubmitError(409, "文件冲突", {
        error: "completion_file_conflict",
        conflictTitle: "汉语名句理解研究（扫描件）",
      }),
    );
    await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/apply-completion",
      sourceId: "src-1",
    });
    await flushUntil(
      () => latestCompletions(popup).some((c) => c.sourceId === "src-1" && c.message?.includes("没有合并")),
      "冲突说明落任务",
    );
    const view = latestCompletions(popup).find((c) => c.sourceId === "src-1")!;
    // 不是错配路径：没有「仍要更新」这种一键放行，出路是回文库决定保留哪条。
    expect(view).toMatchObject({ status: "active", mismatch: false, actionable: true });
    expect(view.message).toContain("《汉语名句理解研究（扫描件）》");
    expect(view.message).not.toContain("仍要更新");

    // 冲突不是暂态也不是终局：捕获还在，用户处理完重复条目可直接重试。
    await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/apply-completion",
      sourceId: "src-1",
    });
    await flushUntil(
      () => latestCompletions(popup).some((c) => c.status === "done"),
      "重试后完成",
    );
  });

  it("撞库合并成功：回执点名被合并条目，done 卡带文库深链", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const popup = connectPopup(harness.listeners);
    await dispatchCompletion(harness);
    stubDetailCapture(harness);
    fireTabComplete(harness.listeners, 42);
    await waitFor(() => latestCompletions(popup).some((c) => c.actionable), "确认卡出现");

    apiMocks.completeOriginMetadata.mockResolvedValueOnce({
      appliedFields: ["DOI"],
      needsCompletion: false,
      absorbedSourceIds: ["src-other"],
      absorbedTitles: ["汉语名句理解研究（普通导入）"],
    });
    await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/apply-completion",
      sourceId: "src-1",
    });
    await flushUntil(
      () => latestCompletions(popup).some((c) => c.status === "done"),
      "合并后完成",
    );
    const view = latestCompletions(popup).find((c) => c.sourceId === "src-1")!;
    expect(view.message).toBe("已更新到你的文库条目，并与《汉语名句理解研究（普通导入）》合并为一条。");
    expect(view.absorbedTitles).toEqual(["汉语名句理解研究（普通导入）"]);
    // 「在文库中查看」深链：任务环境的个人阅读页。
    expect(view.libraryUrl).toBe("https://api.example.com/u/read/src-1");
  });

  it("错配后换到正确的详情页：新捕获顶掉旧错配，差异与说明一起重置", async () => {
    const harness = await loadBackground({ local: { "mangoWrite.pairing": PAIRING } });
    const popup = connectPopup(harness.listeners);
    await dispatchCompletion(harness);
    stubDetailCapture(harness);
    fireTabComplete(harness.listeners, 42);
    await waitFor(() => latestCompletions(popup).some((c) => c.actionable), "确认卡出现");

    apiMocks.completeOriginMetadata.mockRejectedValueOnce(
      new apiMocks.CompletionSubmitError(409, "标题不匹配", {
        error: "completion_title_mismatch",
        reason: "title",
      }),
    );
    await sendBackgroundMessage(harness.listeners, {
      type: "mango-write/apply-completion",
      sourceId: "src-1",
    });
    await flushUntil(
      () => latestCompletions(popup).some((c) => c.mismatch && c.sourceId === "src-1"),
      "错配挂起",
    );

    // 用户在同一任务标签里导航到正确的详情页：最新识别顶掉错页捕获。
    harness.chromeMock.tabs.sendMessage = vi.fn(async () => ({
      ...DETAIL_CAPTURE,
      title: "迈向第三代人工智能（修订版）",
      metadata: { title: "迈向第三代人工智能（修订版）", DOI: "10.13530/j.cnki.jlis.2024012" },
    })) as never;
    fireTabComplete(harness.listeners, 42);
    await flushUntil(
      () =>
        latestCompletions(popup).some(
          (c) => c.sourceId === "src-1" && c.capturedTitle === "迈向第三代人工智能（修订版）" && !c.mismatch,
        ),
      "新捕获顶掉错配",
    );
    const view = latestCompletions(popup).find((c) => c.sourceId === "src-1")!;
    expect(view.mismatch).toBe(false);
    expect(view.mismatchReason ?? null).toBeNull();
    expect(view.message).toBeUndefined();
    // 新捕获可再次确认回填。
    expect(view.actionable).toBe(true);
  });
});
