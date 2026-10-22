import { describe, expect, it } from "vitest";
import { DEFAULT_FAB_POSITION, isOwnWebApp, normalizeFabPosition, snapSide } from "./fab-util.js";

describe("normalizeFabPosition", () => {
  it("returns the default for missing or malformed values", () => {
    expect(normalizeFabPosition(undefined)).toEqual(DEFAULT_FAB_POSITION);
    expect(normalizeFabPosition(null)).toEqual(DEFAULT_FAB_POSITION);
    // @ts-expect-error — exercising a corrupt stored shape
    expect(normalizeFabPosition({ side: "middle", topPct: 0.5 })).toEqual(DEFAULT_FAB_POSITION);
  });

  it("clamps topPct into the on-screen range", () => {
    expect(normalizeFabPosition({ side: "left", topPct: -1 }).topPct).toBe(0.04);
    expect(normalizeFabPosition({ side: "left", topPct: 5 }).topPct).toBe(0.92);
  });

  it("keeps a valid position intact", () => {
    expect(normalizeFabPosition({ side: "left", topPct: 0.3 })).toEqual({ side: "left", topPct: 0.3 });
  });
});

describe("snapSide", () => {
  it("snaps to the nearest horizontal edge", () => {
    expect(snapSide(10, 1000)).toBe("left");
    expect(snapSide(900, 1000)).toBe("right");
    expect(snapSide(500, 1000)).toBe("right"); // midpoint biases right
  });
});

describe("isOwnWebApp", () => {
  it("suppresses the FAB on the web app's own origins", () => {
    expect(isOwnWebApp("localhost", "5173")).toBe(true);
    expect(isOwnWebApp("127.0.0.1", "3001")).toBe(true);
    expect(isOwnWebApp("mangowrite.com", "")).toBe(true);
    expect(isOwnWebApp("rewrite.mangowrite.com", "")).toBe(true);
    expect(isOwnWebApp("write.aidenchen.cn", "")).toBe(true);
  });

  it("shows the FAB on publisher sites and other local pages", () => {
    expect(isOwnWebApp("kns.cnki.net", "")).toBe(false);
    expect(isOwnWebApp("arxiv.org", "")).toBe(false);
    // 个人域名的其他子站点不是我们的 web 应用，FAB 照常显示。
    expect(isOwnWebApp("blog.aidenchen.cn", "")).toBe(false);
    // localhost 上不是 web 应用的端口（本地起的测试页/静态服务）不屏蔽。
    expect(isOwnWebApp("localhost", "8899")).toBe(false);
    expect(isOwnWebApp("127.0.0.1", "")).toBe(false);
  });
});
