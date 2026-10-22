/** Pure, DOM-free helpers for the on-page FAB, extracted for unit testing. */

export interface FabPosition {
  side: "left" | "right";
  /** Vertical position as a fraction of the viewport height (0–1). */
  topPct: number;
}

export const DEFAULT_FAB_POSITION: FabPosition = { side: "right", topPct: 0.6 };

/** Coerce a possibly-corrupt stored value into a valid, on-screen position. */
export function normalizeFabPosition(value: FabPosition | undefined | null): FabPosition {
  if (!value || (value.side !== "left" && value.side !== "right")) return DEFAULT_FAB_POSITION;
  const topPct = Math.min(0.92, Math.max(0.04, Number(value.topPct) || DEFAULT_FAB_POSITION.topPct));
  return { side: value.side, topPct };
}

/** Which edge to snap to on drag release — nearest horizontal half. */
export function snapSide(clientX: number, innerWidth: number): FabPosition["side"] {
  return clientX < innerWidth / 2 ? "left" : "right";
}

/**
 * The MangoWrite web app hosts its own connect UI — no FAB there. Production
 * hosts are matched by domain; local dev only on the web app's own ports
 * (5173 = vite dev web, 3000/3001 mirror manifest.json's
 * externally_connectable origins). Blanket-blocking localhost hid the FAB on
 * every other locally served page, which reads as "the button is gone".
 */
const OWN_DEV_PORTS = new Set(["3000", "3001", "5173"]);

export function isOwnWebApp(hostname: string, port: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "mangowrite.com" || host.endsWith(".mangowrite.com")) return true;
  // 测试盒域名：只精确匹配这一个 host，个人域名的其他子站点不是我们的 web 应用。
  if (host === "write.aidenchen.cn") return true;
  if (host !== "localhost" && host !== "127.0.0.1") return false;
  return OWN_DEV_PORTS.has(port);
}
