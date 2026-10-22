import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPairing,
  getActiveOrigin,
  getDeviceId,
  getPairing,
  getPairings,
  isAutoPairOptedOut,
  normalizeOrigin,
  setActiveOrigin,
  setAutoPairOptOut,
  setPairing,
  type Pairing,
} from "./storage.js";

/** Minimal chrome.storage.local double with the real API's key shapes. */
function installChromeStorage(seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed));
  const local = {
    get: vi.fn(async (keys: string | string[]) => {
      const out: Record<string, unknown> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (store.has(key)) out[key] = store.get(key);
      }
      return out;
    }),
    set: vi.fn(async (obj: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(obj)) store.set(k, v);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    }),
  };
  vi.stubGlobal("chrome", { storage: { local } });
  return store;
}

function pairing(overrides: Partial<Pairing> = {}): Pairing {
  return {
    deviceToken: "mwx_test",
    tokenId: "tok-1",
    user: { id: "u1", email: "u@example.com", name: null },
    pairedAt: 1,
    ...overrides,
  };
}

describe("配对存储：多环境槽位", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("按 origin 分槽，互不顶掉；active 归第一个登记的", async () => {
    installChromeStorage();
    await setPairing("https://mangowrite.com", pairing({ apiBaseUrl: "https://mangowrite.com" }));
    await setPairing("http://localhost:5173", pairing({ apiBaseUrl: "http://localhost:5173" }));

    expect(Object.keys(await getPairings()).sort()).toEqual([
      "http://localhost:5173",
      "https://mangowrite.com",
    ]);
    expect(await getActiveOrigin()).toBe("https://mangowrite.com");
  });

  it("登记新环境不抢占 active——否则多标签页会来回翻转导入目标", async () => {
    installChromeStorage();
    await setPairing("https://mangowrite.com", pairing());
    await setActiveOrigin("https://mangowrite.com");
    await setPairing("https://write.aidenchen.cn", pairing());

    expect(await getActiveOrigin()).toBe("https://mangowrite.com");
  });

  it("切换 active 只认已配对的 origin", async () => {
    installChromeStorage();
    await setPairing("https://mangowrite.com", pairing());
    await setActiveOrigin("https://never-paired.example");

    expect(await getActiveOrigin()).toBe("https://mangowrite.com");
  });

  it("清掉 active 槽后 active 落到剩下的环境", async () => {
    installChromeStorage();
    await setPairing("https://mangowrite.com", pairing());
    await setPairing("http://localhost:5173", pairing());
    await clearPairing("https://mangowrite.com");

    expect(await getActiveOrigin()).toBe("http://localhost:5173");
    expect(await getPairing()).not.toBeNull();
  });

  it("迁移旧的单槽位配对：按它自己的 apiBaseUrl 落位并成为 active", async () => {
    const store = installChromeStorage({
      "mangoWrite.pairing": pairing({ apiBaseUrl: "https://mangowrite.com" }),
    });

    const map = await getPairings();

    expect(Object.keys(map)).toEqual(["https://mangowrite.com"]);
    expect(await getActiveOrigin()).toBe("https://mangowrite.com");
    // 迁移完就删旧键，避免下次再迁一遍把用户切过的 active 打回去。
    expect(store.has("mangoWrite.pairing")).toBe(false);
  });

  it("origin 归一化：带路径/大小写/末尾斜杠都落同一个槽", async () => {
    installChromeStorage();
    await setPairing("https://MangoWrite.com/library?x=1", pairing());

    expect(normalizeOrigin("https://mangowrite.com/")).toBe("https://mangowrite.com");
    expect(Object.keys(await getPairings())).toEqual(["https://mangowrite.com"]);
  });
});

describe("自动配对的 opt-out", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("按 origin 记，且只影响被标记的那个", async () => {
    installChromeStorage();
    await setAutoPairOptOut("https://mangowrite.com", true);

    expect(await isAutoPairOptedOut("https://mangowrite.com")).toBe(true);
    expect(await isAutoPairOptedOut("http://localhost:5173")).toBe(false);
  });

  it("可以撤销（用户重新显式连接时）", async () => {
    installChromeStorage();
    await setAutoPairOptOut("https://mangowrite.com", true);
    await setAutoPairOptOut("https://mangowrite.com", false);

    expect(await isAutoPairOptedOut("https://mangowrite.com")).toBe(false);
  });
});

describe("设备 id", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("生成一次后保持稳定——服务端按它去重设备行", async () => {
    installChromeStorage();
    const first = await getDeviceId();
    const second = await getDeviceId();

    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("并发取用只落一个 id，不会各写各的", async () => {
    installChromeStorage();
    const ids = await Promise.all([getDeviceId(), getDeviceId(), getDeviceId()]);

    expect(new Set(ids).size).toBe(1);
  });
});
