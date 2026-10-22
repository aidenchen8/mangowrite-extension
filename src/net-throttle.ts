/**
 * Per-host 抓取限速（合规加固）：同一 host 的请求串行执行，相邻两次「发起」
 * 间隔取 1.5–4s 均匀随机，模拟人类逐个点击下载的节奏；不同 host 互不阻塞。
 * 所有 host 统一参数，不做站点名单。
 */

import type { ByteFetcher } from "./api.js";

export interface NetThrottleOptions {
  /** 相邻两次发起的最小间隔（毫秒），默认 1500。 */
  minIntervalMs?: number;
  /** 相邻两次发起的最大间隔（毫秒），默认 4000。 */
  maxIntervalMs?: number;
  /** 随机源，返回 [0, 1)。可注入固定值便于单测，默认 Math.random。 */
  random?: () => number;
  /** 延迟函数，可注入 fake 实现便于单测，默认 setTimeout。 */
  delay?: (ms: number) => Promise<void>;
  /** 时钟，默认 Date.now。 */
  now?: () => number;
}

export interface NetThrottle {
  /** 把任务排进 key 对应 host 的串行队列，返回任务结果。 */
  schedule<T>(host: string, task: () => Promise<T>): Promise<T>;
}

interface HostState {
  /** 队尾 promise：新任务接在它后面，保证同 host 不并发。 */
  tail: Promise<unknown>;
  /** 上一个请求的实际发起时刻（不是完成时刻）。 */
  lastStart: number;
}

/**
 * 创建一个限速器。语义：
 * - 同一 host 的任务严格串行：后一个任务等前一个任务**完成**后才进入发起流程，
 *   因此同 host 任意时刻最多一个在途请求。
 * - 发起前再按随机间隔补齐等待：等待时长 = lastStart + 随机间隔 - 当前时刻。
 *   间隔从上一次的**发起时刻**起算而不是完成时刻——长下载已经天然拉开了
 *   节奏，不再额外罚等（此时等待算出来 ≤ 0，直接发起）；只有上一次很快
 *   返回时才真正 sleep，保证两次发起间隔 ≥ 随机值。
 * - host 的第一个请求不等待，立即发起。
 */
export function createNetThrottle(options: NetThrottleOptions = {}): NetThrottle {
  const minIntervalMs = options.minIntervalMs ?? 1500;
  const maxIntervalMs = options.maxIntervalMs ?? 4000;
  const random = options.random ?? Math.random;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;

  const hosts = new Map<string, HostState>();

  function schedule<T>(host: string, task: () => Promise<T>): Promise<T> {
    let state = hosts.get(host);
    if (!state) {
      state = { tail: Promise.resolve(), lastStart: Number.NEGATIVE_INFINITY };
      hosts.set(host, state);
    }

    const run = state.tail.then(async () => {
      const interval = minIntervalMs + random() * (maxIntervalMs - minIntervalMs);
      const wait = state.lastStart + interval - now();
      if (wait > 0) await delay(wait);
      state.lastStart = now();
      return task();
    });
    // 任务失败不能卡死同 host 的后续排队，错误只回传给本次调用方。
    state.tail = run.catch(() => {});
    return run;
  }

  return { schedule };
}

/** 生产环境共享的全局限速器：跨 import 流程、跨标签页统一限速。 */
export const fetchThrottle = createNetThrottle();

/**
 * 把 ByteFetcher 包上一层 per-host 限速。viaTab 降级 direct 属于同一次抓取
 * 的内部实现，整体只计一次发起，不重复计时。URL 解析失败（拿不到 host）
 * 时不限速直发——不阻断下载。
 */
export function wrapByteFetcher(fetchBytes: ByteFetcher, throttle: NetThrottle = fetchThrottle): ByteFetcher {
  return (url, onProgress) => {
    let host: string | null = null;
    try {
      host = new URL(url).host;
    } catch {
      host = null;
    }
    if (!host) return fetchBytes(url, onProgress);
    return throttle.schedule(host, () => fetchBytes(url, onProgress));
  };
}
