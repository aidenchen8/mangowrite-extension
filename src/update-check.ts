// Self-update check for site-distributed builds. Sideloaded ("Load unpacked")
// installs never auto-update — self-hosted update_url only works under
// enterprise policy — so the site channel polls extension-version.json on the
// app origin and surfaces a notification when a newer build is available.
// Store channels never run this: the store owns their update lifecycle.
import { API_BASE_URL, BUILD_CHANNEL } from "./build-info.js";
import { VERSION, debugLog, debugWarn } from "./env.js";

const ALARM_NAME = "mango-write/update-check";
const NOTIFICATION_ID = "mango-write/update-available";
const LAST_NOTIFIED_KEY = "updateCheckLastNotifiedVersion";
/** Twice a day is plenty for a manual-update channel. */
const PERIOD_MINUTES = 720;

interface VersionManifest {
  version?: string;
}

/** Strict-ish semver triple compare: "0.1.10" > "0.1.2". Non-semver → null. */
function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const c = parseVersion(candidate);
  const v = parseVersion(current);
  if (!c || !v) return false;
  for (let i = 0; i < 3; i++) {
    if (c[i] !== v[i]) return c[i] > v[i];
  }
  return false;
}

/**
 * Latest published version from the app origin. Returns null on any failure
 * (offline, non-200, malformed) or non-site channel — callers treat null as
 * "no info". Shared by the background alarm check and the popup's on-open check.
 */
export async function fetchLatestVersion(): Promise<string | null> {
  if (BUILD_CHANNEL !== "site") return null;
  try {
    const res = await fetch(`${API_BASE_URL}/downloads/extension-version.json`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const latest = ((await res.json()) as VersionManifest).version?.trim();
    return latest || null;
  } catch {
    return null;
  }
}

/** Open the /extension guide page (download zip → overwrite-install → reload). */
export function openUpgradeGuide(): void {
  void chrome.tabs.create({ url: `${API_BASE_URL}/extension` });
}

/**
 * Register the periodic + startup update check. No-op on non-site channels.
 * Call once from the background entry point.
 */
export function initUpdateCheck(): void {
  if (BUILD_CHANNEL !== "site") return;
  // Optional chaining throughout: test harnesses stub only the chrome.* APIs
  // a feature under test touches, and none of these are load-bearing enough to
  // crash the worker over.
  chrome.alarms?.create(ALARM_NAME, { periodInMinutes: PERIOD_MINUTES });
  chrome.runtime.onStartup?.addListener(() => void checkForUpdate());
  chrome.runtime.onInstalled?.addListener(() => void checkForUpdate());
  chrome.notifications?.onClicked?.addListener((notificationId) => {
    if (notificationId !== NOTIFICATION_ID) return;
    void chrome.notifications.clear(NOTIFICATION_ID);
    // The guide page shows the "覆盖解压 → chrome://extensions 点刷新" flow.
    openUpgradeGuide();
  });
}

export function isUpdateCheckAlarm(alarmName: string): boolean {
  return BUILD_CHANNEL === "site" && alarmName === ALARM_NAME;
}

export async function checkForUpdate(): Promise<void> {
  if (BUILD_CHANNEL !== "site") return;
  const latest = await fetchLatestVersion();
  if (!latest || !isNewerVersion(latest, VERSION)) {
    debugLog("update-check", "up to date", { VERSION, latest });
    return;
  }
  // Notify once per version — the alarm fires twice a day and repeating the
  // same notification trains users to ignore it.
  try {
    const stored = await chrome.storage.local.get(LAST_NOTIFIED_KEY);
    if (stored[LAST_NOTIFIED_KEY] === latest) return;
    await chrome.storage.local.set({ [LAST_NOTIFIED_KEY]: latest });
    await chrome.notifications.create(NOTIFICATION_ID, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "MangoWrite 插件有新版本",
      message: `v${latest} 已发布（当前 v${VERSION}）。点击查看升级指引。`,
    });
  } catch (error) {
    debugWarn("update-check", "notify failed", error);
  }
}
