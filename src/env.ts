import { BUILD_CHANNEL, BUILD_ENV, BUILD_ID, STORE_DNR_REFERER } from "./build-info.js";

export const VERSION = chrome.runtime.getManifest().version;
export { BUILD_ID, BUILD_ENV, BUILD_CHANNEL };

/**
 * Whether this build ships the declarativeNetRequest Referer injection. False for
 * store-distributable builds (MW_EXT_STORE=1) - the Referer rewriting is stripped
 * so the shipped artifact carries no DNR permission.
 */
export { STORE_DNR_REFERER };

/**
 * Dev unless the build was explicitly marked production. Build env is the
 * signal (not "no update_url" / load-unpacked): site-distributed builds are
 * sideloaded unpacked on purpose and must stay quiet.
 */
export const IS_DEV = BUILD_ENV !== "production";

/** Call once per entry point on load — the fastest way to confirm a reload actually picked up new code. */
export function logBuildBanner(scope: string): void {
  console.log(
    `[mango-write:${scope}] v${VERSION} · build ${BUILD_ID} · env=${BUILD_ENV} · devLogs=${IS_DEV}`,
  );
}

export function debugLog(scope: string, ...args: unknown[]): void {
  if (IS_DEV) console.log(`[mango-write:${scope}]`, ...args);
}

export function debugWarn(scope: string, ...args: unknown[]): void {
  if (IS_DEV) console.warn(`[mango-write:${scope}]`, ...args);
}

export function debugError(scope: string, ...args: unknown[]): void {
  if (IS_DEV) console.error(`[mango-write:${scope}]`, ...args);
}

/** True when an API throw is just the extension being reloaded/disabled — not a real bug. */
export function isContextInvalidatedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Extension context invalidated");
}

/**
 * Cheap liveness check for stale content scripts. After the extension is
 * reloaded/updated, the old content script keeps running in already-open
 * pages but its context is dead: chrome.runtime.id goes undefined and any
 * chrome API call throws "Extension context invalidated" SYNCHRONOUSLY (so a
 * .catch on the returned promise never sees it). Gate API calls on this, and
 * still try/catch for the race where the context dies between check and call.
 */
export function isExtensionContextAlive(): boolean {
  return typeof chrome !== "undefined" && !!chrome.runtime?.id;
}
