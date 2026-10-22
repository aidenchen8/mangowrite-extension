import { API_BASE_URL } from "./build-info.js";
import type { ExtensionSettings } from "./protocol.js";

/** Build-time fallback (see scripts/generate-build-info.mjs), used only when no pairing exists yet. */
export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

export interface PairedUser {
  id: string;
  email: string;
  name: string | null;
  /** Avatar URL pushed at pair time; absent on pairings from older web builds. */
  image?: string | null;
}

export interface Pairing {
  /** Long-lived `mwx_...` bearer minted by POST /api/import/extension/pair. */
  deviceToken: string;
  /** extension_tokens row id — lets the web app's device list revoke this pairing. */
  tokenId: string;
  user: PairedUser;
  pairedAt: number;
  /**
   * Origin of the web app that minted deviceToken. Preferred over the
   * build-time API_BASE_URL for every call made with this pairing — see
   * ExternalBackgroundMessage's "mango-write/pair" case. Optional so pairings
   * created before this field existed still fall back to the build constant.
   */
  apiBaseUrl?: string;
  /**
   * Whether this account may switch the extension between environments.
   * Resolved server-side (capability `extension.env.switch`) and pushed here on
   * pair — the extension never sees a role string. Product visibility only:
   * a client flag is not an access boundary, the boundary is each
   * environment's own sign-in.
   */
  canSwitchEnv?: boolean;
  /**
   * 网页端推来的「当前所在空间」（set-active-space）：个人 = null，团队 = id。
   * 插件导入目标选择器的默认项；只记偏好，导入权限仍由服务端判定。
   * Optional so pairings from older web builds fall back to 个人文库.
   */
  activeSpaceId?: string | null;
}

/** Legacy single-slot key, migrated into PAIRINGS_KEY on first read. */
const PAIRING_KEY = "mangoWrite.pairing";
/** origin → Pairing. One slot per environment so prod/test/local coexist. */
const PAIRINGS_KEY = "mangoWrite.pairings";
/** Which origin captures are sent to. */
const ACTIVE_ORIGIN_KEY = "mangoWrite.activeOrigin";
/** origin → true. Set when the user disconnects on purpose; blocks auto-pairing. */
const OPT_OUT_KEY = "mangoWrite.autoPairOptOut";
/** Stable per-install id; dedupes this browser's row in the web app's device list. */
const DEVICE_ID_KEY = "mangoWrite.deviceId";

export type PairingMap = Record<string, Pairing>;

/**
 * chrome.storage has no compare-and-swap, and read-modify-write on the pairing
 * map races when several tabs pair at once. Every mutation goes through this
 * chain so they queue instead of clobbering each other.
 */
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = writeChain.then(work, work);
  writeChain = next.catch(() => undefined);
  return next;
}

/** Storage keys are origins; normalize so "https://x.com/" and "https://x.com" agree. */
export function normalizeOrigin(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export async function getDeviceId(): Promise<string> {
  const stored = await chrome.storage.local.get(DEVICE_ID_KEY);
  const existing = stored[DEVICE_ID_KEY] as string | undefined;
  if (existing) return existing;
  return serialize(async () => {
    // Re-read inside the lock: a concurrent caller may have created one.
    const fresh = (await chrome.storage.local.get(DEVICE_ID_KEY))[DEVICE_ID_KEY] as
      | string
      | undefined;
    if (fresh) return fresh;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [DEVICE_ID_KEY]: id });
    return id;
  });
}

/**
 * All pairings, migrating the legacy single-slot value on first read. The old
 * value is keyed by its own apiBaseUrl (falling back to the build constant,
 * which is what that build would have talked to) and becomes the active origin.
 */
export async function getPairings(): Promise<PairingMap> {
  const stored = await chrome.storage.local.get([PAIRINGS_KEY, PAIRING_KEY]);
  const map = (stored[PAIRINGS_KEY] as PairingMap | undefined) ?? {};
  const legacy = stored[PAIRING_KEY] as Pairing | undefined;
  if (!legacy) return map;

  const origin = normalizeOrigin(legacy.apiBaseUrl ?? getApiBaseUrl());
  return serialize(async () => {
    const current =
      ((await chrome.storage.local.get(PAIRINGS_KEY))[PAIRINGS_KEY] as PairingMap | undefined) ??
      {};
    if (origin && !current[origin]) current[origin] = legacy;
    await chrome.storage.local.set({ [PAIRINGS_KEY]: current, [ACTIVE_ORIGIN_KEY]: origin });
    await chrome.storage.local.remove(PAIRING_KEY);
    return current;
  });
}

export async function getActiveOrigin(): Promise<string> {
  const stored = await chrome.storage.local.get(ACTIVE_ORIGIN_KEY);
  return (stored[ACTIVE_ORIGIN_KEY] as string | undefined) ?? "";
}

/** The pairing captures are sent to. Falls back to the only pairing when the active pointer is stale. */
export async function getPairing(): Promise<Pairing | null> {
  const [map, active] = await Promise.all([getPairings(), getActiveOrigin()]);
  if (active && map[active]) return map[active];
  const origins = Object.keys(map);
  return origins.length === 1 ? map[origins[0]] : null;
}

export async function setPairing(origin: string, pairing: Pairing): Promise<void> {
  const key = normalizeOrigin(origin);
  if (!key) return;
  await getPairings(); // fold away any legacy value before writing
  await serialize(async () => {
    const stored = await chrome.storage.local.get([PAIRINGS_KEY, ACTIVE_ORIGIN_KEY]);
    const map = (stored[PAIRINGS_KEY] as PairingMap | undefined) ?? {};
    map[key] = pairing;
    const active = stored[ACTIVE_ORIGIN_KEY] as string | undefined;
    // Registering a pairing must not steal the import target from whatever the
    // user picked: only claim `active` when nothing holds it yet. Otherwise a
    // dev with prod + localhost open would watch imports flip between them.
    const nextActive = active && map[active] ? active : key;
    await chrome.storage.local.set({ [PAIRINGS_KEY]: map, [ACTIVE_ORIGIN_KEY]: nextActive });
  });
}

export async function setActiveOrigin(origin: string): Promise<void> {
  const key = normalizeOrigin(origin);
  if (!key) return;
  await serialize(async () => {
    const map =
      ((await chrome.storage.local.get(PAIRINGS_KEY))[PAIRINGS_KEY] as PairingMap | undefined) ??
      {};
    if (!map[key]) return;
    await chrome.storage.local.set({ [ACTIVE_ORIGIN_KEY]: key });
  });
}

/** 记下某个环境的「当前空间」推送；槽位不存在（未配对/已断开）则忽略。 */
export async function setPairingActiveSpace(origin: string, spaceId: string | null): Promise<void> {
  const key = normalizeOrigin(origin);
  if (!key) return;
  await serialize(async () => {
    const map =
      ((await chrome.storage.local.get(PAIRINGS_KEY))[PAIRINGS_KEY] as PairingMap | undefined) ??
      {};
    const slot = map[key];
    if (!slot) return;
    map[key] = { ...slot, activeSpaceId: spaceId };
    await chrome.storage.local.set({ [PAIRINGS_KEY]: map });
  });
}

/** Drop one environment's pairing (default: the active one) and repoint active. */
export async function clearPairing(origin?: string): Promise<void> {
  const target = normalizeOrigin(origin ?? (await getActiveOrigin()));
  await getPairings();
  await serialize(async () => {
    const stored = await chrome.storage.local.get([PAIRINGS_KEY, ACTIVE_ORIGIN_KEY]);
    const map = (stored[PAIRINGS_KEY] as PairingMap | undefined) ?? {};
    const key = target || Object.keys(map)[0];
    if (key) delete map[key];
    const remaining = Object.keys(map);
    const active = stored[ACTIVE_ORIGIN_KEY] as string | undefined;
    const nextActive = active && map[active] ? active : (remaining[0] ?? "");
    await chrome.storage.local.set({ [PAIRINGS_KEY]: map, [ACTIVE_ORIGIN_KEY]: nextActive });
  });
}

/**
 * Origins the user disconnected on purpose. Auto-pairing must honour this or
 * the disconnect button is decorative — the next page load would re-pair
 * instantly. Cleared only by an explicit "连接" from the web app.
 */
export async function isAutoPairOptedOut(origin: string): Promise<boolean> {
  const key = normalizeOrigin(origin);
  if (!key) return false;
  const stored = await chrome.storage.local.get(OPT_OUT_KEY);
  const map = (stored[OPT_OUT_KEY] as Record<string, boolean> | undefined) ?? {};
  return map[key] === true;
}

export async function setAutoPairOptOut(origin: string, optedOut: boolean): Promise<void> {
  const key = normalizeOrigin(origin);
  if (!key) return;
  await serialize(async () => {
    const stored = await chrome.storage.local.get(OPT_OUT_KEY);
    const map = (stored[OPT_OUT_KEY] as Record<string, boolean> | undefined) ?? {};
    if (optedOut) map[key] = true;
    else delete map[key];
    await chrome.storage.local.set({ [OPT_OUT_KEY]: map });
  });
}

const SETTINGS_KEY = "mangoWrite.settings";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  fabEnabled: true,
};

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const saved = (stored[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined) ?? {};
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function setSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}
