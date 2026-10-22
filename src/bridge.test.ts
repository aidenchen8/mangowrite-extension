import { describe, expect, it } from "vitest";

import {
  BRIDGE_REQUEST_SOURCE,
  buildBridgeResponse,
  isBridgeOriginAllowed,
  parseBridgeRequest,
} from "./bridge.js";

describe("isBridgeOriginAllowed — 与 manifest externally_connectable 同语义", () => {
  it("放行生产 web 域名与其子域", () => {
    expect(isBridgeOriginAllowed("https://mangowrite.com")).toBe(true);
    expect(isBridgeOriginAllowed("https://rewrite.mangowrite.com")).toBe(true);
    expect(isBridgeOriginAllowed("https://a.b.mangowrite.com")).toBe(true);
  });

  it("放行测试盒域名，但只精确匹配这一个 host 且必须 https", () => {
    expect(isBridgeOriginAllowed("https://write.aidenchen.cn")).toBe(true);
    expect(isBridgeOriginAllowed("http://write.aidenchen.cn")).toBe(false);
    expect(isBridgeOriginAllowed("https://other.aidenchen.cn")).toBe(false);
    expect(isBridgeOriginAllowed("https://write.aidenchen.cn.evil.com")).toBe(false);
  });

  it("放行 localhost / 127.0.0.1 的任意端口（dev 端口不固定）", () => {
    expect(isBridgeOriginAllowed("http://localhost:3000")).toBe(true);
    expect(isBridgeOriginAllowed("http://localhost:5173")).toBe(true);
    expect(isBridgeOriginAllowed("http://127.0.0.1:8080")).toBe(true);
    expect(isBridgeOriginAllowed("http://localhost")).toBe(true);
  });

  it("分发构建（store / site）关掉 localhost：上架件不该被本机任意页面驱动", () => {
    // allowDevOrigins=false 对应 build-info 的 ALLOW_DEV_ORIGINS，
    // 与 build-zip.mjs 从打包 manifest 里剥掉 localhost 是同一扇门的两把锁。
    expect(isBridgeOriginAllowed("http://localhost:5173", false)).toBe(false);
    expect(isBridgeOriginAllowed("http://127.0.0.1:8080", false)).toBe(false);
    // 生产域名不受影响。
    expect(isBridgeOriginAllowed("https://mangowrite.com", false)).toBe(true);
  });

  it("拒绝文献站、冒牌域名与非 http(s) 协议", () => {
    expect(isBridgeOriginAllowed("https://kns.cnki.net")).toBe(false);
    expect(isBridgeOriginAllowed("https://mangowrite.com.evil.com")).toBe(false);
    expect(isBridgeOriginAllowed("https://evil-mangowrite.com")).toBe(false);
    // 生产域名必须 https——http 的 mangowrite.com 不能驱动插件。
    expect(isBridgeOriginAllowed("http://rewrite.mangowrite.com")).toBe(false);
    expect(isBridgeOriginAllowed("ftp://localhost:3000")).toBe(false);
    expect(isBridgeOriginAllowed("not-a-url")).toBe(false);
  });
});

describe("parseBridgeRequest — 信封校验", () => {
  it("接受合法信封", () => {
    const parsed = parseBridgeRequest({
      source: BRIDGE_REQUEST_SOURCE,
      requestId: "r1",
      message: { type: "mango-write/ping" },
    });
    expect(parsed).toEqual({
      source: BRIDGE_REQUEST_SOURCE,
      requestId: "r1",
      message: { type: "mango-write/ping" },
    });
  });

  it("拒绝来源不符、缺 requestId、消息无形的信封", () => {
    expect(parseBridgeRequest({ source: "other", requestId: "r1", message: { type: "mango-write/ping" } })).toBeNull();
    expect(parseBridgeRequest({ source: BRIDGE_REQUEST_SOURCE, requestId: "", message: { type: "mango-write/ping" } })).toBeNull();
    expect(parseBridgeRequest({ source: BRIDGE_REQUEST_SOURCE, requestId: 42, message: { type: "mango-write/ping" } })).toBeNull();
    expect(parseBridgeRequest({ source: BRIDGE_REQUEST_SOURCE, requestId: "r1", message: "ping" })).toBeNull();
    expect(parseBridgeRequest({ source: BRIDGE_REQUEST_SOURCE, requestId: "r1", message: {} })).toBeNull();
    expect(parseBridgeRequest(null)).toBeNull();
    expect(parseBridgeRequest("mango-write-web")).toBeNull();
  });
});

describe("buildBridgeResponse", () => {
  it("组装带回 requestId 的响应信封", () => {
    expect(buildBridgeResponse("r1", { ok: true, result: { pong: true } })).toEqual({
      source: "mango-write-extension",
      requestId: "r1",
      response: { ok: true, result: { pong: true } },
    });
  });
});
