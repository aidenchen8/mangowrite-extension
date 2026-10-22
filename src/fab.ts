import {
  DEFAULT_FAB_POSITION,
  isOwnWebApp,
  normalizeFabPosition,
  snapSide,
  type FabPosition,
} from "./fab-util.js";
import { debugError, debugLog, isContextInvalidatedError } from "./env.js";

/**
 * On-page floating action button (FAB): a draggable, edge-docked capture entry
 * rendered into a closed shadow root so the host page's CSS can't touch it.
 *
 * Idle it sits half-hidden and gray on the docked edge; when a translator
 * recognizes a paper it animates fully out and lights up. Clicking the button
 * opens the popup panel — an iframe reuse of popup.html, so the on-page panel
 * and the toolbar popup are the exact same UI over the exact same queue.
 */

const POSITION_KEY = "mangoWrite.fabPosition";
const DRAG_THRESHOLD = 4; // px before a press counts as a drag, not a click

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let button: HTMLButtonElement | null = null;
let panelWrap: HTMLElement | null = null;
let position: FabPosition = DEFAULT_FAB_POSITION;
let recognizedState = false;


export async function initFab(input: {
  recognized: boolean;
}): Promise<void> {
  // Top frame only, and never on the MangoWrite web app itself (it has its own
  // connect UI — a FAB there would just be clutter).
  if (window.top !== window.self) return;
  if (isOwnWebApp(location.hostname, location.port)) return;

  recognizedState = input.recognized;

  let fabEnabled = true;
  try {
    const settings = await chrome.runtime.sendMessage({ type: "mango-write/get-settings" });
    fabEnabled = settings?.result?.fabEnabled ?? true;
  } catch (error) {
    debugLog("fab", "get-settings failed, defaulting on", error);
  }

  // React live to the settings toggle so turning the FAB off/on takes effect
  // without a page reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes["mangoWrite.settings"]) {
      const next = changes["mangoWrite.settings"].newValue as { fabEnabled?: boolean } | undefined;
      if (next?.fabEnabled === false) teardown();
      else if (!host) void mount();
    }
    if (changes[POSITION_KEY] && host) {
      position = normalizeFabPosition(changes[POSITION_KEY].newValue as FabPosition | undefined);
      applyPosition();
    }
  });

  if (!fabEnabled) return;
  await loadPosition();
  await mount();
}

/** Called by content.ts when the page's recognized state settles. */
export function setFabRecognized(recognized: boolean): void {
  recognizedState = recognized;
  applyRecognized();
}

async function loadPosition(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(POSITION_KEY);
    position = normalizeFabPosition(stored[POSITION_KEY] as FabPosition | undefined);
  } catch {
    position = DEFAULT_FAB_POSITION;
  }
}

async function savePosition(): Promise<void> {
  try {
    await chrome.storage.local.set({ [POSITION_KEY]: position });
  } catch (error) {
    if (isContextInvalidatedError(error)) {
      debugLog("fab", "savePosition skipped (context invalidated)");
    } else {
      debugError("fab", "savePosition failed", error);
    }
  }
}

async function mount(): Promise<void> {
  if (host) return;
  const iconUrl = chrome.runtime.getURL("icons/icon48.png");

  host = document.createElement("div");
  host.id = "mango-write-fab-host";
  host.style.cssText = "all:initial;position:fixed;z-index:2147483646;";
  root = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = FAB_CSS;
  root.append(style);

  button = document.createElement("button");
  button.className = "fab";
  button.type = "button";
  button.setAttribute("aria-label", "导入到 MangoWrite");
  const img = document.createElement("img");
  img.src = iconUrl;
  img.alt = "";
  img.draggable = false;
  button.append(img);
  root.append(button);

  panelWrap = document.createElement("div");
  panelWrap.className = "panel-wrap";
  panelWrap.hidden = true;
  root.append(panelWrap);

  document.documentElement.append(host);

  wireInteractions();
  wirePanelMessaging();
  applyPosition();
  applyRecognized();
  debugLog("fab", "mounted", position);
}

function teardown(): void {
  closePanel();
  host?.remove();
  host = null;
  root = null;
  button = null;
  panelWrap = null;
  debugLog("fab", "torn down");
}

function applyPosition(): void {
  if (!host || !button) return;
  host.style.top = `${Math.round(position.topPct * 100)}vh`;
  if (position.side === "right") {
    host.style.right = "0px";
    host.style.left = "auto";
  } else {
    host.style.left = "0px";
    host.style.right = "auto";
  }
  button.classList.toggle("dock-right", position.side === "right");
  button.classList.toggle("dock-left", position.side === "left");
}

function applyRecognized(): void {
  button?.classList.toggle("recognized", recognizedState);
}

// Drag + click

function wireInteractions(): void {
  if (!button) return;
  let dragging = false;
  let didDrag = false;
  let startX = 0;
  let startY = 0;
  let pointerId = -1;

  button.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return; // left button only; drag or click to open panel
    dragging = true;
    didDrag = false;
    startX = e.clientX;
    startY = e.clientY;
    pointerId = e.pointerId;
    button?.setPointerCapture(pointerId);
  });

  button.addEventListener("pointermove", (e) => {
    if (!dragging || !host) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!didDrag && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    didDrag = true;
    button?.classList.add("dragging");
    // Follow the pointer freely while dragging (snap to an edge on release).
    host.style.left = `${e.clientX - 15}px`;
    host.style.right = "auto";
    host.style.top = `${e.clientY - 15}px`;
  });

  button.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    button?.releasePointerCapture(pointerId);
    button?.classList.remove("dragging");
    if (didDrag) {
      snapToEdge(e.clientX, e.clientY);
    } else {
      togglePanel();
    }
  });

  // Close the panel on an outside click.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (panelWrap && !panelWrap.hidden && e.target !== host) closePanel();
    },
    true,
  );
}

function snapToEdge(clientX: number, clientY: number): void {
  const side = snapSide(clientX, window.innerWidth);
  const topPct = clientY / window.innerHeight;
  position = normalizeFabPosition({ side, topPct });
  applyPosition();
  void savePosition();
}

// Panel (iframe reuse of popup.html)

/**
 * Listen for messages posted by popup.html's inline script:
 * - panel height (window.frameElement is null cross-origin, so the popup can't
 *   measure itself from the inside — it posts the height and we apply it from
 *   the outside)
 * - panel hide (popup's closeSelf(): window.close() can't close the iframe's
 *   host, so a close action from inside asks us to hide the panel)
 */
function wirePanelMessaging(): void {
  window.addEventListener("message", (e) => {
    if (!e.data || typeof e.data !== "object") return;
    if (e.data.type === "mango-write/fab-panel-height") {
      const height = e.data.height as number;
      if (typeof height !== "number" || !isFinite(height)) return;
      const frame = panelWrap?.querySelector<HTMLElement>(".panel-frame");
      if (!frame) return;
      const maxPx = Math.round(window.innerHeight * 0.86);
      frame.style.height = `${Math.min(Math.ceil(height), maxPx)}px`;
      return;
    }
    if (e.data.type === "mango-write/fab-panel-hide") closePanel();
  });
}

function togglePanel(): void {
  if (panelWrap && !panelWrap.hidden) closePanel();
  else openPanel();
}

function openPanel(): void {
  if (!panelWrap) return;
  if (panelWrap.childElementCount === 0) {
    const frame = document.createElement("iframe");
    frame.className = "panel-frame";
    frame.src = chrome.runtime.getURL("popup.html");
    panelWrap.append(frame);
  }
  panelWrap.classList.toggle("left", position.side === "left");
  // Grow downward when the FAB sits in the top half, upward when it's low, so
  // the panel stays on-screen wherever the user parked the button.
  if (position.topPct > 0.5) {
    panelWrap.style.top = "auto";
    panelWrap.style.bottom = "0px";
  } else {
    panelWrap.style.top = "0px";
    panelWrap.style.bottom = "auto";
  }
  panelWrap.hidden = false;
}

function closePanel(): void {
  if (panelWrap) panelWrap.hidden = true;
}

// CSS 字符串原样打进公开分发的 zip，不写 CSS 注释；跨文件约束（下方
// panel-wrap / panel-frame 的高度契约）放在这里。
// panel-wrap 不定高：高度由 popup.html 的 ResizeObserver 脚本量出后经
// frame.style.height 写入；overflow:clip 只裁视觉，不像 overflow:hidden
// 那样构成 BFC 把容器先掐死在 iframe 高度写入之前。
const FAB_CSS = `
:host { all: initial; }
.fab {
  all: unset;
  box-sizing: border-box;
  position: relative;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: #f3f4f6;
  box-shadow: 0 4px 12px rgba(20,14,8,0.18);
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  transition: transform 0.22s cubic-bezier(0.34,1.56,0.64,1), background 0.2s ease, box-shadow 0.2s ease;
}
.fab img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
  filter: grayscale(1);
  opacity: 0.5;
  pointer-events: none;
  transition: filter 0.2s ease, opacity 0.2s ease;
}
.fab.dock-right { transform: translateX(50%); }
.fab.dock-left  { transform: translateX(-50%); }
.fab:hover { transform: translateX(0); }
.fab.dragging { cursor: grabbing; transform: none; transition: none; box-shadow: 0 8px 20px rgba(20,14,8,0.28); }
.fab.recognized {
  transform: translateX(0);
  background: #fff;
  box-shadow: 0 6px 16px -4px rgba(249,115,22,0.5);
  animation: fab-pop 0.4s cubic-bezier(0.34,1.56,0.64,1);
}
.fab.recognized img { filter: none; opacity: 1; }
@keyframes fab-pop {
  0% { transform: translateX(40%) scale(0.9); }
  60% { transform: translateX(-6%) scale(1.12); }
  100% { transform: translateX(0) scale(1); }
}
.panel-wrap {
  position: absolute;
  top: 0;
  right: 40px;
  width: 328px;
  max-height: 86vh;
  overflow: clip;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 18px 40px -12px rgba(40,20,4,0.28), 0 4px 12px rgba(20,14,8,0.1);
  border: 1px solid rgba(20,14,8,0.08);
}
.panel-wrap.left { right: auto; left: 40px; }
.panel-frame { width: 100%; height: 0; border: 0; display: block; }
`;
