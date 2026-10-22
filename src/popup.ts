import type {
  CaptureListMessage,
  CaptureView,
  CompletionView,
  ExtensionSettings,
  TabDocumentInfo,
  TeamTarget,
} from "./protocol.js";
import type { MembershipInfo } from "./api.js";
import { failureCopy, relativeTime, siteLabel } from "./queue-util.js";
import { canonicalizeUrl, sanitizeOriginUrl } from "./canonical-url.js";
import { urlPathnameLooksLikePdf } from "./pdf-detect.js";
import { BUILD_ENV, BUILD_ID, IS_DEV, VERSION, debugError, debugLog, isContextInvalidatedError, logBuildBanner } from "./env.js";
import { classifyEnv } from "./env-label.js";
import { API_BASE_URL } from "./build-info.js";
import { fetchLatestVersion, isNewerVersion, openUpgradeGuide } from "./update-check.js";

logBuildBanner("popup");

// FAB panel height sync
// When popup.html is embedded as an iframe inside the on-page FAB panel, we
// can't use window.frameElement (null cross-origin) nor inline <script> (CSP).
// Instead, post the body's scrollHeight to the parent window so fab.ts can
// apply it to the iframe element from the outside.
(function initFabPanelHeightSync() {
  if (window.parent === window) return; // standalone toolbar popup — do nothing

  function syncHeight() {
    // +1px prevents the browser from adding a scrollbar at the exact boundary.
    const contentHeight = document.body.scrollHeight + 1;
    window.parent.postMessage(
      { type: "mango-write/fab-panel-height", height: contentHeight },
      "*",
    );
  }

  // Fire once the DOM is ready, then keep in sync via ResizeObserver.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", syncHeight);
  } else {
    syncHeight();
  }
  new ResizeObserver(syncHeight).observe(document.body);
})();

/**
 * 关闭自己：独立 toolbar 弹窗走 window.close()；嵌在页面 FAB 面板的 iframe
 * 里时 window.close() 是 no-op——改为叫宿主（fab.ts）收起面板。
 */
function closeSelf(): void {
  if (window.parent === window) {
    window.close();
    return;
  }
  window.parent.postMessage({ type: "mango-write/fab-panel-hide" }, "*");
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

const mainView = $("main-view");
const settingsView = $("settings-view");
const openSettingsBtn = $("open-settings");
const backSettingsBtn = $("back-settings");

const brandLogo = $<HTMLImageElement>("brand-logo");
const brandHome = $<HTMLButtonElement>("brand-home");
const stateBadge = $("state-badge");
const stateBadgeText = $("state-badge-text");

const membershipBar = $<HTMLButtonElement>("membership-bar");
const membershipName = $("membership-name");
const membershipUsage = $("membership-usage");

const updateBanner = $("update-banner");
const updateVersion = $("update-version");

const ctaCard = $("cta-card");
const ctaSource = $("cta-source");
const ctaTitle = $("cta-title");
const targetRow = $<HTMLButtonElement>("capture-target-row");
const targetNameNode = $("capture-target-name");
const targetMenu = $("target-menu");
const captureButton = $<HTMLButtonElement>("capture");
const connectCard = $("connect-card");

const queueSection = $("queue-section");
const queueSummary = $("queue-summary");
const queueClear = $("queue-clear");
const taskList = $("task-list");
const emptyHint = $("empty-hint");

const accountChip = $("account-chip");
const accountAvatar = $("account-avatar");
const accountEmail = $("account-email");

const settingsAvatar = $("settings-avatar");
const settingsName = $("settings-name");
const logoutButton = $<HTMLButtonElement>("logout");
const fabToggle = $<HTMLInputElement>("fab-toggle");
const buildInfoNode = $("build-info");
const envSwitch = $("env-switch");
const envBadge = $<HTMLButtonElement>("env-badge");
const envMenu = $("env-menu");
/** Paired environments from the last pairing-state read; drives the switcher menu. */
let envEnvironments: Array<{ origin: string; active: boolean; user: { email: string } | null }> = [];

let paired = false;
/** Membership slice of the last pairing-state read (null → no membership bar). */
let membership: MembershipInfo | null = null;
/** Active environment's API base from the last pairing-state read; /membership opens on its origin. */
let pairingApiBaseUrl: string | null = null;
/** 可写团队目标 + 网页端当前空间（选择器的默认项），来自最近一次 pairing state。 */
let teams: TeamTarget[] = [];
let webSpaceId: string | null = null;
/** 本次弹窗内选中的导入目标；null = 个人文库。默认跟随网页端当前空间。 */
let selectedTeamId: string | null = null;
let recognized = false;
/**
 * The active tab looks like Chrome's native PDF viewer (direct-PDF link) and
 * should import through the byte channel, not the webpage-snapshot channel.
 * Computed by computePdfTabLikely from layered signals — see its comment.
 */
let pdfTabLikely = false;
/**
 * Active tab is a local (file://) PDF. Chrome's viewer page runs no useful DOM,
 * so these import through the file-upload channel — a webpage snapshot of the
 * viewer shell files garbage with a percent-encoded URL as the title.
 */
let localFilePdfTab = false;
/** Content-Type 事实：background 的 webRequest 监听记录的当前标签页主文档形态。 */
let tabDocument: TabDocumentInfo | null = null;
/** ping 有应答、且应答的 content script 就挂在原生 PDF 查看器壳上。 */
let viewerShell = false;
/** ping 无应答（无 content script）。旧启发式信号之一，仅兜底用。 */
let scriptAbsent = false;
let activeTabId: number | null = null;
let currentOriginUrl = "";
let progressPort: chrome.runtime.Port | null = null;
let latestViews: CaptureView[] = [];
/** 补全/更正任务（与导入队列同端口下发，渲染进同一个任务列表）。 */
let latestCompletions: CompletionView[] = [];

// 有捕获在进行时关闭 popup（或 FAB 面板 iframe）给一句提示——
// 下载与上传在 service worker 里续跑，关闭不会中断。
window.addEventListener("beforeunload", (event) => {
  if (
    latestViews.some((view) => !view.done) ||
    latestCompletions.some((c) => c.status === "active" || c.status === "applying")
  ) {
    event.preventDefault();
    event.returnValue = "任务仍在进行，后台会继续运行，关闭不会中断。";
  }
});

void init();

async function init() {
  // 环境标要等 pairing state 回来才知道连的是谁，applyEnvInfo() 在那之后补渲染。
  applyEnvInfo(undefined);

  wireStaticHandlers();
  connectProgressPort();
  void checkUpdateOnOpen();

  await Promise.all([refreshPairingState(), loadSettings()]);
  await refreshCurrentPage();
  renderShell();
}

// Update check on popup open (site channel only — store builds update via store)
// The 12h background alarm is the backstop; the toolbar-icon click is the
// moment the user is actually looking at the extension, so check synchronously
// and surface the guide link right in the popup.

async function checkUpdateOnOpen() {
  const latest = await fetchLatestVersion();
  if (!latest || !isNewerVersion(latest, VERSION)) return;
  if (updateVersion) updateVersion.textContent = `v${latest}`;
  if (updateBanner) updateBanner.hidden = false;
}

function wireStaticHandlers() {
  // 点面板任意处收起下拉（popup 里没有全局遮罩层）。
  document.addEventListener("click", () => {
    setEnvMenuOpen(false);
    setTargetMenuOpen(false);
  });

  // logo → 当前连接环境的网页端首页（多环境跟随所选环境，普通用户即官网）。
  brandHome?.addEventListener("click", () => {
    const url = homePageUrl();
    if (!url) return;
    void chrome.tabs.create({ url });
    closeSelf();
  });

  envBadge?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (envBadge.disabled) return;
    setEnvMenuOpen(envMenu?.hidden !== false);
  });
  targetRow?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (targetRow.disabled) return;
    setTargetMenuOpen(targetMenu?.hidden !== false);
  });

  openSettingsBtn?.addEventListener("click", () => showView("settings"));
  backSettingsBtn?.addEventListener("click", () => showView("main"));
  accountChip?.addEventListener("click", () => showView("settings"));

  updateBanner?.addEventListener("click", () => {
    openUpgradeGuide();
    closeSelf();
  });
  // 横幅带 role="button" + tabindex，键盘用户也要点得到（Enter / Space）。
  updateBanner?.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key !== "Enter" && (event as KeyboardEvent).key !== " ") return;
    event.preventDefault();
    openUpgradeGuide();
    closeSelf();
  });

  membershipBar?.addEventListener("click", () => {
    const url = membershipPageUrl();
    if (!url) return;
    void chrome.tabs.create({ url });
    closeSelf();
  });

  captureButton?.addEventListener("click", onCapture);

  queueClear?.addEventListener("click", async () => {
    try {
      await chrome.runtime.sendMessage({ type: "mango-write/clear-finished-captures" });
    } catch (error) {
      if (!isContextInvalidatedError(error)) {
        debugError("popup", "clear-finished failed", error);
      }
    }
  });

  logoutButton?.addEventListener("click", async () => {
    logoutButton.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: "mango-write/logout" });
      await refreshPairingState();
      renderShell();
      showView("main");
    } finally {
      logoutButton.disabled = false;
    }
  });

  fabToggle?.addEventListener("change", async () => {
    const settings: Partial<ExtensionSettings> = { fabEnabled: fabToggle.checked };
    try {
      await chrome.runtime.sendMessage({ type: "mango-write/set-settings", settings });
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        debugLog("popup", "set-settings skipped (context invalidated)");
      } else {
        debugError("popup", "set-settings failed", error);
      }
    }
  });
}

function showView(view: "main" | "settings") {
  if (mainView) mainView.hidden = view !== "main";
  if (settingsView) settingsView.hidden = view !== "settings";
}

// Pairing / current page / settings

async function refreshPairingState(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: "mango-write/get-pairing-state" });
    paired = Boolean(response?.ok && response.result?.paired);
    const user = response?.result?.user as { email: string; name: string | null } | null;
    applyAccount(user);
    applyEnvInfo(response?.result as PairingStateView | undefined);
    applyMembership(response?.result as PairingStateView | undefined);
    applyImportTargets(response?.result as PairingStateView | undefined);
  } catch (error) {
    if (isContextInvalidatedError(error)) {
      debugLog("popup", "refreshPairingState skipped (context invalidated)");
    } else {
      debugError("popup", "refreshPairingState failed", error);
    }
    paired = false;
    applyAccount(null);
    applyEnvInfo(undefined);
    applyMembership(undefined);
    applyImportTargets(undefined);
  }
}

/**
 * 导入目标：选项 = 个人文库 + 可写团队。默认跟随网页端当前空间
 * （set-active-space 推来的 webSpaceId）；推来的团队不可写/不在列表
 * （比如 viewer）或从未推送时，回落个人文库。
 */
function applyImportTargets(state: PairingStateView | undefined): void {
  teams = Array.isArray(state?.teams) ? state!.teams! : [];
  webSpaceId = typeof state?.activeSpaceId === "string" ? state!.activeSpaceId! : null;
  selectedTeamId = webSpaceId && teams.some((t) => t.id === webSpaceId) ? webSpaceId : null;
  setTargetMenuOpen(false);
}

/** Slice of the background's PairingState the environment UI needs. */
interface PairingStateView {
  apiBaseUrl?: string;
  canSwitchEnv?: boolean;
  environments?: Array<{ origin: string; active: boolean; user: { email: string } | null }>;
  /** Rides the same self/status probe that validated the device token. */
  membership?: MembershipInfo | null;
  /** 同一探测带回的可写团队目标；缺省（旧版 background）视为无团队。 */
  teams?: TeamTarget[];
  /** 网页端推来的「当前所在空间」：个人 = null。 */
  activeSpaceId?: string | null;
}

/**
 * Environment badge + switcher + build footer, all keyed on the origin this
 * device is actually paired with. An ordinary account on production sees
 * nothing new: no badge, no switcher, unchanged top bar. Anything else is
 * called out so nobody mistakes a test/local pairing for the real thing.
 *
 * Accounts the server flagged with `extension.env.switch` also get the badge on
 * production — otherwise there'd be no entry point to switch *away* from it.
 *
 * No state (older background build, or the message failed) → fall back to the
 * build constant rather than staying silent, since "unknown target" is exactly
 * what the badge exists to surface.
 */
function applyEnvInfo(state: PairingStateView | undefined) {
  const target = state?.apiBaseUrl || API_BASE_URL;
  const env = classifyEnv(target);
  const canSwitch = state?.canSwitchEnv === true;
  envEnvironments = state?.environments ?? [];

  if (envBadge) {
    const visible = env.kind !== "production" || canSwitch;
    envBadge.hidden = !visible;
    // 整个切换入口（芯片 + 菜单锚点）跟着显隐——普通用户连正式环境不渲染。
    if (envSwitch) envSwitch.hidden = !visible;
    envBadge.className = `env-chip ${env.kind}`;
    const name = env.detail ? `${env.label || env.name} · ${env.detail}` : env.label || env.name;
    envBadge.title = canSwitch ? `已连接：${target}（点击切换环境）` : `已连接：${target}`;
    envBadge.setAttribute("aria-label", `环境：${name}`);
    envBadge.disabled = !canSwitch;
    envBadge.setAttribute("aria-haspopup", canSwitch ? "menu" : "false");
  }
  if (!canSwitch) setEnvMenuOpen(false);

  if (buildInfoNode) {
    buildInfoNode.textContent =
      `v${VERSION} · ${BUILD_ID} · ${BUILD_ENV}${IS_DEV ? " · dev" : ""}\n${target}`;
  }
}

function setEnvMenuOpen(open: boolean) {
  if (!envMenu) return;
  if (!open) {
    envMenu.hidden = true;
    return;
  }
  envMenu.textContent = "";
  for (const entry of envEnvironments) {
    const env = classifyEnv(entry.origin);
    const row = document.createElement("button");
    row.type = "button";
    row.setAttribute("aria-current", String(entry.active));
    const name = document.createElement("span");
    name.textContent = entry.active ? `${env.name} ✓` : env.name;
    const host = document.createElement("span");
    host.className = "env-menu-host";
    host.textContent = entry.user?.email ? `${entry.origin} · ${entry.user.email}` : entry.origin;
    row.append(name, host);
    row.addEventListener("click", () => void switchEnv(entry.origin));
    envMenu.append(row);
  }
  envMenu.hidden = envEnvironments.length === 0;
}

async function switchEnv(origin: string) {
  setEnvMenuOpen(false);
  try {
    await chrome.runtime.sendMessage({ type: "mango-write/switch-env", origin });
  } catch (error) {
    if (!isContextInvalidatedError(error)) debugError("popup", "switch-env failed", error);
    return;
  }
  await refreshPairingState();
  await refreshCurrentPage();
  renderShell();
}

type PairedUserView = { email: string; name: string | null; image?: string | null };

/**
 * 首页 = 当前连接环境的网页端 origin：active 配对槽位的 origin 就是配对它的
 * 网页端；老配对没有 environments 时退回 apiBaseUrl（正式环境两者同域）；
 * 未配对退回构建常量（正式官网）。
 */
function homePageUrl(): string | null {
  const base =
    envEnvironments.find((entry) => entry.active)?.origin ||
    pairingApiBaseUrl ||
    API_BASE_URL;
  try {
    return new URL(base).origin;
  } catch (error) {
    debugError("popup", "invalid base for home page", base, error);
    return null;
  }
}

/** 当前选中的目标团队名；null = 个人文库。 */
function selectedTeamName(): string | null {
  return teams.find((t) => t.id === selectedTeamId)?.name ?? null;
}

/**
 * 导入目标行：「导入此页」上方常驻显示当前目标（导入到 个人文库 / 团队名），
 * 不点开也看得到会进哪个空间。有可写团队时该行可点展开菜单切换；没有团队
 * 时只读展示，无箭头不可点。
 */
function renderTargetSelector(): void {
  const hasTeams = teams.length > 0;
  if (targetRow) {
    targetRow.disabled = !hasTeams;
    const name = selectedTeamName() ?? "个人文库";
    targetRow.title = hasTeams ? "点击更换导入目标" : "当前账号没有可导入的团队";
    targetRow.setAttribute("aria-label", `导入到${name}`);
  }
  if (targetNameNode) targetNameNode.textContent = selectedTeamName() ?? "个人文库";
  if (targetMenu && !targetMenu.hidden && !hasTeams) setTargetMenuOpen(false);
}

function setTargetMenuOpen(open: boolean): void {
  if (!targetMenu) return;
  if (!open) {
    targetMenu.hidden = true;
    return;
  }
  targetMenu.textContent = "";
  for (const option of [{ id: null as string | null, name: "个人文库" }, ...teams]) {
    const row = document.createElement("button");
    row.type = "button";
    row.setAttribute("aria-current", String(option.id === selectedTeamId));
    const check = document.createElement("span");
    check.className = "target-check";
    check.innerHTML = svg('<path d="M20 6L9 17l-5-5"/>', "currentColor");
    row.append(check, document.createTextNode(option.name));
    row.addEventListener("click", () => {
      selectedTeamId = option.id;
      setTargetMenuOpen(false);
      renderTargetSelector();
    });
    targetMenu.append(row);
  }
  targetMenu.hidden = false;
}

/** Cache the membership + API base from the latest pairing state (rendered by renderShell). */
function applyMembership(state: PairingStateView | undefined): void {
  membership = state?.membership ?? null;
  pairingApiBaseUrl = typeof state?.apiBaseUrl === "string" ? state.apiBaseUrl : null;
}

/**
 * Membership bar: badge + plan name + weekly parse usage, opening the web
 * app's benefits page. Rendered only when paired AND the server reported a
 * membership — unpaired / free accounts see nothing (no placeholder row).
 */
function renderMembership(): void {
  if (!membershipBar) return;
  const info = paired ? membership : null;
  if (!info) {
    membershipBar.hidden = true;
    return;
  }
  const name = info.plan?.name || info.tier;
  const usage = `本周解析 ${info.parseWeek.used}/${info.parseWeek.limit}`;
  if (membershipName) renderTierName(membershipName, name);
  if (membershipUsage) membershipUsage.textContent = usage;
  membershipBar.hidden = false;
  membershipBar.title = "会员";
  membershipBar.setAttribute("aria-label", `会员：${name}，${usage}`);
}

/**
 * Tier label under the crown: one word per line (a single word never wraps,
 * two words stack on two lines) — same rule as the web top-bar membership chip.
 */
function renderTierName(el: HTMLElement, name: string): void {
  el.replaceChildren();
  for (const word of name.split(" ").filter((w) => w.length > 0)) {
    const line = document.createElement("span");
    line.className = "tier-name-line";
    line.textContent = word;
    el.appendChild(line);
  }
}

/** Benefits page on the active environment's web origin (never the API path itself). */
function membershipPageUrl(): string | null {
  const base = pairingApiBaseUrl || API_BASE_URL;
  try {
    return `${new URL(base).origin}/u/membership`;
  } catch (error) {
    debugError("popup", "invalid apiBaseUrl for membership page", base, error);
    return null;
  }
}

function applyAccount(user: PairedUserView | null) {
  const label = user?.name || user?.email || "";
  const initial = label ? label.trim().charAt(0).toUpperCase() : "·";
  if (accountEmail) accountEmail.textContent = label;
  if (settingsName) settingsName.textContent = label;
  applyAvatar(accountAvatar, user?.image, initial);
  applyAvatar(settingsAvatar, user?.image, initial);
}

/**
 * Avatar = the web app's profile image when one was pushed at pair time,
 * else the name initial. The image is probed with Image() first so a dead
 * URL (revoked upload, offline) falls back to the initial instead of an
 * empty circle.
 */
function applyAvatar(node: HTMLElement | null, image: string | null | undefined, initial: string): void {
  if (!node) return;
  node.textContent = initial;
  node.classList.remove("has-image");
  node.style.backgroundImage = "";
  if (!image) return;
  const probe = new Image();
  probe.onload = () => {
    node.classList.add("has-image");
    node.textContent = "";
    node.style.backgroundImage = `url("${image}")`;
  };
  probe.src = image;
}

async function loadSettings(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: "mango-write/get-settings" });
    const settings = response?.result as ExtensionSettings | undefined;
    if (fabToggle && settings) fabToggle.checked = settings.fabEnabled;
  } catch (error) {
    if (isContextInvalidatedError(error)) {
      debugLog("popup", "loadSettings skipped (context invalidated)");
    } else {
      debugError("popup", "loadSettings failed", error);
    }
  }
}

async function refreshCurrentPage(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab?.id ?? null;
    currentOriginUrl = sanitizeOriginUrl(tab?.url || "");
    localFilePdfTab = isLocalFilePdfUrl(tab?.url);
    if (ctaSource) ctaSource.textContent = tab?.url ? `当前页面 · ${siteLabel(tab.url)}` : "当前页面";
    if (ctaTitle) ctaTitle.textContent = tab?.title?.trim() || "当前页面";

    if (activeTabId != null) {
      const response = await chrome.runtime.sendMessage({
        type: "mango-write/get-recognized-state",
        tabId: activeTabId,
      });
      recognized = Boolean(response?.ok && response.result?.recognized);
      const reportedOriginUrl = response?.result?.originUrl;
      if (typeof reportedOriginUrl === "string" && reportedOriginUrl.trim()) {
        currentOriginUrl = reportedOriginUrl.trim();
      }
      // 权威信号（Content-Type 事实）与兜底信号（ping 探针）并行取。
      const [docInfo, probe] = await Promise.all([
        fetchTabDocument(activeTabId),
        probeContentScript(activeTabId, tab?.url),
      ]);
      tabDocument = docInfo;
      // 扩展更新后旧标签页的 content script 已失效：ping 无应答在正常网页和
      // 直达 PDF 上都会发生，不能当 PDF 信号用。缺 Content-Type 记录时让
      // background 探一段头字节拿事实（v0.1.12 前 GSU 等正常网页因此被报成
      // 「PDF 页面」）。
      if (probe.absent && (!docInfo || docInfo.kind === "unknown") && /^https?:/i.test(tab?.url ?? "")) {
        const probed = await probeUrlDocument(tab!.url!);
        if (probed) tabDocument = probed;
      }
      scriptAbsent = probe.absent;
      viewerShell = probe.viewerShell;
      pdfTabLikely = computePdfTabLikely(tab?.url);
    } else {
      recognized = false;
      pdfTabLikely = false;
    }
  } catch (error) {
    if (isContextInvalidatedError(error)) {
      debugLog("popup", "refreshCurrentPage skipped (context invalidated)");
    } else {
      debugError("popup", "refreshCurrentPage failed", error);
    }
    recognized = false;
    pdfTabLikely = false;
    localFilePdfTab = false;
    tabDocument = null;
    scriptAbsent = false;
    viewerShell = false;
  }
  applyRecognized();
}

/** Ask the background what the tab's main-frame response actually was. */
async function fetchTabDocument(tabId: number): Promise<TabDocumentInfo | null> {
  try {
    const response = await chrome.runtime.sendMessage({ type: "mango-write/get-tab-document", tabId });
    const info = response?.result as TabDocumentInfo | undefined;
    // Only meaningful records are kept; "unknown" is treated as no record so
    // the routing falls back to the URL/DOM heuristics.
    return info?.kind === "pdf" || info?.kind === "html" ? info : null;
  } catch (error) {
    if (isContextInvalidatedError(error)) {
      debugLog("popup", "fetchTabDocument skipped (context invalidated)");
    } else {
      debugError("popup", "fetchTabDocument failed", error);
    }
    return null;
  }
}

/**
 * Same question as fetchTabDocument, answered by fetching a slice of the URL
 * instead of consulting the webRequest record — the path for tabs that predate
 * the current extension load.
 */
async function probeUrlDocument(url: string): Promise<TabDocumentInfo | null> {
  try {
    const response = await chrome.runtime.sendMessage({ type: "mango-write/probe-url", url });
    const info = response?.result as { kind?: TabDocumentInfo["kind"] } | undefined;
    return info?.kind === "pdf" || info?.kind === "html" ? { kind: info.kind, contentType: null, url } : null;
  } catch (error) {
    debugError("popup", "probeUrlDocument failed", error);
    return null;
  }
}

/**
 * 直达 PDF 标签页的路由判据，按信号可靠性分层：
 * 1. 权威——background 经 webRequest 观察到的主框架响应 Content-Type
 *    （`pdf` = 原生查看器，`html` = 网页）。这正是 Chrome 自己用来决定
 *    渲染查看器的事实，不依赖查看器内部实现，也不依赖 content script
 *    在不在场（当前 Chrome 会往查看器页注入 content script 并应答 ping，
 *    旧的「无应答 = PDF」已失效——线上 darwin-online 与 file:// 两批
 *    坏数据都是它误路由进网页快照通道的）。
 * 2. file:// 特例——不走网络、无 webRequest 事件，维持 URL 判定。
 * 3. 兜底——Content-Type 事实缺失（标签早于监听器存在、扩展刚更新）
 *    时退化到旧启发式：.pdf 路径 / 查看器壳 DOM / 脚本缺席。误判由
 *    background 下载后的 %PDF- 字节校验兜底成明确报错。
 */
function computePdfTabLikely(url: string | null | undefined): boolean {
  if (isLocalFilePdfUrl(url)) return true;
  const kind = tabDocument?.kind;
  if (kind === "pdf") return true;
  if (kind === "html") return false;
  return urlPathnameLooksLikePdf(url) || viewerShell || scriptAbsent;
}

/**
 * A file:// URL pointing at a PDF — the "user opened a local PDF in Chrome"
 * case. Routing decision, not a capture capability: reading the bytes happens
 * in the background service worker (which needs the user's "Allow access to
 * file URLs" toggle; the failure path explains that).
 */
function isLocalFilePdfUrl(url: string | null | undefined): boolean {
  if (!url || !/^file:/i.test(url)) return false;
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return /\.pdf(\?|$)/i.test(url);
  }
}

/**
 * Probe the active tab's content script. On current Chrome the native PDF
 * viewer page DOES host an injected content script that answers pings — so an
 * answer alone doesn't mean "webpage"; the answer carries a conservative
 * viewer-shell report (see content.ts isPdfViewerShell). "absent" is kept as
 * a last-resort fallback signal only.
 */
async function probeContentScript(
  tabId: number,
  url: string | null | undefined,
): Promise<{ absent: boolean; viewerShell: boolean }> {
  if (!/^https?:/i.test(url ?? "")) return { absent: false, viewerShell: false };
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "mango-write/ping" });
    if (!pong?.ok) return { absent: true, viewerShell: false };
    return { absent: false, viewerShell: Boolean(pong.viewerShell) };
  } catch {
    return { absent: true, viewerShell: false }; // "Receiving end does not exist" — no content script on the tab
  }
}

function applyRecognized() {
  brandLogo?.classList.toggle("recognized", recognized);
  stateBadge?.classList.toggle("recognized", recognized);
  if (stateBadgeText) {
    stateBadgeText.textContent = recognized
      ? "已识别文献"
      : localFilePdfTab
        ? "本地 PDF 文件，将按文件导入"
        : pdfTabLikely
          ? "PDF 页面，可直接导入"
          : "未识别到论文，将按网页导入";
  }
  if (ctaTitle) ctaTitle.classList.toggle("muted", !recognized);
}

/** Show/hide the top-level regions based on pairing + queue contents. */
function renderShell() {
  if (ctaCard) ctaCard.hidden = !paired;
  if (connectCard) connectCard.hidden = paired;
  if (accountChip) accountChip.hidden = !paired;
  renderMembership();
  renderTargetSelector();
  applyCaptureButtonState();
  renderTasks();
}

/** Disable/hide the import button while the current page is already importing. */
function applyCaptureButtonState() {
  if (!captureButton) return;
  const updatingCurrentPage = activeTabId !== null && latestCompletions.some((task) => task.tabIds?.includes(activeTabId!));
  if (ctaCard) ctaCard.hidden = !paired || updatingCurrentPage;
  const active = isCurrentPageImporting();
  captureButton.disabled = active;
  captureButton.textContent = active ? "已加入导入队列" : "导入此页";
}

function isCurrentPageImporting(): boolean {
  if (!currentOriginUrl) return false;
  const currentKey = canonicalizeUrl(currentOriginUrl);
  return latestViews.some(
    (view) =>
      canonicalizeUrl(view.originUrl) === currentKey &&
      (view.state === "acquiring" ||
        view.state === "queued" ||
        view.state === "uploading" ||
        // 待用户确认的网页导入也算「已入队」：按钮保持已加入状态，
        // 提示用户去下面的队列卡片做确认，而不是再点一次。
        view.state === "confirm"),
  );
}

// Import current page

async function onCapture() {
  if (!captureButton) return;
  captureButton.disabled = true;
  captureButton.textContent = "正在加入队列…";

  try {
    // 直达 PDF 标签页（Chrome 原生查看器——本地文件或以 application/pdf
    // 返回的直链）走字节通道，绝不快照查看器页；本地 file:// PDF 同路。
    // 当前 Chrome 会往查看器页注入 content script，没有这个分流就会把
    // 查看器壳当网页快照存进去（darwin-online / file:// 两批线上事故）。
    if (pdfTabLikely && !recognized) {
      await importActiveTabAsPdf();
      return;
    }

    // 内置页面（chrome://、商店等）没有 content script 也不可导入：就地
    // 提示，不制造一条注定失败的队列记录。
    if (!/^(https?:|file:)/i.test(currentOriginUrl)) {
      setStateNote("当前页面未接入插件。请刷新页面后再试；插件商店、新建标签页等内置页面不支持导入。");
      return;
    }

    // 点击即入队：队列卡片经进度端口立刻出现，「读取页面」由 service worker
    // 编排、结果直接回后台。此后关闭弹窗（或页面里的 FAB 面板）、切走标签页
    // 都不再影响任务；只有读取完成前导航走同一标签页才会中断，中断会以
    // 失败卡片 + 系统通知的形式显式呈现，不再无声丢失。
    const result = await chrome.runtime.sendMessage({
      type: "mango-write/begin-capture",
      tabId: activeTabId,
      teamId: selectedTeamId,
      teamName: selectedTeamName(),
    });
    debugLog("popup", "begin-capture response", result);
    if (!result?.ok) throw new Error(result?.error || "capture_failed");
    if (result.result?.message) {
      // dedup 等说明性消息（该文献已在导入队列中）。
      setStateNote(result.result.message);
    }
  } catch (error) {
    debugError("popup", "capture failed", error);
    setStateNote(actionFailureText(error));
  } finally {
    resetCaptureButton();
  }
}

/** background 回包里的机器码兜底成白话；人写的消息原样透传。 */
function actionFailureText(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (!message || /^(capture_failed|unknown_error)$/.test(message)) {
    return "导入没有成功，请再试一次。";
  }
  return message;
}

function resetCaptureButton() {
  if (!captureButton) return;
  // Reset to default, then re-apply queue-based state so an in-flight import
  // doesn't briefly show the button as clickable again.
  captureButton.disabled = false;
  captureButton.textContent = "导入此页";
  applyCaptureButtonState();
}

function setStateNote(message: string) {
  if (stateBadgeText) stateBadgeText.textContent = message;
  stateBadge?.classList.remove("recognized");
}

/**
 * The active tab has no content script — for an http(s) tab that means Chrome's
 * native PDF viewer (a direct-PDF link). Hand the URL to the background, which
 * downloads + verifies the bytes. file:// PDFs route here too (see
 * localFilePdfTab): same byte-verify-then-upload path, metadata resolved by the
 * server from the PDF itself. chrome://, the Web Store, etc. can't be fetched,
 * so we tell the user rather than trying.
 */
async function importActiveTabAsPdf(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? "";
  const localFile = isLocalFilePdfUrl(url);
  if (!/^https?:/i.test(url) && !localFile) {
    setStateNote("当前页面未接入插件。请刷新页面后再试；插件商店、新建标签页等内置页面不支持导入。");
    return;
  }

  captureButton!.textContent = localFile ? "正在读取本地文件…" : "正在下载 PDF…";
  const result = await chrome.runtime.sendMessage({
    type: "mango-write/import-pdf-url",
    url,
    title: tab?.title ?? null,
    tabId: tab?.id ?? null,
    teamId: selectedTeamId,
    teamName: selectedTeamName(),
  });
  debugLog("popup", "import-pdf-url response", result);

  if (!result?.ok) throw new Error(result?.error || "capture_failed");
  if (result.result?.message) setStateNote(result.result.message);
}


// Live queue rendering

function connectProgressPort() {
  try {
    progressPort = chrome.runtime.connect({ name: "mango-write/capture-progress" });
    progressPort.onMessage.addListener((message: CaptureListMessage) => {
      if (message.type === "mango-write/capture-list") {
        latestViews = message.captures;
        latestCompletions = message.completions ?? [];
        renderTasks();
      }
    });
    progressPort.onDisconnect.addListener(() => {
      progressPort = null;
      setTimeout(connectProgressPort, 1000);
    });
  } catch (error) {
    if (isContextInvalidatedError(error)) {
      debugLog("popup", "connectProgressPort skipped (context invalidated)");
    } else {
      debugError("popup", "connectProgressPort failed", error);
    }
  }
}

function renderTasks() {
  applyCaptureButtonState();
  if (!taskList || !queueSection) return;
  const views = [...latestViews].sort((a, b) => b.createdAt - a.createdAt);
  const completions = [...latestCompletions].sort((a, b) => b.createdAt - a.createdAt);

  if (views.length === 0 && completions.length === 0) {
    queueSection.hidden = true;
    if (emptyHint) emptyHint.hidden = !paired;
    return;
  }
  if (emptyHint) emptyHint.hidden = true;
  queueSection.hidden = false;

  if (queueSummary) queueSummary.textContent = summarize(views, completions);
  // 一键清空只在有已结束导入记录时出现；补全任务有自己的取消，不归清空管。
  if (queueClear) queueClear.hidden = !views.some((v) => v.done && v.state !== "conflict");

  // 撤销已消失任务的卡片缓存，防泄漏。
  const liveIds = new Set(views.map((v) => v.captureId));
  for (const id of cardCache.keys()) {
    if (!liveIds.has(id)) cardCache.delete(id);
  }
  const liveCompletionIds = new Set(completions.map((c) => c.sourceId));
  for (const id of completionCardCache.keys()) {
    if (!liveCompletionIds.has(id)) completionCardCache.delete(id);
  }

  // 等用户裁决的行（导入失败/冲突/待确认 + 补全待确认/错配/失败）置顶成
  // 「需要处理」——漏看一行任务就挂起；完成与进行中的是回执，沉到「最近记录」。
  const captureActionable = views.filter((v) => v.state === "failed" || v.state === "conflict" || v.state === "confirm");
  const captureRecent = views.filter((v) => !(v.state === "failed" || v.state === "conflict" || v.state === "confirm"));
  const completionActionable = completions.filter((c) => c.actionable || c.status === "failed");
  const completionRecent = completions.filter((c) => !(c.actionable || c.status === "failed"));

  const sections: HTMLElement[] = [];
  const actionable = [
    ...completionActionable.map(renderCompletionCard),
    ...captureActionable.map(renderTaskCard),
  ];
  if (actionable.length) sections.push(renderTaskGroup("需要处理", actionable));
  const recent = [
    ...completionRecent.map(renderCompletionCard),
    ...captureRecent.map(renderTaskCard),
  ];
  if (recent.length) sections.push(renderTaskGroup("最近记录", recent));
  taskList.replaceChildren(...sections);
}

function renderTaskGroup(label: string, cards: HTMLElement[]): HTMLElement {
  const group = el("div", "task-group");
  group.append(el("div", "queue-sub", label));
  group.append(...cards);
  return group;
}

/**
 * 卡片按内容签名复用：每次广播只重建内容变化的卡，其余原节点原样挂回——
 * 下载进度高频广播下不整列表重建，也保住未变化卡片上正在进行的点击。
 */
const cardCache = new Map<string, { el: HTMLElement; sig: string }>();

function renderTaskCard(view: CaptureView): HTMLElement {
  const sig = cardSignature(view);
  const cached = cardCache.get(view.captureId);
  if (cached && cached.sig === sig) return cached.el;
  const node = renderTask(view);
  cardCache.set(view.captureId, { el: node, sig });
  return node;
}

// ── 补全/更正任务卡（#100 D1）──

const completionCardCache = new Map<string, { el: HTMLElement; sig: string }>();

function renderCompletionCard(view: CompletionView): HTMLElement {
  const sig = completionCardSignature(view);
  const cached = completionCardCache.get(view.sourceId);
  if (cached && cached.sig === sig) return cached.el;
  const node = buildCompletionCard(view);
  completionCardCache.set(view.sourceId, { el: node, sig });
  return node;
}

function completionCardSignature(view: CompletionView): string {
  return JSON.stringify([
    view.status,
    view.mismatch,
    view.mismatchReason ?? "",
    view.actionable,
    view.capturedTitle,
    view.targetTitle,
    view.message,
    view.absorbedSourceIds?.join(",") ?? "",
    view.absorbedTitles?.join(",") ?? "",
    view.libraryUrl ?? "",
    view.expectedDoi ?? "",
    view.capturedDoi ?? "",
    view.capturedSummary
      ? [view.capturedSummary.authors, view.capturedSummary.year, view.capturedSummary.venue, view.capturedSummary.doi].join("|")
      : "",
  ]);
}

function completionCardStatus(view: CompletionView): { label: string; cls: string } {
  if (view.status === "done") return { label: "已更新", cls: "ok" };
  if (view.status === "failed") return { label: "未完成", cls: "warn" };
  if (view.status === "applying") return { label: "更新中", cls: "" };
  if (view.mismatch) return { label: "请核对", cls: "warn" };
  if (view.actionable) return { label: "待确认", cls: "warn" };
  return { label: "进行中", cls: "" };
}

function buildCompletionCard(view: CompletionView): HTMLElement {
  const target = view.targetTitle?.trim() || "目标文献";
  const card = el("div", `task completion completion-${view.status}${view.mismatch ? " mismatch" : ""}`);

  const row = el("div", "task-row");
  row.append(completionIcon(view));
  const title = el("div", "task-title", `更新《${target}》的题录`);
  title.title = target;
  row.append(title);
  const status = completionCardStatus(view);
  row.append(el("span", `task-status${status.cls ? ` ${status.cls}` : ""}`, status.label));
  card.append(row);

  if (view.mismatch && view.capturedTitle) {
    // 明显错配：两边可核对的值都摆出来，让用户自己判断——不凭原错误标题
    // 永久挡更正，也不静默接受错配污染共享题录。归因不同摆不同的行。
    card.append(completionMismatchDetail(view, target));
  } else if (view.capturedTitle && view.actionable) {
    card.append(el("div", "task-detail", `已在原站识别到题录：《${view.capturedTitle}》`));
    const summary = view.capturedSummary;
    if (summary) {
      const facts: string[] = [];
      if (summary.authors) facts.push(`作者：${summary.authors}`);
      if (summary.year) facts.push(`年份：${summary.year}`);
      if (summary.venue) facts.push(`来源：${summary.venue}`);
      if (summary.doi) facts.push(`DOI：${summary.doi}`);
      if (facts.length > 0) {
        card.append(el("div", "task-detail", facts.join(" ｜ ")));
      }
      card.append(
        el(
          "div",
          "task-detail completion-confirm-hint",
          "将用以上信息更新题录；你手动改过的字段会保留，原文、标注与引用不变。",
        ),
      );
    }
  }
  // 说明/错误独立成行：transient 失败、取消说明、超时说明不再被上面的
  // capturedTitle 分支吞掉（任务还挂着待确认捕获时也要看得见）。
  if (view.message) {
    card.append(el("div", view.status === "failed" ? "task-error" : "task-detail", view.message));
  }

  card.append(completionActions(view));
  return card;
}

/** 错配明细按归因摆行：DOI 冲突摆 DOI、身份缺失摆页面题录、题名不像摆两边题名。 */
function completionMismatchDetail(view: CompletionView, target: string): HTMLElement {
  const diff = el("div", "task-detail");
  if (view.mismatchReason === "identity") {
    diff.append(el("div", "completion-diff-label", "目标条目的题录不足以判断是否同一篇："));
    diff.append(el("div", "completion-diff-line", `页面题录：《${view.capturedTitle}》`));
  } else if (view.mismatchReason === "doi" && view.expectedDoi && view.capturedDoi) {
    diff.append(el("div", "completion-diff-label", "页面与目标条目的 DOI 不一致："));
    diff.append(el("div", "completion-diff-line", `页面：${view.capturedDoi}`));
    diff.append(el("div", "completion-diff-line", `目标：${view.expectedDoi}`));
  } else {
    diff.append(el("div", "completion-diff-label", "页面题名与目标不一致："));
    diff.append(el("div", "completion-diff-line", `页面：${view.capturedTitle}`));
    diff.append(el("div", "completion-diff-line", `目标：${target}`));
  }
  return diff;
}

function completionIcon(view: CompletionView): HTMLElement {
  const wrap = el("span", "task-icon");
  if (view.status === "applying") {
    wrap.append(el("span", "spinner"));
  } else if (view.status === "done") {
    wrap.innerHTML = svg('<path d="M20 6L9 17l-5-5"/>', "var(--color-success-500)");
  } else if (view.status === "failed") {
    wrap.innerHTML = svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>', "var(--color-danger-500)");
  } else {
    wrap.innerHTML = svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>', "var(--color-warning-500, #f59e0b)");
  }
  return wrap;
}

function completionActions(view: CompletionView): HTMLElement {
  const wrap = el("div", "task-actions");
  if (view.actionable && view.status !== "applying") {
    const apply = el("button", view.mismatch ? "btn-danger" : "btn-brand", view.mismatch ? "仍要更新" : "更新题录");
    apply.addEventListener("click", () =>
      void sendCompletionAction("mango-write/apply-completion", view.sourceId, view.mismatch),
    );
    wrap.append(apply);
  }
  // 提交边界：更新进行中不給取消——请求已发出、服务端可能已完成写入，
  // 取消了反而对不上真实状态。等结果出来再结束任务。
  if (view.status === "active") {
    const cancel = el("button", "btn-ghost", "取消");
    cancel.addEventListener("click", () =>
      void sendCompletionAction("mango-write/cancel-completion", view.sourceId),
    );
    wrap.append(cancel);
  }
  if (view.status === "done") {
    if (view.libraryUrl) {
      const view_ = el("button", "btn-ghost", "在文库中查看");
      view_.addEventListener("click", () => {
        void chrome.tabs.create({ url: view.libraryUrl! });
      });
      wrap.append(view_);
    }
    const dismiss = el("button", "btn-ghost", "结束任务");
    dismiss.addEventListener("click", () =>
      void sendCompletionAction("mango-write/cancel-completion", view.sourceId),
    );
    wrap.append(dismiss);
  }
  // 失败卡是回执：看一眼原因，然后移除——没有重试入口（授权已失效，
  // 唯一出路是回文库重新发起）。
  if (view.status === "failed") {
    const dismiss = el("button", "btn-ghost", "移除");
    dismiss.addEventListener("click", () =>
      void sendCompletionAction("mango-write/cancel-completion", view.sourceId),
    );
    wrap.append(dismiss);
  }
  return wrap;
}

async function sendCompletionAction(type: string, sourceId: string, allowMismatch = false): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type, sourceId, allowMismatch });
  } catch (error) {
    if (isContextInvalidatedError(error)) {
      debugLog("popup", "sendCompletionAction skipped (context invalidated)", type);
    } else {
      debugError("popup", "sendCompletionAction failed", type, error);
    }
  }
}

/** 卡片渲染用到的全部字段（相对时间也入签名：桶跳变时刷新）。 */
function cardSignature(view: CaptureView): string {
  return JSON.stringify([
    view.state,
    view.step,
    Math.round(view.progress),
    view.detail,
    view.failure?.kind,
    view.failure?.raw,
    view.message,
    view.title,
    view.sourceSite,
    view.teamName,
    view.actions.join(","),
    view.alreadyInLibrary,
    view.resultKind,
    view.libraryUrl,
    view.done ? relativeTime(view.completedAt ?? view.createdAt) : "",
  ]);
}

function summarize(views: CaptureView[], completions: CompletionView[] = []): string {
  let running = 0;
  let queued = 0;
  let confirm = 0;
  let done = 0;
  let metadataOnly = 0;
  let failed = 0;
  for (const v of views) {
    if (v.state === "acquiring" || v.state === "uploading") running++;
    else if (v.state === "queued") queued++;
    else if (v.state === "confirm") confirm++;
    else if (v.state === "completed") {
      if (v.resultKind === "metadata-only") metadataOnly++;
      else done++;
    } else if (v.state === "failed") failed++;
  }
  const parts: string[] = [];
  if (running) parts.push(`${running} 进行中`);
  if (queued) parts.push(`${queued} 排队`);
  if (confirm) parts.push(`${confirm} 待确认`);
  if (failed) parts.push(`${failed} 失败`);
  if (metadataOnly) parts.push(`${metadataOnly} 仅题录`);
  if (done) parts.push(`${done} 完成`);
  // 补全/更正任务与导入队列共用列表，计数并进来，用户一眼看全。
  const awaiting = completions.filter((c) => c.actionable && c.status !== "applying").length;
  const updating = completions.filter((c) => c.status === "applying").length;
  if (awaiting) parts.push(`${awaiting} 待确认更新`);
  if (updating) parts.push(`${updating} 更新中`);
  return parts.join(" · ");
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function renderTask(view: CaptureView): HTMLElement {
  const warn = view.state === "completed" && view.resultKind === "metadata-only";
  const card = el("div", `task ${view.state}${warn ? " warn" : ""}`);

  const row = el("div", "task-row");
  row.append(stateIcon(view));

  const title = el("div", "task-title", view.title || view.originUrl);
  title.title = view.title || view.originUrl;
  row.append(title);

  if (view.state === "acquiring" || view.state === "uploading") {
    row.append(el("span", "task-pct", `${Math.round(view.progress)}%`));
  } else if (view.state === "queued") {
    row.append(el("span", "task-status", "排队中"));
    row.append(closeButton(view.captureId, "cancel"));
  } else if (view.state === "confirm") {
    row.append(el("span", "task-status warn", "待确认"));
  } else if (view.state === "completed") {
    // 仅题录不算导入成功：警示色标签 + 警告图标，并展示原因与下一步。
    if (warn) {
      row.append(el("span", "task-status warn", "仅题录"));
    } else {
      row.append(el("span", "task-status ok", view.alreadyInLibrary ? "已在库中" : "已完成"));
    }
    // 已完成记录满 1 天由后台自动过期，这里的关闭是让用户立刻移除单条。
    row.append(closeButton(view.captureId, "dismiss"));
  } else if (view.state === "conflict") {
    row.append(el("span", "task-status warn", "已存在"));
  } else if (view.state === "failed") {
    row.append(closeButton(view.captureId, "dismiss"));
  }
  card.append(row);

  // 终态卡补一行锚点信息：从哪来、什么时候结束——进行中的卡不需要，
  // 进度详情行已经带了来源站点。
  if (view.done) {
    const site = view.sourceSite || siteLabel(view.originUrl);
    const meta = [site, relativeTime(view.completedAt ?? view.createdAt)].filter(Boolean).join(" · ");
    if (meta) card.append(el("div", "task-meta", meta));
  }

  if (view.state === "acquiring" || view.state === "uploading") {
    const bar = el("div", "progress-bar");
    const fill = el("div");
    fill.style.width = `${Math.round(view.progress)}%`;
    bar.append(fill);
    card.append(bar);
    const detail = `${view.sourceSite ? view.sourceSite + " · " : ""}${view.detail || stateLabel(view.state)}${view.teamName ? ` · ${view.teamName}` : ""}`;
    card.append(el("div", "task-detail", detail));
  } else if (view.teamName) {
    // 已结束的任务也在卡片上标出去向，和进行中的一样可追溯。
    card.append(el("div", "task-detail", `导入到 ${view.teamName}`));
  }

  if (
    view.state === "completed" &&
    view.message &&
    (view.alreadyInLibrary || view.resultKind === "metadata-only")
  ) {
    const warning = view.resultKind === "metadata-only";
    card.append(el("div", warning ? "task-warning" : "task-detail", view.message));
  }

  // 完成的下一个动作：去文库看这条（仅题录的「取原文/上传」也在文库页）。
  if (view.state === "completed" && view.libraryUrl) {
    const open = el("button", "task-open", "在文库中查看 →");
    open.addEventListener("click", () => {
      void chrome.tabs.create({ url: view.libraryUrl! });
      closeSelf();
    });
    card.append(open);
  }

  if (view.state === "failed") {
    // 两行式：发生了什么（红）+ 怎么办（按钮帮不上时才给 hint）。
    // 原始技术串只挂 tooltip，供排查，不进正文。
    const copy = view.failure ? failureCopy(view.failure.kind, view.failure.raw) : null;
    const reason = el("div", "task-error", copy?.reason ?? "导入没有成功");
    const raw = view.failure?.raw;
    if (raw) reason.title = raw;
    card.append(reason);
    if (copy?.hint) card.append(el("div", "task-hint", copy.hint));
    card.append(failedActions(view));
  }

  if (view.state === "conflict") {
    card.append(el("div", "task-detail", view.message || "这篇已在文献库中，但检测到 PDF 与现有的不同。"));
    card.append(conflictActions(view));
  }

  if (view.state === "confirm") {
    card.append(el("div", "task-detail", view.detail || "未识别到文献信息，确认后按网页导入"));
    card.append(webpageConfirmActions(view));
  }

  return card;
}

function stateLabel(state: CaptureView["state"]): string {
  switch (state) {
    case "acquiring":
      return "正在下载全文…";
    case "uploading":
      return "正在上传到 MangoWrite…";
    case "queued":
      return "排队中";
    default:
      return "";
  }
}

function stateIcon(view: CaptureView): HTMLElement {
  const wrap = el("span", "task-icon");
  if (view.state === "acquiring" || view.state === "uploading") {
    wrap.append(el("span", "spinner"));
  } else if (view.state === "queued") {
    wrap.innerHTML = svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', "var(--color-text-tertiary)");
  } else if (view.state === "confirm") {
    wrap.innerHTML = svg('<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 015.83 1c0 2-3 2.1-3 4"/><path d="M12 17h.01"/>', "var(--color-warning-500, #f59e0b)");
  } else if (view.state === "completed") {
    if (view.resultKind === "metadata-only") {
      wrap.innerHTML = svg('<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>', "var(--color-warning-500, #f59e0b)");
    } else {
      wrap.innerHTML = svg('<path d="M20 6L9 17l-5-5"/>', "var(--color-success-500)");
    }
  } else if (view.state === "conflict") {
    wrap.innerHTML = svg('<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>', "var(--color-warning-500, #f59e0b)");
  } else {
    wrap.innerHTML = svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>', "var(--color-danger-500)");
  }
  return wrap;
}

function svg(inner: string, stroke: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

function closeButton(captureId: string, action: "cancel" | "dismiss"): HTMLElement {
  const btn = el("span", "task-x");
  btn.setAttribute("role", "button");
  btn.setAttribute("aria-label", action === "cancel" ? "取消" : "移除");
  btn.innerHTML = svg('<path d="M18 6L6 18"/><path d="M6 6l12 12"/>', "currentColor");
  btn.addEventListener("click", () => {
    void sendAction(action === "cancel" ? "mango-write/cancel-capture" : "mango-write/dismiss-capture", captureId);
  });
  return btn;
}

function failedActions(view: CaptureView): HTMLElement {
  const wrap = el("div", "task-actions");
  if (view.actions.includes("retry-upload")) {
    const retry = el("button", "btn-danger", "重试");
    retry.addEventListener("click", () => void sendAction("mango-write/retry-capture", view.captureId));
    wrap.append(retry);
  } else {
    const reimport = el("button", "btn-danger", "跳转原页面重试");
    reimport.addEventListener("click", () => void sendAction("mango-write/reimport-capture", view.captureId));
    wrap.append(reimport);
  }
  const dismiss = el("button", "btn-ghost", "移除");
  dismiss.addEventListener("click", () => void sendAction("mango-write/dismiss-capture", view.captureId));
  wrap.append(dismiss);
  return wrap;
}

function conflictActions(view: CaptureView): HTMLElement {
  const wrap = el("div", "task-actions");
  // 「更新为新 PDF」要字节在手（background 按真实条件投影）；条件不满足
  // 时只剩「保留原有」，绝不渲染点了没反应的更新按钮。
  if (view.actions.includes("replace")) {
    const update = el("button", "btn-danger", "更新为新 PDF");
    update.addEventListener("click", () =>
      void sendAction("mango-write/confirm-replace-capture", view.captureId),
    );
    wrap.append(update);
  }
  const keep = el("button", "btn-ghost", "保留原有");
  keep.addEventListener("click", () => void sendAction("mango-write/dismiss-capture", view.captureId));
  wrap.append(keep);
  return wrap;
}

/** 未识别页面的网页导入确认：确认落库，或取消丢弃（快照不落库）。 */
function webpageConfirmActions(view: CaptureView): HTMLElement {
  const wrap = el("div", "task-actions");
  const ok = el("button", "btn-danger", "按网页导入");
  ok.addEventListener("click", () =>
    void sendAction("mango-write/confirm-webpage-capture", view.captureId),
  );
  wrap.append(ok);
  const cancel = el("button", "btn-ghost", "取消");
  cancel.addEventListener("click", () => void sendAction("mango-write/dismiss-capture", view.captureId));
  wrap.append(cancel);
  return wrap;
}

async function sendAction(type: string, captureId: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type, captureId });
  } catch (error) {
    if (isContextInvalidatedError(error)) {
      debugLog("popup", "sendAction skipped (context invalidated)", type);
    } else {
      debugError("popup", "sendAction failed", type, error);
    }
  }
}
