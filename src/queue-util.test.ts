import { describe, expect, it } from "vitest";
import {
  captureKey,
  classifyFailure,
  failureCopy,
  failureText,
  isTransientError,
  relativeTime,
  siteLabel,
} from "./queue-util.js";
import type { FailureKind } from "./protocol.js";

describe("captureKey", () => {
  it("prefers a non-empty identifier", () => {
    expect(captureKey("10.1/abc", "https://x.com/p")).toBe("10.1/abc");
  });

  it("falls back to the origin URL when the identifier is null or blank", () => {
    expect(captureKey(null, "https://x.com/p")).toBe("https://x.com/p");
    expect(captureKey("   ", "https://x.com/p")).toBe("https://x.com/p");
  });

  it("makes two clicks on the same paper collide", () => {
    expect(captureKey("doi:1", "https://a/1")).toBe(captureKey("doi:1", "https://a/2"));
  });

  it("normalizes URL-only captures before comparing them", () => {
    expect(captureKey(null, "http://example.com/p?b=2&a=1&utm_source=x")).toBe(
      captureKey(null, "https://example.com/p?a=1&b=2"),
    );
  });
});

describe("siteLabel", () => {
  it("maps known hosts (and subdomains) to friendly labels", () => {
    expect(siteLabel("https://kns.cnki.net/kcms/detail")).toBe("CNKI");
    expect(siteLabel("https://arxiv.org/abs/1706.03762")).toBe("arXiv");
    expect(siteLabel("https://www.cqvip.com/doc/1")).toBe("维普");
  });

  it("strips www and returns the bare host for unknown sites", () => {
    expect(siteLabel("https://www.example.org/a")).toBe("example.org");
  });

  it("returns empty string for junk URLs", () => {
    expect(siteLabel("not a url")).toBe("");
  });

  it("labels file:// origins as 本地文件 (they have no host)", () => {
    expect(siteLabel("file:///D:/downloads/paper.pdf")).toBe("本地文件");
  });
});

describe("isTransientError", () => {
  it("treats network failures as transient", () => {
    expect(isTransientError(new Error("Failed to fetch"))).toBe(true);
    expect(isTransientError(new Error("network timeout"))).toBe(true);
  });

  it("treats 5xx and 429 as transient", () => {
    expect(isTransientError(new Error("request_failed:503"))).toBe(true);
    expect(isTransientError(new Error("request_failed:429"))).toBe(true);
  });

  it("treats 4xx (other than 429) and domain errors as permanent", () => {
    expect(isTransientError(new Error("request_failed:404"))).toBe(false);
    expect(isTransientError(new Error("request_failed:401"))).toBe(false);
    expect(isTransientError(new Error("设备令牌已被吊销"))).toBe(false);
    expect(isTransientError(new Error("未找到可下载的 PDF"))).toBe(false);
  });
});

describe("classifyFailure", () => {
  it("recognizes network / transport jargon", () => {
    expect(classifyFailure(new Error("Failed to fetch"))).toBe("network");
    expect(classifyFailure(new Error("NetworkError when attempting to fetch resource"))).toBe("network");
    expect(classifyFailure(new Error("net::ERR_CONNECTION_RESET"))).toBe("network");
  });

  it("maps request_failed machine codes to server", () => {
    expect(classifyFailure(new Error("request_failed:502"))).toBe("server");
    expect(classifyFailure(new Error("request_failed:403"))).toBe("server");
  });

  it("recognizes the revoked-token wording", () => {
    expect(classifyFailure(new Error("设备令牌已被吊销"))).toBe("auth-revoked");
  });

  it("falls back to unknown for anything unrecognized", () => {
    expect(classifyFailure(new Error("whatever"))).toBe("unknown");
    expect(classifyFailure(undefined)).toBe("unknown");
  });
});

describe("failureCopy", () => {
  it("every kind has plain-language copy: reason always, hint optional", () => {
    const kinds: FailureKind[] = [
      "page-unreachable",
      "page-interrupted",
      "read-timeout",
      "read-failed",
      "snapshot-stale",
      "gate-login",
      "gate-challenge",
      "gate-forbidden",
      "gate-error",
      "network",
      "pdf-unavailable",
      "not-pdf",
      "local-file-moved",
      "file-access-denied",
      "nothing-to-import",
      "auth-revoked",
      "server",
      "browser-interrupted",
      "unknown",
    ];
    for (const kind of kinds) {
      const copy = failureCopy(kind);
      expect(copy.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("raw transport strings never leak into the copy", () => {
    expect(failureCopy("network", "Failed to fetch").reason).toBe("网络连接出了问题");
    expect(failureCopy("server", "request_failed:502").reason).toBe("MangoWrite 服务暂时不可用");
  });

  it("a human server message (CJK sentence) becomes the reason instead of generic copy", () => {
    expect(failureCopy("server", "每周解析额度已用完").reason).toBe("每周解析额度已用完");
    // 机器码长得再像中文语境也不用
    expect(failureCopy("unknown", "request_failed:500").reason).toBe("导入没有成功");
  });

  it("unknown keeps its generic copy for non-CJK raw strings", () => {
    expect(failureCopy("unknown", "some internal error").reason).toBe("导入没有成功");
  });
});

describe("failureText", () => {
  it("joins reason and hint with a newline for notifications", () => {
    const text = failureText({ kind: "auth-revoked" });
    expect(text).toContain("连接已断开");
    expect(text).toContain("重新连接");
    expect(text.split("\n")).toHaveLength(2);
  });

  it("returns just the reason when there is no hint-bearing path", () => {
    expect(failureText({ kind: "network" })).toContain("网络连接出了问题");
  });
});

describe("relativeTime", () => {
  const now = 1_700_000_000_000;

  it("buckets from 刚刚 up to days", () => {
    expect(relativeTime(now, now)).toBe("刚刚");
    expect(relativeTime(now - 59_000, now)).toBe("刚刚");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 小时前");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2 天前");
  });

  it("never shows a negative bucket for future timestamps", () => {
    expect(relativeTime(now + 10_000, now)).toBe("刚刚");
  });
});
