/**
 * Pure, chrome-free helpers for the import queue — extracted so they can be
 * unit-tested and shared between the background service worker and the popup
 * without dragging in service-worker-only APIs.
 */

import { canonicalizeUrl } from "./canonical-url.js";
import type { CaptureFailure, FailureKind } from "./protocol.js";

/** Dedup / provenance key: the identifier if present, else the origin URL. */
export function captureKey(identifier: string | null, originUrl: string): string {
  return (identifier && identifier.trim()) || canonicalizeUrl(originUrl);
}

const KNOWN_SITES: Record<string, string> = {
  "cnki.net": "CNKI",
  "arxiv.org": "arXiv",
  "wanfangdata.com.cn": "万方",
  "cqvip.com": "维普",
  "webofscience.com": "Web of Science",
  "ieee.org": "IEEE",
  "xueshu.baidu.com": "百度学术",
};

/** Human label for the source host, e.g. "CNKI" / "arXiv"; "" for junk URLs. */
export function siteLabel(originUrl: string): string {
  try {
    const parsed = new URL(originUrl);
    // file:// has no host to label — name the fact that it's a local file.
    if (parsed.protocol === "file:") return "本地文件";
    const host = parsed.hostname.replace(/^www\./, "");
    for (const [suffix, label] of Object.entries(KNOWN_SITES)) {
      if (host === suffix || host.endsWith(`.${suffix}`)) return label;
    }
    return host;
  } catch {
    return "";
  }
}

/**
 * Whether an error is worth auto-retrying: network failures and 5xx/429
 * responses. Permanent errors (4xx other than 429, revoked token, "no PDF")
 * are not transient.
 */
export function isTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/Failed to fetch|NetworkError|network|timeout|ECONN|ETIMEDOUT/i.test(message)) return true;
  return /request_failed:(5\d\d|429)/.test(message);
}

/**
 * 把没被失败点显式归类的错误（errText 兜底路径）归类。原始串保留在 raw
 * 供 tooltip / 日志，正文永远走 failureCopy。
 */
export function classifyFailure(error: unknown): FailureKind {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/吊销/.test(message)) return "auth-revoked";
  if (/Failed to fetch|NetworkError|network|timeout|ECONN|ETIMEDOUT|ERR_/i.test(message)) {
    return "network";
  }
  if (/request_failed:/.test(message)) return "server";
  return "unknown";
}

export interface FailureCopy {
  /** 发生了什么：一句话，说人话（用户是科研人员，不是工程师）。 */
  reason: string;
  /** 怎么办：只在重试按钮帮不上时才给（按钮帮得上的就别再复述一遍）。 */
  hint?: string;
}

/**
 * kind → 用户文案的唯一来源（popup 卡片与系统通知共用）。server/unknown 的
 * raw 若是中文句子（服务端写给人看的 message），直接用作 reason——别把它
 * 也翻译成「导入没有成功」把信息丢了。
 */
const FAILURE_COPY: Record<FailureKind, FailureCopy> = {
  "page-unreachable": {
    reason: "插件还没加载到这个页面",
    hint: "请刷新页面后再导入；浏览器的设置页、应用商店等页面无法导入。",
  },
  "page-interrupted": {
    reason: "导入还没完成，页面就被切换或关闭了",
    hint: "请回到原页面重新导入。",
  },
  "read-timeout": {
    reason: "页面加载太慢，没能读取完",
    hint: "等页面完全显示出来后，刷新再导入一次。",
  },
  "read-failed": {
    reason: "读取页面时出了问题",
    hint: "请刷新页面后再试一次。",
  },
  "snapshot-stale": {
    reason: "这个页面在等你确认期间被浏览器清理了",
    hint: "请回到原页面重新导入。",
  },
  "gate-login": {
    reason: "这个网站需要登录后才能下载全文",
    hint: "请先在网站上登录，再重新导入这篇文献。",
  },
  "gate-challenge": {
    reason: "这个网站要求先通过人机验证",
    hint: "请在页面上完成验证后再导入。",
  },
  "gate-forbidden": {
    reason: "当前账号没有这篇文献的下载权限",
    hint: "通常需要机构或期刊订阅：换到校园网 / 机构网络再试，或手动下载 PDF 后到文库中上传。",
  },
  "gate-error": {
    reason: "网站返回了错误页面",
    hint: "请稍后重试，或回到文献的介绍页再导入。",
  },
  network: {
    reason: "网络连接出了问题",
    hint: "请检查网络后重试。",
  },
  "pdf-unavailable": {
    reason: "没能下载到这篇文献的 PDF",
    hint: "可能需要登录，或链接已过期。",
  },
  "not-pdf": {
    reason: "这个链接打开的不是有效的 PDF 文件",
    hint: "请回到文献的介绍页或 PDF 阅读页再导入。",
  },
  "local-file-moved": {
    reason: "找不到这个本地文件",
    hint: "文件可能已被移动、删除或重命名，请确认后重试。",
  },
  "file-access-denied": {
    reason: "插件还没有获得读取本地文件的权限",
    hint: "请在浏览器地址栏输入 chrome://extensions，找到本插件并开启「允许访问文件网址」，再重试。",
  },
  "nothing-to-import": {
    reason: "这个页面上没有找到文献信息",
    hint: "请确认打开的是文献的介绍页或 PDF 阅读页。",
  },
  "auth-revoked": {
    reason: "插件与账号的连接已断开",
    hint: "请打开 MangoWrite 网页端，重新连接浏览器插件后再导入。",
  },
  server: {
    reason: "MangoWrite 服务暂时不可用",
    hint: "请稍后重试。",
  },
  "browser-interrupted": {
    reason: "导入中途被浏览器打断了",
    hint: "请重新导入一次。",
  },
  unknown: {
    reason: "导入没有成功",
    hint: "请重试；如果反复失败，请刷新页面后再试一次。",
  },
};

/** 中文句子判定：raw 里带 CJK 且不是机器码（request_failed:…）时才可信。 */
function isHumanSentence(text: string | undefined): boolean {
  if (!text || /request_failed:|unknown_error|capture_failed/.test(text)) return false;
  return /[\u4e00-\u9fff]/.test(text);
}

export function failureCopy(kind: FailureKind, raw?: string): FailureCopy {
  if ((kind === "server" || kind === "unknown") && isHumanSentence(raw)) {
    return { ...FAILURE_COPY[kind], reason: raw as string };
  }
  return FAILURE_COPY[kind];
}

/** 通知/卡片共用的完整文案：reason（+ hint 换行）。 */
export function failureText(failure: CaptureFailure): string {
  const copy = failureCopy(failure.kind, failure.raw);
  return copy.hint ? `${copy.reason}\n${copy.hint}` : copy.reason;
}

/** 队列卡片的相对时间（「刚刚 / N 分钟前 / N 小时前 / N 天前」）。 */
export function relativeTime(ts: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - ts) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
