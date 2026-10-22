import { describe, expect, it } from "vitest";

import { detectGate, detectGateBytes } from "./interstitial.js";

/**
 * Trimmed from the page a CNKI "HTML 全文" link actually returned (200
 * text/html, 18KB) when the session had no entitlement. It was stored as the
 * full text of 迈向第三代人工智能 — the regression this guard exists for.
 */
const CNKI_LOGIN_PAGE = `<!DOCTYPE html>
<html>
  <head id="Head1">
    <meta charset="utf-8" />
    <title>中国知网-登录</title>
    <link href="css/ecpLogin.css?v=20260202" rel="stylesheet" type="text/css" />
  </head>
  <body>
    <div id="captcha-element"></div>
    <script src="https://turing.captcha.qcloud.com/TJCaptcha.js"></script>
    <div class="main" id="loginMain">
      <div class="login right"><a id="ecpUserLogin">机构登录</a></div>
    </div>
  </body>
</html>`;

const CNKI_ERROR_SHELL = `<html><head><title>错误</title></head>
<body><div class="errCode">服务端出现未知错误了！</div></body></html>`;

const CLOUDFLARE_CHALLENGE = `<html><head><title>Just a moment...</title></head>
<body><div id="challenge-running"></div><script>window._cf_chl_opt={};</script></body></html>`;

/** A genuine CNKI HTML full-text page: article title, no gate signals. */
const CNKI_FULL_TEXT = `<html><head><title>迈向第三代人工智能 - 中国知网</title></head>
<body><div class="wx-tit"><h1>迈向第三代人工智能</h1></div>
<div id="content">人工智能自1956年诞生以来……${"正文".repeat(2000)}</div></body></html>`;

describe("detectGate (内容校验)", () => {
  it("classifies the CNKI login page (filed as a paper's full text) as login", () => {
    // It also embeds a captcha widget; "sign in" is the more useful thing to say.
    expect(detectGate(CNKI_LOGIN_PAGE)).toBe("login");
  });

  it("classifies CNKI's anti-leech error shell as error", () => {
    expect(detectGate(CNKI_ERROR_SHELL)).toBe("error");
  });

  it("classifies a Cloudflare interstitial as challenge", () => {
    expect(detectGate(CLOUDFLARE_CHALLENGE)).toBe("challenge");
  });

  it("classifies an entitlement refusal as forbidden", () => {
    expect(
      detectGate("<html><head><title>Access Denied</title></head><body></body></html>"),
    ).toBe("forbidden");
    expect(
      detectGate("<html><head><title>无访问权限</title></head><body></body></html>"),
    ).toBe("forbidden");
  });

  it("classifies a small page carrying a password field as login", () => {
    expect(
      detectGate(
        '<html><head><title>访问入口</title></head><body><form>' +
          '<input type="text" name="u"><input type="password" name="p"></form></body></html>',
      ),
    ).toBe("login");
  });

  it("accepts genuine HTML full text", () => {
    expect(detectGate(CNKI_FULL_TEXT)).toBeNull();
  });

  it("does not reject an article whose own title merely contains 登录/验证", () => {
    // 登录 mid-title, and 验证 as a research topic — both real paper titles.
    expect(
      detectGate(
        "<html><head><title>用户登录行为对留存率的影响研究 - 中国知网</title></head>" +
          `<body>${"正文".repeat(500)}</body></html>`,
      ),
    ).toBeNull();
    expect(
      detectGate(
        "<html><head><title>形式化验证方法综述</title></head>" +
          `<body>${"正文".repeat(500)}</body></html>`,
      ),
    ).toBeNull();
  });

  it("accepts a large document even with a login form in its site header", () => {
    const bigWithHeaderForm =
      '<html><head><title>深度学习综述</title></head><body>' +
      '<header><input type="password" name="p"></header>' +
      `<div>${"正文".repeat(40_000)}</div></body></html>`;
    expect(bigWithHeaderForm.length).toBeGreaterThan(60_000);
    expect(detectGate(bigWithHeaderForm)).toBeNull();
  });
});

describe("detectGateBytes", () => {
  it("decodes UTF-8 bytes before matching", () => {
    expect(detectGateBytes(new TextEncoder().encode(CNKI_LOGIN_PAGE))).toBe("login");
    expect(detectGateBytes(new TextEncoder().encode(CNKI_FULL_TEXT))).toBeNull();
  });
});
