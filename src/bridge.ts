/**
 * Web app ↔ extension bridge over window.postMessage, relayed by the content
 * script. This is the primary channel: unlike chrome.runtime.sendMessage(
 * extensionId, ...) it needs no extension ID — which is random per machine
 * for unpacked ("加载已解压的扩展程序") installs, so ID-based discovery forced
 * every sideload user through an admin whitelist round-trip. The old
 * externally_connectable channel stays as a fallback for older builds.
 *
 * Security boundary: the content script is the gate. Page JS runs in the page
 * world and cannot reach chrome.runtime (isolated world), so the only way a
 * page can drive the background is through this listener — which is why the
 * origin whitelist here carries the same weight as the manifest's
 * externally_connectable matches and the two must stay in sync.
 */

import { ALLOW_DEV_ORIGINS } from "./build-info.js";

export const BRIDGE_REQUEST_SOURCE = "mango-write-web";
export const BRIDGE_RESPONSE_SOURCE = "mango-write-extension";

export interface BridgeRequest {
  source: typeof BRIDGE_REQUEST_SOURCE;
  requestId: string;
  message: unknown;
}

export interface BridgeResponseBody {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface BridgeResponse {
  source: typeof BRIDGE_RESPONSE_SOURCE;
  requestId: string;
  response: BridgeResponseBody;
}

/**
 * Origins allowed to drive the extension over the bridge. Mirrors manifest.json
 * `externally_connectable.matches`, except localhost/127.0.0.1 are allowed on
 * any port (dev servers move; the manifest list is pinned to 3000/3001/5173
 * only because match patterns can't express "any localhost port" either —
 * keep the production host rule identical).
 *
 * Dev origins are compiled out of distributed artifacts (`ALLOW_DEV_ORIGINS`,
 * false for store and site builds). build-zip.mjs strips them from the packaged
 * manifest's externally_connectable; this is the same door's second lock, and
 * shipping with it open would let any page on the user's own machine drive the
 * extension. The parameter exists so tests can cover both builds.
 */
export function isBridgeOriginAllowed(
  origin: string,
  allowDevOrigins: boolean = ALLOW_DEV_ORIGINS,
): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname;
  if (
    allowDevOrigins &&
    url.protocol === "http:" &&
    (host === "localhost" || host === "127.0.0.1")
  ) {
    return true;
  }
  // write.aidenchen.cn 是个人域名上的测试盒，只放行这一个 host，不做后缀匹配。
  if (
    url.protocol === "https:" &&
    (host === "mangowrite.com" || host.endsWith(".mangowrite.com") || host === "write.aidenchen.cn")
  ) {
    return true;
  }
  return false;
}

export function parseBridgeRequest(data: unknown): BridgeRequest | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.source !== BRIDGE_REQUEST_SOURCE) return null;
  if (typeof d.requestId !== "string" || d.requestId.length === 0) return null;
  const message = d.message;
  if (!message || typeof message !== "object") return null;
  if (typeof (message as { type?: unknown }).type !== "string") return null;
  return { source: BRIDGE_REQUEST_SOURCE, requestId: d.requestId, message };
}

export function buildBridgeResponse(requestId: string, response: BridgeResponseBody): BridgeResponse {
  return { source: BRIDGE_RESPONSE_SOURCE, requestId, response };
}

/**
 * One-way extension → web app push (no requestId, no response). Posted to the
 * page by the content script when the background broadcasts a library change
 * after an import lands; the web app listens and refreshes its library list.
 * Same channel identity as BridgeResponse so the page only ever trusts
 * envelopes relayed by the content script on whitelisted origins.
 */
export type BridgeEventKind = "library-changed";

export interface BridgeEventMessage {
  source: typeof BRIDGE_RESPONSE_SOURCE;
  event: BridgeEventKind;
}

export function buildBridgeEvent(event: BridgeEventKind): BridgeEventMessage {
  return { source: BRIDGE_RESPONSE_SOURCE, event };
}
