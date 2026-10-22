import { describe, expect, it, vi } from "vitest";
import { createNetThrottle, wrapByteFetcher, type NetThrottleOptions } from "./net-throttle.js";
import type { ByteFetcher } from "./api.js";

/** 手动时钟 + 记录型 fake delay，避免单测真实等秒。 */
function makeHarness(overrides: Partial<NetThrottleOptions> = {}) {
  let current = 0;
  const delays: number[] = [];
  const throttle = createNetThrottle({
    minIntervalMs: 1500,
    maxIntervalMs: 4000,
    random: () => 0.5, // 间隔固定为 1500 + 0.5 * 2500 = 2750
    now: () => current,
    delay: async (ms) => {
      delays.push(ms);
      current += ms;
    },
    ...overrides,
  });
  return { throttle, delays, advance: (ms: number) => (current += ms), now: () => current };
}

/** 让排队的微任务跑完。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createNetThrottle", () => {
  it("同一 host 两次请求不并发，且发起间隔等于注入的随机间隔", async () => {
    const { throttle, delays, now } = makeHarness();
    const starts: number[] = [];
    const gate = deferred();

    const first = throttle.schedule("a.com", async () => {
      starts.push(now());
      await gate.promise; // 挂住第一个请求，观察第二个是否等它
      return 1;
    });
    await flush();
    expect(starts).toHaveLength(1); // host 首请求立即发起

    const second = throttle.schedule("a.com", async () => {
      starts.push(now());
      return 2;
    });
    await flush();
    // 第二个请求必须等第一个完成（不并发），此刻还没轮到它
    expect(starts).toHaveLength(1);

    gate.resolve();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);

    // 间隔从上一个请求的发起时刻起算，等于 min + random() * (max - min)
    expect(starts[1] - starts[0]).toBe(2750);
    expect(delays).toEqual([2750]);
  });

  it("间隔从上一次发起时刻算：上一次下载本身够久时不再额外罚等", async () => {
    const { throttle, delays, advance } = makeHarness();
    await throttle.schedule("a.com", async () => {});
    advance(10000); // 上一次下载花了 10s，远超 2750ms 的随机间隔
    await throttle.schedule("a.com", async () => {});
    expect(delays).toEqual([]); // 不产生额外等待
  });

  it("不同 host 互不阻塞，可并行发起", async () => {
    const { throttle } = makeHarness();
    const gate = deferred();
    const started: string[] = [];

    const first = throttle.schedule("a.com", async () => {
      started.push("a");
      await gate.promise; // a.com 的请求一直不完成
    });
    const second = throttle.schedule("b.com", async () => {
      started.push("b");
    });
    await flush();

    // b.com 不受 a.com 在途请求影响，且作为 host 首请求立即发起
    expect(started).toEqual(["a", "b"]);
    gate.resolve();
    await Promise.all([first, second]);
  });

  it("任务失败不卡死同 host 的后续排队", async () => {
    const { throttle } = makeHarness();
    await expect(throttle.schedule("a.com", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(throttle.schedule("a.com", async () => "ok")).resolves.toBe("ok");
  });
});

describe("wrapByteFetcher", () => {
  const fakeResult = { bytes: new Uint8Array([1]), contentType: null, contentDisposition: null };

  it("有效 URL 按 host 走进限速队列", async () => {
    const { throttle } = makeHarness();
    const calls: string[] = [];
    const inner: ByteFetcher = async (url) => {
      calls.push(url);
      return fakeResult;
    };
    const wrapped = wrapByteFetcher(inner, throttle);

    await wrapped("https://kns.cnki.net/a.pdf");
    await wrapped("https://kns.cnki.net/b.pdf");
    expect(calls).toEqual(["https://kns.cnki.net/a.pdf", "https://kns.cnki.net/b.pdf"]);
  });

  it("URL 解析失败时降级直发，不进队列也不阻断下载", async () => {
    const schedule = vi.fn();
    const throttle = { schedule };
    const inner: ByteFetcher = async () => fakeResult;
    const wrapped = wrapByteFetcher(inner, throttle as never);

    await expect(wrapped("not a url")).resolves.toBe(fakeResult);
    expect(schedule).not.toHaveBeenCalled();
  });
});
