/**
 * 捕获前的「内容稳定」等待（dsh-read-url 借鉴）：懒加载/慢渲染页面在用户
 * 点击瞬间可能还没渲染完，立刻快照会得到半成品正文。策略是观察 body 的
 * DOM 变更，连续 `quietMs` 没有任何变更视为稳定；心跳轮询类页面永远在
 * 变更，所以用 `maxWaitMs` 硬超时兜底——等待有上限，绝不卡住捕获。
 *
 * 成本刻意压到很低：body 不存在（仍在解析）先轮询等它出现；DOM 从头就
 * 没有变更的静态页第一个静默窗口（默认约 700ms）后即返回。
 */

export interface CaptureStabilityOptions {
  /** 无变更判定稳定的静默窗口（毫秒），默认 700。 */
  quietMs?: number;
  /** 硬超时（毫秒），默认 3000。 */
  maxWaitMs?: number;
  /** body 未出现时的轮询间隔（毫秒），默认 100。 */
  pollMs?: number;
  /** MutationObserver 构造器，可注入 fake 便于单测。 */
  observerImpl?: typeof MutationObserver;
  /** 文档根，可注入 fake 便于单测，默认全局 document。 */
  root?: Pick<Document, "body">;
}

/** 等待页面内容稳定（或到达硬超时）后 resolve。 */
export function waitForContentStability(options: CaptureStabilityOptions = {}): Promise<void> {
  const quietMs = options.quietMs ?? 700;
  const maxWaitMs = options.maxWaitMs ?? 3000;
  const pollMs = options.pollMs ?? 100;
  const ObserverImpl = options.observerImpl ?? MutationObserver;
  const root = options.root ?? document;

  return new Promise<void>((resolve) => {
    let settled = false;
    let observer: MutationObserver | null = null;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let deadline: ReturnType<typeof setTimeout>;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (observer) observer.disconnect();
      if (quietTimer !== null) clearTimeout(quietTimer);
      if (pollTimer !== null) clearTimeout(pollTimer);
      resolve();
    };

    // 硬超时：心跳页永远有变更，等待必须有上限。
    deadline = setTimeout(finish, maxWaitMs);

    const armQuietWindow = () => {
      if (quietTimer !== null) clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    };

    const startObserving = () => {
      if (!root.body) {
        // body 还没出现（脚本在文档解析早期就被触发）：轮询等它。
        pollTimer = setTimeout(startObserving, pollMs);
        return;
      }
      observer = new ObserverImpl(armQuietWindow);
      observer.observe(root.body!, { childList: true, subtree: true, characterData: true });
      armQuietWindow();
    };

    startObserving();
  });
}
