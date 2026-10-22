import { describe, expect, it, vi } from "vitest";

import { waitForContentStability } from "./capture-stability.js";

/** 手动触发的 MutationObserver fake：record 回调，测试中显式 fire。 */
function makeObserverFake() {
  const instances: Array<{ callback: () => void; disconnect: () => void }> = [];
  class FakeMutationObserver {
    private callback: () => void;
    disconnected = false;
    constructor(callback: () => void) {
      this.callback = callback;
    }
    observe() {
      instances.push({ callback: this.callback, disconnect: () => this.disconnect() });
    }
    disconnect() {
      this.disconnected = true;
    }
    fire() {
      if (!this.disconnected) this.callback();
    }
  }
  return { FakeMutationObserver, instances };
}

function makeRoot(hasBody: boolean) {
  return { body: hasBody ? ({} as HTMLElement) : null };
}

describe("waitForContentStability", () => {
  it("静态页（无变更）在第一个静默窗口后返回", async () => {
    vi.useFakeTimers();
    try {
      const { FakeMutationObserver } = makeObserverFake();
      let done = false;
      const pending = waitForContentStability({
        quietMs: 700,
        maxWaitMs: 3000,
        observerImpl: FakeMutationObserver as unknown as typeof MutationObserver,
        root: makeRoot(true) as Document,
      }).then(() => {
        done = true;
      });

      await vi.advanceTimersByTimeAsync(699);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("持续变更会重置静默窗口，直到变更停止", async () => {
    vi.useFakeTimers();
    try {
      const { FakeMutationObserver, instances } = makeObserverFake();
      let done = false;
      const pending = waitForContentStability({
        quietMs: 700,
        maxWaitMs: 5000,
        observerImpl: FakeMutationObserver as unknown as typeof MutationObserver,
        root: makeRoot(true) as Document,
      }).then(() => {
        done = true;
      });

      // 每 500ms 一次变更（懒加载分块到达），静默窗口不断被重置。
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(500);
        instances[0]!.callback();
      }
      expect(done).toBe(false);

      // 变更停止后，再过完整静默窗口才放行。
      await vi.advanceTimersByTimeAsync(699);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("心跳页（永不停止的变更）在硬超时后放行", async () => {
    vi.useFakeTimers();
    try {
      const { FakeMutationObserver, instances } = makeObserverFake();
      let done = false;
      const pending = waitForContentStability({
        quietMs: 700,
        maxWaitMs: 3000,
        observerImpl: FakeMutationObserver as unknown as typeof MutationObserver,
        root: makeRoot(true) as Document,
      }).then(() => {
        done = true;
      });

      // 每 100ms 一次变更，静默窗口永远达不到，必须靠硬超时兜底。
      for (let i = 0; i < 40 && !done; i++) {
        await vi.advanceTimersByTimeAsync(100);
        instances[0]?.callback();
      }
      await pending;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("body 尚未出现时先轮询，出现后开始观察", async () => {
    vi.useFakeTimers();
    try {
      const { FakeMutationObserver, instances } = makeObserverFake();
      const root = makeRoot(false);
      let done = false;
      const pending = waitForContentStability({
        quietMs: 700,
        maxWaitMs: 3000,
        pollMs: 100,
        observerImpl: FakeMutationObserver as unknown as typeof MutationObserver,
        root: root as unknown as Document,
      }).then(() => {
        done = true;
      });

      await vi.advanceTimersByTimeAsync(250);
      expect(instances).toHaveLength(0); // body 未出现，尚未开始观察
      expect(done).toBe(false);

      root.body = {} as HTMLElement; // 文档解析推进，body 出现
      await vi.advanceTimersByTimeAsync(100);
      expect(instances).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(700);
      await pending;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

