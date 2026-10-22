/**
 * popup.ts 是裸 DOM 脚本（无框架），node 环境下用手写的最小 DOM/chrome 桩驱动：
 * getElementById 按需自动造 FakeEl，window.parent === window 跳过 FAB 高度同步
 * （那段需要 ResizeObserver，与这两个 FR 无关）。
 *
 * 覆盖两件事：
 * - 有进行中捕获时 beforeunload 拦截关闭；全部终态后放行。
 * - capture-list 广播驱动进度条渲染（百分比文本 + bar 宽度 + 步骤文案）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureListMessage, CaptureView, CompletionView } from "./protocol.js";

// 日志与构建横幅对本测试正交。
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

// update-check.ts（popup 打开时的更新检查）直接读这两个构建常量：
// 钉成 site 渠道 + 测试源，fetch 由用例自行 stub。
vi.mock("./build-info.js", () => ({
  API_BASE_URL: "http://test.local",
  BUILD_CHANNEL: "site",
}));

class FakeClassList {
  added = new Set<string>();
  add(name: string) {
    this.added.add(name);
  }
  remove(name: string) {
    this.added.delete(name);
  }
  toggle(name: string, force?: boolean) {
    const on = force ?? !this.added.has(name);
    if (on) this.added.add(name);
    else this.added.delete(name);
  }
  contains(name: string) {
    return this.added.has(name);
  }
}

class FakeEl {
  tagName: string;
  className = "";
  textContent = "";
  innerHTML = "";
  title = "";
  hidden = false;
  disabled = false;
  checked = false;
  style: Record<string, string> = {};
  children: FakeEl[] = [];
  classList = new FakeClassList();
  listeners: Record<string, Array<() => void>> = {};

  constructor(tagName: string) {
    this.tagName = tagName;
  }
  append(...nodes: FakeEl[]) {
    this.children.push(...nodes);
  }
  appendChild(node: FakeEl) {
    this.children.push(node);
  }
  replaceChildren(...nodes: FakeEl[]) {
    this.children = [...nodes];
  }
  setAttribute() {}
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  /** 深度优先找第一个满足条件的后代节点。 */
  find(pred: (el: FakeEl) => boolean): FakeEl | null {
    for (const child of this.children) {
      if (pred(child)) return child;
      const hit = child.find(pred);
      if (hit) return hit;
    }
    return null;
  }
  findAll(pred: (el: FakeEl) => boolean, out: FakeEl[] = []): FakeEl[] {
    for (const child of this.children) {
      if (pred(child)) out.push(child);
      child.findAll(pred, out);
    }
    return out;
  }
}

interface Harness {
  elements: Map<string, FakeEl>;
  windowListeners: Map<string, Array<(event: unknown) => void>>;
  portMessageListeners: Array<(msg: CaptureListMessage) => void>;
  sendMessage: ReturnType<typeof vi.fn>;
  sendTabMessage: ReturnType<typeof vi.fn>;
  tabsCreate: ReturnType<typeof vi.fn>;
  windowClose: ReturnType<typeof vi.fn>;
  /** embedded 模式下 window.parent.postMessage 的桩（closeSelf 的宿主通道）。 */
  parentPostMessage: ReturnType<typeof vi.fn>;
}

function makeHarness(options: {
  tabUrl?: string;
  recognizedOriginUrl?: string;
  /** background 的 Content-Type 事实表对该标签页的回答（缺省 = unknown）。 */
  tabDocument?: { kind: "pdf" | "html" | "unknown"; contentType?: string | null; url?: string };
  /** probe-url 探测的回包（content script 失效的旧标签页走这条兜底）。 */
  probedKind?: "pdf" | "html";
  /** ping 应答里 content script 报告的 viewerShell。 */
  pingViewerShell?: boolean;
  /** get-pairing-state 回包里的 membership（缺省 = 不带该字段）。 */
  membership?: unknown;
  /** get-pairing-state 回包里的 apiBaseUrl（缺省 = 不带该字段，popup 回退构建常量）。 */
  pairingApiBaseUrl?: string;
  /** true = popup 被嵌在页面 FAB 面板的 iframe 里（window.parent ≠ window）。 */
  embedded?: boolean;
} = {}): Harness {
  const elements = new Map<string, FakeEl>();
  const windowListeners = new Map<string, Array<(event: unknown) => void>>();
  const portMessageListeners: Array<(msg: CaptureListMessage) => void> = [];
  const tabsCreate = vi.fn(async () => ({}));
  const windowClose = vi.fn();

  // popup.html 的 update-banner / membership-bar 带 hidden 属性——镜像真实
  // 初始态，否则 FakeEl 默认 hidden=false 会让「不该显示」的断言形同虚设。
  const updateBanner = new FakeEl("#update-banner");
  updateBanner.hidden = true;
  elements.set("update-banner", updateBanner);
  const membershipBar = new FakeEl("#membership-bar");
  membershipBar.hidden = true;
  elements.set("membership-bar", membershipBar);

  const sendMessage = vi.fn(async (message: { type?: string }) => {
    switch (message?.type) {
      case "mango-write/get-pairing-state":
        return {
          ok: true,
          result: {
            paired: true,
            user: { email: "u@example.com", name: null },
            ...(options.pairingApiBaseUrl ? { apiBaseUrl: options.pairingApiBaseUrl } : {}),
            ...(options.membership !== undefined ? { membership: options.membership } : {}),
          },
        };
      case "mango-write/get-settings":
        return { ok: true, result: { fabEnabled: true } };
      case "mango-write/get-recognized-state":
        return {
          ok: true,
          result: {
            recognized: false,
            ...(options.recognizedOriginUrl ? { originUrl: options.recognizedOriginUrl } : {}),
          },
        };
      case "mango-write/get-tab-document":
        return {
          ok: true,
          result: options.tabDocument ?? { kind: "unknown", contentType: null, url: "" },
        };
      case "mango-write/probe-url":
        return options.probedKind
          ? { ok: true, result: { kind: options.probedKind } }
          : { ok: true, result: {} };
      case "mango-write/begin-capture":
        return { ok: true, result: { captureId: "cap-1" } };
      default:
        return { ok: true, result: {} };
    }
  });
  // 标签侧消息：ping 探针。用例可覆盖成「无 content script」（原生 PDF 查看器）
  // 或「应答方在 PDF 查看器壳上」（当前 Chrome 会往查看器页注入 content script）。
  // 页面读取（capture-page-context）不再由 popup 发起——它归 background 编排。
  const sendTabMessage = vi.fn(async (_tabId: number, message: { type?: string }) => {
    switch (message?.type) {
      case "mango-write/ping":
        return { ok: true, viewerShell: Boolean(options.pingViewerShell) };
      default:
        return undefined;
    }
  });

  const fakeWindow: Record<string, unknown> = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      const list = windowListeners.get(type) ?? [];
      list.push(fn);
      windowListeners.set(type, list);
    },
    close: windowClose,
  };
  const parentPostMessage = vi.fn();
  // embedded：FAB 面板 iframe——window.parent 指向宿主页面；高度同步路径会
  // 用到 ResizeObserver，相关用例自行 stubGlobal。
  fakeWindow.parent = options.embedded ? { postMessage: parentPostMessage } : fakeWindow;

  const fakeDocument = {
    readyState: "complete",
    getElementById: (id: string) => {
      let el = elements.get(id);
      if (!el) {
        el = new FakeEl(`#${id}`);
        elements.set(id, el);
      }
      return el;
    },
    createElement: (tag: string) => new FakeEl(tag),
    addEventListener: () => {},
    body: new FakeEl("body"),
  };

  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage,
      connect: () => ({
        onMessage: { addListener: (fn: (msg: CaptureListMessage) => void) => portMessageListeners.push(fn) },
        onDisconnect: { addListener: () => {} },
        postMessage: () => {},
      }),
    },
    tabs: {
      query: async () => [{ id: 1, url: options.tabUrl ?? "https://arxiv.org/abs/2401.00001", title: "A Paper" }],
      sendMessage: sendTabMessage,
      create: tabsCreate,
    },
  });

  return { elements, windowListeners, portMessageListeners, sendMessage, sendTabMessage, tabsCreate, windowClose, parentPostMessage };
}

async function flush(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function makeView(patch: Partial<CaptureView>): CaptureView {
  return {
    captureId: "c1",
    originUrl: "https://arxiv.org/abs/2401.00001",
    title: "A Paper",
    state: "acquiring",
    step: "downloading",
    progress: 0,
    actions: [],
    done: false,
    createdAt: 1,
    ...patch,
  };
}

async function loadPopup(options: Parameters<typeof makeHarness>[0] = {}): Promise<Harness> {
  vi.resetModules();
  // node 有全局 fetch——与更新检查无关的用例默认钉成离线，避免真实网络请求。
  // 关心更新检查的用例在调 loadPopup 前自行 stubGlobal("fetch", …)。
  if (!vi.isMockFunction(globalThis.fetch)) {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
  }
  const harness = makeHarness(options);
  await import("./popup.js");
  await flush();
  return harness;
}

function pushCaptureList(harness: Harness, captures: CaptureView[]): void {
  for (const fn of harness.portMessageListeners) {
    fn({ type: "mango-write/capture-list", captures });
  }
}

/** 队列卡片按渲染顺序取出（列表分了「需要处理/最近记录」两组，包在组 div 里）。 */
function taskCards(harness: Harness): FakeEl[] {
  return harness.elements
    .get("task-list")!
    .findAll((el) => typeof el.className === "string" && el.className.startsWith("task "));
}

beforeEach(() => {
  // 每个用例 loadPopup 自行 resetModules + 装桩。
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("关闭提示：进行中捕获拦截 popup 关闭", () => {
  function fireBeforeUnload(harness: Harness) {
    const handlers = harness.windowListeners.get("beforeunload") ?? [];
    expect(handlers.length).toBe(1);
    const event = { preventDefault: vi.fn(), returnValue: "" as unknown };
    handlers[0](event);
    return event;
  }

  it("有未完成任务时阻止关闭并给出「后台继续运行」提示", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [makeView({ state: "acquiring", progress: 25 })]);

    const event = fireBeforeUnload(harness);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(String(event.returnValue)).toContain("关闭不会中断");
  });

  it("全部任务终态后不再拦截关闭", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [
      makeView({ captureId: "c1", state: "completed", progress: 100, done: true }),
      makeView({ captureId: "c2", state: "failed", done: true, createdAt: 2 }),
    ]);

    const event = fireBeforeUnload(harness);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.returnValue).toBe("");
  });

  it("任务从进行中变为终态后，拦截随之解除（跟着最新广播走）", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [makeView({ state: "uploading", progress: 70 })]);
    expect(fireBeforeUnload(harness).preventDefault).toHaveBeenCalled();

    pushCaptureList(harness, [makeView({ state: "completed", progress: 100, done: true })]);
    expect(fireBeforeUnload(harness).preventDefault).not.toHaveBeenCalled();
  });
});

describe("导入进度条渲染", () => {
  it("最新的导入排在列表最上面", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [
      makeView({ captureId: "old", title: "Older Paper", createdAt: 1 }),
      makeView({ captureId: "new", title: "Newer Paper", createdAt: 2, state: "queued", progress: 55 }),
    ]);

    const titles = taskCards(harness).map((card) => card.find((el) => el.className === "task-title")?.textContent);
    expect(titles).toEqual(["Newer Paper", "Older Paper"]);
  });

  it("进行中的任务渲染百分比文本、进度条宽度与步骤文案", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [
      makeView({
        state: "acquiring",
        progress: 25.4,
        sourceSite: "arXiv",
        detail: "已下载 0.5 / 1.0 MB (50%)",
      }),
    ]);

    expect(taskCards(harness).length).toBe(1);
    const card = taskCards(harness)[0]!;
    expect(card.className).toBe("task acquiring");

    const pct = card.find((el) => el.className === "task-pct");
    expect(pct?.textContent).toBe("25%"); // Math.round(25.4)

    const bar = card.find((el) => el.className === "progress-bar");
    expect(bar?.children[0]?.style.width).toBe("25%");

    const detail = card.find((el) => el.className === "task-detail");
    expect(detail?.textContent).toBe("arXiv · 已下载 0.5 / 1.0 MB (50%)");
  });

  it("上传中的任务用 stateLabel 兜底步骤文案", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [makeView({ state: "uploading", progress: 70 })]);

    const card = taskCards(harness)[0]!;
    expect(card.find((el) => el.className === "task-pct")?.textContent).toBe("70%");
    expect(card.find((el) => el.className === "task-detail")?.textContent).toBe("正在上传到 MangoWrite…");
  });

  it("失败卡两行式：白话原因 + 怎么办，原始技术串只挂 tooltip", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [
      makeView({
        state: "failed",
        done: true,
        failure: { kind: "network", raw: "Failed to fetch" },
        actions: ["reimport"],
      }),
    ]);

    const card = taskCards(harness)[0]!;
    const reason = card.find((el) => el.className === "task-error");
    expect(reason?.textContent).toBe("网络连接出了问题");
    expect(reason?.title).toBe("Failed to fetch");
    expect(card.find((el) => el.className === "task-hint")?.textContent).toBe("请检查网络后重试。");
  });

  it("失败卡没有 failure 时兜底白话，不再显示英文机器码", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [makeView({ state: "failed", done: true })]);

    const card = taskCards(harness)[0]!;
    expect(card.find((el) => el.className === "task-error")?.textContent).toBe("导入没有成功");
  });

  it("队列汇总行统计各状态数量", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [
      makeView({ captureId: "c1", state: "acquiring", progress: 25, createdAt: 1 }),
      makeView({ captureId: "c2", state: "queued", progress: 55, createdAt: 2 }),
      makeView({ captureId: "c3", state: "failed", done: true, createdAt: 3 }),
      makeView({ captureId: "c4", state: "completed", progress: 100, done: true, createdAt: 4 }),
    ]);

    expect(harness.elements.get("queue-summary")?.textContent).toBe("1 进行中 · 1 排队 · 1 失败 · 1 完成");
  });

  it("等用户裁决的行置顶：旧的失败卡排在新完成任务前面，各有分区标签", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [
      makeView({ captureId: "new-done", title: "New Done", state: "completed", progress: 100, done: true, createdAt: 90 }),
      makeView({ captureId: "old-fail", title: "Old Fail", state: "failed", done: true, failure: { kind: "network" }, createdAt: 10 }),
      makeView({ captureId: "conflict", title: "Conflict", state: "conflict", done: true, createdAt: 30 }),
    ]);

    const list = harness.elements.get("task-list")!;
    const labels = [...list.children].map(
      (group) => group.find((el) => el.className === "queue-sub")?.textContent,
    );
    expect(labels).toEqual(["需要处理", "最近记录"]);

    const titles = taskCards(harness).map((card) =>
      card.find((el) => el.className === "task-title")?.textContent,
    );
    // 需要处理组内按时间倒序（conflict > fail），完成卡沉到最近记录。
    expect(titles).toEqual(["Conflict", "Old Fail", "New Done"]);
  });

  it("终态卡显示来源站点与相对时间；进行中的卡不显示", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [
      makeView({
        state: "completed",
        progress: 100,
        done: true,
        sourceSite: "CNKI",
        createdAt: Date.now() - 5 * 60_000,
      }),
      makeView({ state: "acquiring", progress: 25, sourceSite: "arXiv" }),
    ]);

    const [doneCard, activeCard] = taskCards(harness);
    expect(doneCard!.find((el) => el.className === "task-meta")?.textContent).toBe("CNKI · 5 分钟前");
    expect(activeCard!.find((el) => el.className === "task-meta")).toBeFalsy();
  });

  it("完成卡带「在文库中查看」深链，点击打开文库条目并关闭弹窗", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [
      makeView({
        state: "completed",
        progress: 100,
        done: true,
        libraryUrl: "https://api.example.com/u/read/src-1",
      }),
    ]);

    const card = taskCards(harness)[0]!;
    const open = card.find((el) => el.className === "task-open");
    expect(open?.textContent).toBe("在文库中查看 →");

    await (open!.listeners["click"][0]! as () => void)();
    expect(harness.tabsCreate).toHaveBeenCalledWith({ url: "https://api.example.com/u/read/src-1" });
    expect(harness.windowClose).toHaveBeenCalled();
  });

  it("没有 libraryUrl 的完成卡不出深链按钮", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [makeView({ state: "completed", progress: 100, done: true })]);

    expect(taskCards(harness)[0]!.find((el) => el.className === "task-open")).toBeFalsy();
  });

  it("卡片按内容签名复用：未变化的卡保持 DOM 身份，内容变了才重建", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [makeView({ captureId: "c1", state: "acquiring", progress: 25 })]);
    const before = taskCards(harness)[0];

    // 广播重放同样内容（别的任务变动触发）——同一节点原样挂回。
    pushCaptureList(harness, [makeView({ captureId: "c1", state: "acquiring", progress: 25 })]);
    expect(taskCards(harness)[0]).toBe(before);

    // 进度变化 → 该卡重建，其余不变。
    pushCaptureList(harness, [makeView({ captureId: "c1", state: "acquiring", progress: 80 })]);
    const rebuilt = taskCards(harness)[0]!;
    expect(rebuilt).not.toBe(before);
    expect(rebuilt.find((el) => el.className === "task-pct")?.textContent).toBe("80%");
  });

  it("空队列隐藏任务区", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [makeView({ state: "acquiring", progress: 25 })]);
    expect(harness.elements.get("queue-section")?.hidden).toBe(false);

    pushCaptureList(harness, []);
    expect(harness.elements.get("queue-section")?.hidden).toBe(true);
  });

  it("仅题录完成渲染警示而不是成功：warn 标签 + 警示文案 + 汇总单计", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [
      makeView({
        state: "completed",
        progress: 100,
        done: true,
        resultKind: "metadata-only",
        message: "已导入题录；站点要求登录，取不到原文。",
        createdAt: 3,
      }),
      makeView({
        captureId: "c2",
        state: "completed",
        progress: 100,
        done: true,
        resultKind: "pdf",
        createdAt: 2,
      }),
    ]);

    const metadataCard = taskCards(harness)[0]!;
    expect(metadataCard.find((el) => el.className === "task-status warn")?.textContent).toBe("仅题录");
    expect(metadataCard.find((el) => el.className === "task-status ok")).toBeFalsy();
    expect(metadataCard.find((el) => el.className === "task-warning")?.textContent).toContain("站点要求登录");

    const pdfCard = taskCards(harness)[1]!;
    expect(pdfCard.find((el) => el.className === "task-status ok")?.textContent).toBe("已完成");
    expect(pdfCard.find((el) => el.className === "task-status warn")).toBeFalsy();

    expect(harness.elements.get("queue-summary")?.textContent).toBe("1 仅题录 · 1 完成");
  });

  it("「已在库中但只有题录」同样是警示：alreadyInLibrary 不再压制 warning", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [
      makeView({
        state: "completed",
        progress: 100,
        done: true,
        resultKind: "metadata-only",
        alreadyInLibrary: true,
        message: "该文献已在文献库中，但仍只有题录、未取到全文。",
      }),
    ]);

    const card = taskCards(harness)[0]!;
    expect(card.className).toContain("warn");
    expect(card.find((el) => el.className === "task-status warn")?.textContent).toBe("仅题录");
    expect(card.find((el) => el.className === "task-warning")?.textContent).toContain("只有题录");
    expect(harness.elements.get("queue-summary")?.textContent).toBe("1 仅题录");
  });
});

describe("未识别页面与 PDF 页面的导入入口", () => {
  async function clickButton(harness: Harness, id: string): Promise<void> {
    const button = harness.elements.get(id)!;
    for (const fn of button.listeners["click"] ?? []) {
      await (fn as () => Promise<void>)();
    }
    await flush();
  }

  const clickCapture = (harness: Harness) => clickButton(harness, "capture");

  function beginCaptureCalls(harness: Harness): unknown[][] {
    return harness.sendMessage.mock.calls.filter(
      ([msg]) => (msg as { type?: string }).type === "mango-write/begin-capture",
    );
  }

  it("未识别页面点击导入：直接发 begin-capture 入队，不再在弹窗里二次确认", async () => {
    const harness = await loadPopup();

    await clickCapture(harness);

    expect(beginCaptureCalls(harness).length).toBe(1);
    // 确认转移到了队列卡片（confirm 态），弹窗内不再有确认块。
    expect(harness.elements.get("webpage-confirm")).toBeUndefined();
    expect(harness.elements.get("capture")?.disabled).toBe(false);
  });

  it("begin-capture 带上当前标签与导入目标；dedup 说明消息显示在状态徽标", async () => {
    const harness = await loadPopup();
    harness.sendMessage.mockImplementation(async (message: { type?: string }) => {
      if (message?.type === "mango-write/begin-capture") {
        return { ok: true, result: { message: "该文献已在导入队列中" } };
      }
      return { ok: true, result: {} };
    });

    await clickCapture(harness);

    const call = beginCaptureCalls(harness)[0]![0] as { tabId: number; teamId: null };
    expect(call.tabId).toBe(1);
    expect(call.teamId).toBeNull();
    expect(harness.elements.get("state-badge-text")?.textContent).toBe("该文献已在导入队列中");
  });

  it("confirm 态的队列卡片渲染「待确认」+ 确认/取消按钮，点击发对应消息", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [
      makeView({
        state: "confirm",
        done: true,
        progress: 30,
        detail: "未识别到文献信息，确认后按网页导入",
      }),
    ]);

    const card = taskCards(harness)[0]!;
    expect(card.find((el) => el.className === "task-status warn")?.textContent).toBe("待确认");
    expect(card.find((el) => el.className === "task-detail")?.textContent).toContain("按网页导入");

    const buttons = card.findAll((el) => el.tagName === "button");
    const labels = buttons.map((b) => b.textContent);
    expect(labels).toEqual(["按网页导入", "取消"]);

    await (buttons[0]!.listeners["click"][0]! as () => Promise<void>)();
    expect(
      harness.sendMessage.mock.calls.some(
        ([msg]) => (msg as { type?: string }).type === "mango-write/confirm-webpage-capture",
      ),
    ).toBe(true);

    await (buttons[1]!.listeners["click"][0]! as () => Promise<void>)();
    expect(
      harness.sendMessage.mock.calls.some(
        ([msg]) => (msg as { type?: string }).type === "mango-write/dismiss-capture",
      ),
    ).toBe(true);
  });

  it("队列汇总行把待确认单列", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [
      makeView({ captureId: "c1", state: "confirm", done: true, createdAt: 1 }),
      makeView({ captureId: "c2", state: "queued", progress: 55, createdAt: 2 }),
    ]);

    expect(harness.elements.get("queue-summary")?.textContent).toBe("1 排队 · 1 待确认");
  });

  it("有 content script 但未识别：徽标提示将按网页导入", async () => {
    const harness = await loadPopup();
    expect(harness.elements.get("state-badge-text")?.textContent).toBe("未识别到论文，将按网页导入");
  });

  it("无 content script 的 http(s) 标签（原生 PDF 查看器）：徽标提示 PDF 可直接导入", async () => {
    const harness = makeHarness();
    harness.sendTabMessage.mockRejectedValue(new Error("Could not establish connection. Receiving end does not exist."));
    vi.resetModules();
    await import("./popup.js");
    await flush();

    expect(harness.elements.get("state-badge-text")?.textContent).toBe("PDF 页面，可直接导入");
  });

  it("本地 PDF 标签页：徽标提示按文件导入；content script 在场也走 import-pdf-url，绝不进网页快照通道", async () => {
    // 生产事故复现条件：用户开了「允许访问文件网址」，查看器页面上 content
    // script 会应答——修复前它被当普通未识别网页快照导入，标题是编码 URL。
    const fileUrl = "file:///D:/%E5%BA%94%E7%94%A8%E8%BD%AF%E4%BB%B6/paper%20draft.pdf";
    const harness = await loadPopup({ tabUrl: fileUrl });

    expect(harness.elements.get("state-badge-text")?.textContent).toBe("本地 PDF 文件，将按文件导入");

    await clickCapture(harness);

    expect(beginCaptureCalls(harness).length).toBe(0);
    const pdfUrlCall = harness.sendMessage.mock.calls.find(
      ([msg]) => (msg as { type?: string }).type === "mango-write/import-pdf-url",
    );
    expect(pdfUrlCall).toBeTruthy();
    expect((pdfUrlCall![0] as { url: string }).url).toBe(fileUrl);
  });

  it("非 PDF 的本地 HTML 文件不进文件通道：同样发 begin-capture 按网页读取", async () => {
    const harness = await loadPopup({ tabUrl: "file:///D:/notes/readme.html" });

    expect(harness.elements.get("state-badge-text")?.textContent).toBe("未识别到论文，将按网页导入");

    await clickCapture(harness);

    expect(
      harness.sendMessage.mock.calls.some(
        ([msg]) => (msg as { type?: string }).type === "mango-write/import-pdf-url",
      ),
    ).toBe(false);
    expect(beginCaptureCalls(harness).length).toBe(1);
  });

  it("chrome:// 等内置页面：就地提示不支持导入，不制造队列记录", async () => {
    const harness = await loadPopup({ tabUrl: "chrome://newtab/" });

    await clickCapture(harness);

    expect(beginCaptureCalls(harness).length).toBe(0);
    expect(harness.elements.get("state-badge-text")?.textContent).toContain("不支持导入");
  });

  it("线上回归：darwin-online 式直达 PDF，content script 在查看器壳上应答 ping——凭 Content-Type 事实走 import-pdf-url，不进网页快照通道", async () => {
    // 生产事故复现条件：Chrome 原生查看器页注入了 content script 并应答
    // ping，旧的「无应答 = PDF」启发式判不出它，快照的是查看器壳子。
    const url = "https://darwin-online.org.uk/converted/pdf/1879_Bary_Symbiose_A3450.pdf";
    const harness = await loadPopup({
      tabUrl: url,
      tabDocument: { kind: "pdf", contentType: "application/pdf", url },
    });

    expect(harness.elements.get("state-badge-text")?.textContent).toBe("PDF 页面，可直接导入");

    await clickCapture(harness);

    expect(beginCaptureCalls(harness).length).toBe(0);
    const pdfUrlCall = harness.sendMessage.mock.calls.find(
      ([msg]) => (msg as { type?: string }).type === "mango-write/import-pdf-url",
    );
    expect(pdfUrlCall).toBeTruthy();
    expect((pdfUrlCall![0] as { url: string }).url).toBe(url);
  });

  it("Content-Type 事实覆盖 URL 形状：arXiv 式无扩展名 PDF 路径也走 PDF 通道", async () => {
    const url = "https://arxiv.org/pdf/2401.01234";
    const harness = await loadPopup({
      tabUrl: url,
      tabDocument: { kind: "pdf", contentType: "application/pdf", url },
    });

    expect(harness.elements.get("state-badge-text")?.textContent).toBe("PDF 页面，可直接导入");

    await clickCapture(harness);
    expect(
      harness.sendMessage.mock.calls.some(
        ([msg]) => (msg as { type?: string; url?: string }).type === "mango-write/import-pdf-url",
      ),
    ).toBe(true);
  });

  it("text/html 事实是否定判据：即使 content script 缺席也不标成 PDF 页面", async () => {
    const harness = makeHarness({
      tabUrl: "https://example.com/some-page",
      tabDocument: { kind: "html", contentType: "text/html", url: "https://example.com/some-page" },
    });
    harness.sendTabMessage.mockRejectedValue(new Error("Could not establish connection. Receiving end does not exist."));
    vi.resetModules();
    await import("./popup.js");
    await flush();

    expect(harness.elements.get("state-badge-text")?.textContent).toBe("未识别到论文，将按网页导入");
  });

  it("事实缺失（标签早于监听器存在）时退化到 .pdf 路径启发式，仍走 PDF 通道", async () => {
    const url = "https://legacy-site.org/papers/old-paper.pdf";
    const harness = await loadPopup({ tabUrl: url });

    expect(harness.elements.get("state-badge-text")?.textContent).toBe("PDF 页面，可直接导入");

    await clickCapture(harness);
    expect(
      harness.sendMessage.mock.calls.some(
        ([msg]) => (msg as { type?: string; url?: string }).type === "mango-write/import-pdf-url",
      ),
    ).toBe(true);
  });

  // 线上回归（GSU/Arizona，2026-09）：扩展更新后旧标签页的 content script
  // 失效，ping 无应答不再分得清网页与 PDF——GSU 论文页被报成「PDF 页面，
  // 可直接导入」。缺 Content-Type 记录时必须探 URL 字节拿事实。
  it("线上回归：content script 失效的旧标签页，探测为 html 就不再误报 PDF 页面", async () => {
    const url = "https://scholarworks.gsu.edu/items/71dfb819-4230-479c-a862-eafe9cde787d";
    const harness = makeHarness({ tabUrl: url, probedKind: "html" });
    // ping 无应答 = 旧 content script（扩展更新后未刷新的标签页）。
    harness.sendTabMessage.mockRejectedValue(new Error("Could not establish connection."));
    vi.resetModules();
    await import("./popup.js");
    await flush();

    expect(harness.elements.get("state-badge-text")?.textContent).toBe("未识别到论文，将按网页导入");
    expect(
      harness.sendMessage.mock.calls.some(
        ([msg]) => (msg as { type?: string }).type === "mango-write/probe-url",
      ),
    ).toBe(true);
  });

  it("content script 失效的旧标签页，探测为 pdf 仍走 PDF 通道（无 .pdf 后缀的直链）", async () => {
    const url = "https://repository.arizona.edu/bitstreams/e22c081e-db31-4eb2-beb0-d476033fc852/download";
    const harness = makeHarness({ tabUrl: url, probedKind: "pdf" });
    harness.sendTabMessage.mockRejectedValue(new Error("Could not establish connection."));
    vi.resetModules();
    await import("./popup.js");
    await flush();

    expect(harness.elements.get("state-badge-text")?.textContent).toBe("PDF 页面，可直接导入");
  });

  it("事实缺失且 URL 无 .pdf：ping 应答里的查看器壳报告兜底路由到 PDF 通道", async () => {
    const url = "https://viewer-host.org/record/12345/file";
    const harness = await loadPopup({ tabUrl: url, pingViewerShell: true });

    expect(harness.elements.get("state-badge-text")?.textContent).toBe("PDF 页面，可直接导入");

    await clickCapture(harness);
    expect(
      harness.sendMessage.mock.calls.some(
        ([msg]) => (msg as { type?: string; url?: string }).type === "mango-write/import-pdf-url",
      ),
    ).toBe(true);
    expect(beginCaptureCalls(harness).length).toBe(0);
  });
});

describe("网页重复判断", () => {
  it("用 content script 提供的 canonical URL 判断当前页是否正在导入", async () => {
    const harness = await loadPopup({
      tabUrl: "https://m.example.com/amp?id=9",
      recognizedOriginUrl: "https://example.com/article?id=9",
    });
    pushCaptureList(harness, [
      makeView({
        originUrl: "https://example.com/article?id=9",
        state: "acquiring",
      }),
    ]);

    expect(harness.elements.get("capture")?.disabled).toBe(true);
    expect(harness.elements.get("capture")?.textContent).toBe("已加入导入队列");
  });
});

describe("popup 打开时检查更新（site 渠道）", () => {
  /** version=null 模拟离线/非 200：fetchLatestVersion 静默返回 null。 */
  function stubManifest(version: string | null) {
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (version === null) throw new TypeError("fetch failed");
      return { ok: true, json: async () => ({ version }) } as Response;
    }));
  }

  it("有新版：显示 banner + 写入版本号，点击打开升级指引并关闭 popup", async () => {
    stubManifest("9.9.9");
    const harness = await loadPopup();

    const banner = harness.elements.get("update-banner")!;
    expect(banner.hidden).toBe(false);
    expect(harness.elements.get("update-version")?.textContent).toBe("v9.9.9");

    banner.listeners["click"][0]();
    expect(harness.tabsCreate).toHaveBeenCalledWith({ url: "http://test.local/extension" });
    expect(harness.windowClose).toHaveBeenCalled();
  });

  it("已是最新：banner 保持隐藏", async () => {
    stubManifest("0.0.0-test"); // env mock 钉的 VERSION
    const harness = await loadPopup();

    expect(harness.elements.get("update-banner")!.hidden).toBe(true);
  });

  it("manifest 拉取失败：静默，banner 保持隐藏", async () => {
    stubManifest(null);
    const harness = await loadPopup();

    expect(harness.elements.get("update-banner")!.hidden).toBe(true);
  });
});

describe("队列卡动作按钮：渲染 background 投影的 actions", () => {
  it("actions 带 retry-upload 渲染「重试」，点击发 retry-capture", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [makeView({ state: "failed", done: true, actions: ["retry-upload"] })]);

    const card = taskCards(harness)[0]!;
    const retry = card.find((el) => el.className === "btn-danger" && el.textContent === "重试");
    expect(retry).toBeTruthy();
    expect(card.find((el) => el.textContent === "跳转原页面重试")).toBeFalsy();

    await (retry!.listeners["click"][0]! as () => void)();
    expect(harness.sendMessage).toHaveBeenCalledWith({ type: "mango-write/retry-capture", captureId: "c1" });
  });

  it("actions 只有 reimport：失败卡渲染「跳转原页面重试」，点击发 reimport-capture", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [makeView({ state: "failed", done: true, actions: ["reimport"] })]);

    const card = taskCards(harness)[0]!;
    expect(card.find((el) => el.textContent === "重试")).toBeFalsy();
    const reimport = card.find((el) => el.textContent === "跳转原页面重试");
    expect(reimport).toBeTruthy();

    await (reimport!.listeners["click"][0]! as () => void)();
    expect(harness.sendMessage).toHaveBeenCalledWith({ type: "mango-write/reimport-capture", captureId: "c1" });
  });

  it("冲突卡：actions 不带 replace 就不渲染「更新为新 PDF」，只剩「保留原有」", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [makeView({ state: "conflict", done: true, actions: [] })]);

    const card = taskCards(harness)[0]!;
    expect(card.find((el) => el.textContent === "更新为新 PDF")).toBeFalsy();
    const keep = card.find((el) => el.className === "btn-ghost" && el.textContent === "保留原有");
    expect(keep).toBeTruthy();

    await (keep!.listeners["click"][0]! as () => void)();
    expect(harness.sendMessage).toHaveBeenCalledWith({ type: "mango-write/dismiss-capture", captureId: "c1" });
  });

  it("冲突卡 actions 带 replace：渲染「更新为新 PDF」，点击发 confirm-replace-capture", async () => {
    const harness = await loadPopup();
    pushCaptureList(harness, [makeView({ state: "conflict", done: true, actions: ["replace"] })]);

    const card = taskCards(harness)[0]!;
    const update = card.find((el) => el.textContent === "更新为新 PDF");
    expect(update).toBeTruthy();

    await (update!.listeners["click"][0]! as () => void)();
    expect(harness.sendMessage).toHaveBeenCalledWith({ type: "mango-write/confirm-replace-capture", captureId: "c1" });
  });
});

describe("popup 的关闭出口（toolbar 弹窗 vs FAB 面板 iframe）", () => {
  it("嵌在 FAB 面板里：深链点击照常开文库页，另发 fab-panel-hide 让宿主收起面板", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const harness = await loadPopup({ embedded: true });
    pushCaptureList(harness, [
      makeView({
        state: "completed",
        progress: 100,
        done: true,
        libraryUrl: "https://api.example.com/u/read/src-1",
      }),
    ]);

    const card = taskCards(harness)[0]!;
    const open = card.find((el) => el.className === "task-open")!;
    await (open.listeners["click"][0]! as () => void)();

    expect(harness.tabsCreate).toHaveBeenCalledWith({ url: "https://api.example.com/u/read/src-1" });
    expect(harness.parentPostMessage).toHaveBeenCalledWith({ type: "mango-write/fab-panel-hide" }, "*");
    expect(harness.windowClose).not.toHaveBeenCalled();
  });

  it("升级横幅键盘可触发：Enter 打开指引、走独立弹窗的关闭路径", async () => {
    // 与上方更新检查用例同一姿势：先钉 fetch 再加载 popup，让横幅亮出来。
    vi.stubGlobal("fetch", vi.fn(async () => {
      return { ok: true, json: async () => ({ version: "9.9.9" }) } as Response;
    }));
    const harness = await loadPopup();

    const banner = harness.elements.get("update-banner")!;
    expect(banner.hidden).toBe(false);
    const keydown = banner.listeners["keydown"]?.[0];
    expect(keydown).toBeTruthy();
    const event = { key: "Enter", preventDefault: vi.fn() };
    (keydown as (e: unknown) => void)(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(harness.tabsCreate).toHaveBeenCalledWith({ url: "http://test.local/extension" });
    expect(harness.windowClose).toHaveBeenCalled();
  });
});

describe("会员条", () => {
  const MEMBERSHIP = {
    tier: "pro",
    plan: { id: "plan-pro", name: "专业版", tierRank: 2 },
    expiresAt: null,
    parseWeek: { used: 3, limit: 20 },
  };

  it("已配对且有会员：crown 下小字档位名（单词一行）+ 本周解析用量", async () => {
    const harness = await loadPopup({
      membership: MEMBERSHIP,
      pairingApiBaseUrl: "https://pair.example.com/api",
    });

    const bar = harness.elements.get("membership-bar")!;
    expect(bar.hidden).toBe(false);
    // 名称按词分行渲染（与 web 顶栏同规则）。
    const name = harness.elements.get("membership-name")!;
    expect(name.children.map((c) => c.textContent)).toEqual(["专业版"]);
    expect(name.children.every((c) => c.className === "tier-name-line")).toBe(true);
    expect(harness.elements.get("membership-usage")?.textContent).toBe("本周解析 3/20");
  });

  it("两个单词的档位名分两行（单词不换行）", async () => {
    const harness = await loadPopup({
      membership: {
        ...MEMBERSHIP,
        plan: { id: "team-max", name: "Team Max", tierRank: 4 },
      },
    });

    const name = harness.elements.get("membership-name")!;
    expect(name.children.map((c) => c.textContent)).toEqual(["Team", "Max"]);
  });

  it("plan 为 null 时档位名兜底到 tier", async () => {
    const harness = await loadPopup({
      membership: { ...MEMBERSHIP, plan: null },
    });

    expect(harness.elements.get("membership-bar")!.hidden).toBe(false);
    expect(harness.elements.get("membership-name")!.children.map((c) => c.textContent)).toEqual([
      "pro"
    ]);
  });

  it("membership 为 null：整行不渲染（不占位）", async () => {
    const harness = await loadPopup();

    expect(harness.elements.get("membership-bar")!.hidden).toBe(true);
  });

  it("点击会员条：新开当前环境 origin 的 /u/membership 页并关闭 popup", async () => {
    const harness = await loadPopup({
      membership: MEMBERSHIP,
      // apiBaseUrl 带路径也只取 origin——权益页挂在 web origin 根下。
      pairingApiBaseUrl: "https://pair.example.com/api",
    });

    harness.elements.get("membership-bar")!.listeners["click"][0]!();
    await flush();

    expect(harness.tabsCreate).toHaveBeenCalledWith({ url: "https://pair.example.com/u/membership" });
    expect(harness.windowClose).toHaveBeenCalled();
  });

  it("配对状态没带 apiBaseUrl 时回退构建期常量", async () => {
    const harness = await loadPopup({ membership: MEMBERSHIP });

    harness.elements.get("membership-bar")!.listeners["click"][0]!();
    await flush();

    // build-info mock 钉的是 http://test.local。
    expect(harness.tabsCreate).toHaveBeenCalledWith({ url: "http://test.local/u/membership" });
  });
});

describe("补全/更正任务卡渲染（调整轮）", () => {
  function makeCompletionView(patch: Partial<CompletionView>): CompletionView {
    return {
      sourceId: "src-1",
      targetTitle: "目标文献",
      targetDoi: null,
      status: "active",
      mismatch: false,
      capturedTitle: null,
      createdAt: 1,
      actionable: false,
      ...patch,
    };
  }

  function pushCompletions(harness: Harness, completions: CompletionView[]): void {
    for (const fn of harness.portMessageListeners) {
      fn({ type: "mango-write/capture-list", captures: [], completions });
    }
  }

  function completionCard(harness: Harness): FakeEl {
    const cards = taskCards(harness);
    expect(cards).toHaveLength(1);
    return cards[0]!;
  }

  function cardButtons(card: FakeEl): string[] {
    return card.findAll((el) => el.tagName === "button").map((el) => el.textContent);
  }

  it("确认卡：紧凑题录摘要 + 「手动字段保留」提示，主动作是「更新题录」", async () => {
    const harness = await loadPopup();
    pushCompletions(harness, [
      makeCompletionView({
        capturedTitle: "迈向第三代人工智能",
        actionable: true,
        capturedSummary: {
          authors: "王小明、李明 等",
          year: "2024",
          venue: "中文信息学报",
          doi: "10.13530/j.cnki.jlis.2024011",
        },
      }),
    ]);

    const card = completionCard(harness);
    expect(card.find((el) => el.textContent === "已在原站识别到题录：《迈向第三代人工智能》")).not.toBeNull();
    const facts = card.find((el) => el.textContent?.includes("作者：王小明、李明 等"));
    expect(facts?.textContent).toBe(
      "作者：王小明、李明 等 ｜ 年份：2024 ｜ 来源：中文信息学报 ｜ DOI：10.13530/j.cnki.jlis.2024011",
    );
    expect(
      card.find((el) => el.textContent === "将用以上信息更新题录；你手动改过的字段会保留，原文、标注与引用不变。"),
    ).not.toBeNull();
    expect(cardButtons(card)).toEqual(["更新题录", "取消"]);
    expect(card.find((el) => el.textContent === "更新题录")?.className).toBe("btn-brand");
  });

  it("DOI 错配卡：两边 DOI 摆出来，主动作变成「仍要更新」", async () => {
    const harness = await loadPopup();
    pushCompletions(harness, [
      makeCompletionView({
        capturedTitle: "另一篇题名相近的文章",
        actionable: true,
        mismatch: true,
        mismatchReason: "doi",
        expectedDoi: "10.13530/j.cnki.jlis.2024011",
        capturedDoi: "10.9999/page-side",
      }),
    ]);

    const card = completionCard(harness);
    expect(card.find((el) => el.textContent === "页面与目标条目的 DOI 不一致：")).not.toBeNull();
    expect(card.find((el) => el.textContent === "页面：10.9999/page-side")).not.toBeNull();
    expect(card.find((el) => el.textContent === "目标：10.13530/j.cnki.jlis.2024011")).not.toBeNull();
    expect(cardButtons(card)).toEqual(["仍要更新", "取消"]);
  });

  it("身份无从核对卡：摆页面题录等用户拍板，不凭缺失题名静默放行", async () => {
    const harness = await loadPopup();
    pushCompletions(harness, [
      makeCompletionView({
        capturedTitle: "页面抓到的题名",
        actionable: true,
        mismatch: true,
        mismatchReason: "identity",
      }),
    ]);

    const card = completionCard(harness);
    expect(
      card.find((el) => el.textContent === "目标条目的题录不足以判断是否同一篇："),
    ).not.toBeNull();
    expect(card.find((el) => el.textContent === "页面题录：《页面抓到的题名》")).not.toBeNull();
    expect(cardButtons(card)).toEqual(["仍要更新", "取消"]);
  });

  it("done 卡：成功说明只出现一次，「在文库中查看」新开深链，可结束任务", async () => {
    const harness = await loadPopup();
    const message = "已更新到你的文库条目，并与《汉语名句理解研究（普通导入）》合并为一条。";
    pushCompletions(harness, [
      makeCompletionView({
        status: "done",
        message,
        absorbedTitles: ["汉语名句理解研究（普通导入）"],
        libraryUrl: "https://api.example.com/u/read/src-1",
      }),
    ]);

    const card = completionCard(harness);
    // 说明独立成行且只出现一次（不与别的文案叠着重复出现）。
    expect(card.findAll((el) => el.textContent === message)).toHaveLength(1);
    const buttons = cardButtons(card);
    expect(buttons).toEqual(["在文库中查看", "结束任务"]);

    const open = card.findAll((el) => el.tagName === "button" && el.textContent === "在文库中查看")[0]!;
    await (open.listeners["click"][0]! as () => Promise<void>)();
    expect(harness.tabsCreate).toHaveBeenCalledWith({ url: "https://api.example.com/u/read/src-1" });
  });

  it("applying 卡：更新进行中——不给取消也不给重复提交，只有 spinner 与状态", async () => {
    const harness = await loadPopup();
    pushCompletions(harness, [
      makeCompletionView({ status: "applying", capturedTitle: "页面题名", actionable: true }),
    ]);

    const card = completionCard(harness);
    expect(card.find((el) => el.className === "task-status" && el.textContent === "更新中")).not.toBeNull();
    // 提交边界：进行中没有「取消」也没有第二个「更新题录」。
    expect(cardButtons(card)).toEqual([]);
  });
  it("当前标签的更正任务隐藏普通导入入口，其他标签仍可正常导入", async () => {
    const harness = await loadPopup();
    pushCompletions(harness, [makeCompletionView({ tabIds: [1], capturedTitle: "页面题录", actionable: true })]);
    expect(harness.elements.get("cta-card")!.hidden).toBe(true);
    pushCompletions(harness, [makeCompletionView({ tabIds: [2], capturedTitle: "页面题录", actionable: true })]);
    expect(harness.elements.get("cta-card")!.hidden).toBe(false);
  });

});
