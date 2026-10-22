import { describe, expect, it } from "vitest";

import { isPublicHttpUrl } from "./fetch-guard.js";

describe("isPublicHttpUrl — SW 抓取的私网闸门", () => {
  it("放行公网 http(s) URL", () => {
    expect(isPublicHttpUrl("https://arxiv.org/pdf/2401.00001")).toBe(true);
    expect(isPublicHttpUrl("http://pub.example.com/styles/main.css")).toBe(true);
    expect(isPublicHttpUrl("https://203.0.113.9/img.png")).toBe(true); // TEST-NET-3 仅作字面量
    expect(isPublicHttpUrl("HTTPS://EXAMPLE.COM/A")).toBe(true);
  });

  it("拒绝非 http(s) 与解析失败的 URL", () => {
    expect(isPublicHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isPublicHttpUrl("ftp://example.com/a")).toBe(false);
    expect(isPublicHttpUrl("chrome-extension://abc/icon.png")).toBe(false);
    expect(isPublicHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isPublicHttpUrl("not a url")).toBe(false);
  });

  it("拒绝 localhost 与私网主机名后缀", () => {
    expect(isPublicHttpUrl("http://localhost/a")).toBe(false);
    expect(isPublicHttpUrl("http://LOCALHOST:8080/a")).toBe(false);
    expect(isPublicHttpUrl("http://api.localhost/a")).toBe(false);
    expect(isPublicHttpUrl("http://printer.local/a")).toBe(false);
    expect(isPublicHttpUrl("http://db.internal/a")).toBe(false);
    expect(isPublicHttpUrl("http://localhost./a")).toBe(false);
    expect(isPublicHttpUrl("http://notlocalhost/a")).toBe(true);
    expect(isPublicHttpUrl("http://local.host/a")).toBe(true);
  });

  it("拒绝 IPv4 私网/环回/链路本地段字面量", () => {
    expect(isPublicHttpUrl("http://0.0.0.0/a")).toBe(false);
    expect(isPublicHttpUrl("http://0.1.2.3/a")).toBe(false);
    expect(isPublicHttpUrl("http://10.1.2.3/a")).toBe(false);
    expect(isPublicHttpUrl("http://100.64.0.1/a")).toBe(false);
    expect(isPublicHttpUrl("http://100.127.255.254/a")).toBe(false);
    expect(isPublicHttpUrl("http://127.0.0.1/a")).toBe(false);
    expect(isPublicHttpUrl("http://127.8.8.8/a")).toBe(false);
    expect(isPublicHttpUrl("http://169.254.1.9/a")).toBe(false);
    expect(isPublicHttpUrl("http://172.16.0.1/a")).toBe(false);
    expect(isPublicHttpUrl("http://172.31.255.255/a")).toBe(false);
    expect(isPublicHttpUrl("http://192.168.1.1/a")).toBe(false);
  });

  it("放行段边界之外的字面量（100.128/172.32/169.255 等）", () => {
    expect(isPublicHttpUrl("http://100.128.0.1/a")).toBe(true);
    expect(isPublicHttpUrl("http://172.32.0.1/a")).toBe(true);
    expect(isPublicHttpUrl("http://169.255.0.1/a")).toBe(true);
    expect(isPublicHttpUrl("http://8.8.8.8/a")).toBe(true);
  });

  it("拒绝畸形 IPv4 字面量", () => {
    expect(isPublicHttpUrl("http://999.1.1.1/a")).toBe(false);
    expect(isPublicHttpUrl("http://1.2.3.4.5/a")).toBe(false);
  });

  it("拒绝 IPv6 环回 / ULA / 链路本地字面量", () => {
    expect(isPublicHttpUrl("http://[::1]/a")).toBe(false);
    expect(isPublicHttpUrl("http://[fc00::1]/a")).toBe(false);
    expect(isPublicHttpUrl("http://[fd12:3456:789a::1]/a")).toBe(false);
    expect(isPublicHttpUrl("http://[fe80::1]/a")).toBe(false);
    // 废弃的 site-local fec0::/10 不在规格三段里，按边界注释放行。
    expect(isPublicHttpUrl("http://[fec0::1]/a")).toBe(true);
  });

  it("放行公网 IPv6 字面量", () => {
    expect(isPublicHttpUrl("http://[2001:db8::1]/a")).toBe(true);
    expect(isPublicHttpUrl("http://[2606:4700:4700::1111]/a")).toBe(true);
  });
});
