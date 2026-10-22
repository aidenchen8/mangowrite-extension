// Reject HTML that is a gate, not the article.
//
// A "HTML 全文" attachment link is fetched with the user's cookies and can come
// back as a **200 text/html** page that is not the paper at all: CNKI answers a
// rejected bar.cnki.net order link with a login page (`<title>中国知网-登录`) or a
// small error shell, and anti-bot layers (Cloudflare, Aliyun/Tencent captcha)
// answer with a challenge page. Nothing in the HTTP response distinguishes those
// from a successful fetch, so a naive caller stores the gate as the paper's full
// text — which is how a login page ended up as a source's content (a 18KB
// `中国知网-登录` document filed as 迈向第三代人工智能).
//
// The signals below are deliberately narrow: a real article page does not put
// 登录/验证/error in its `<title>`, does not carry a password field, and does not
// load a captcha vendor's script. Being wrong in the reject direction costs the
// user a full text they could have had, so we only reject on those.
//
// Pure and string-based so it runs in the MV3 worker and is unit-testable.

/**
 * Which kind of gate we hit. Worth distinguishing because the user's next step
 * differs: sign in, solve a challenge, get an entitlement, or just try later.
 */
export type GateKind = "login" | "challenge" | "forbidden" | "error";

/** `<title>` text of an HTML document, tags and entities left as-is. */
function documentTitle(html: string): string {
  const raw = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  return raw.replace(/\s+/g, " ").trim();
}

/** Titles a gate page uses, by kind. Anchored on the whole title so an article
 * called 「用户登录行为研究」 (the word appears mid-title) is not read as a gate. */
const GATE_TITLE_PATTERNS: Array<[GateKind, RegExp]> = [
  ["login", /(?:^|[-|—·:：\s])(?:用户)?登录(?:页面?)?\s*$/],
  ["login", /^\s*(?:请)?登录/],
  ["login", /^\s*(?:sign|log)\s?in\b/i],
  ["login", /\b(?:sign|log)\s?in\s*$/i],
  ["challenge", /安全验证|人机验证|滑动验证|访问验证|验证码/],
  ["challenge", /just a moment/i],
  ["challenge", /attention required/i],
  ["forbidden", /(?:access denied|forbidden|not authorized|unauthorized)/i],
  ["forbidden", /拒绝访问|无访问权限|权限不足|没有权限/],
  ["error", /(?:^|[-|—·:：\s])(?:出错了?|错误页面?|系统错误|服务异常)\s*$/],
];

/** Anti-bot / captcha vendors. Their script tag means the page is the challenge,
 * not the content — no article embeds these. */
const CHALLENGE_MARKERS: RegExp[] = [
  /turing\.captcha\.qcloud\.com/i,
  /aliyunCaptcha|AliyunCaptchaConfig/,
  /id=["']captcha-element["']/i,
  /\bgeetest\b|gt_captcha/i,
  /(?:recaptcha\/api\.js|hcaptcha\.com\/1\/api\.js)/i,
  /cf-(?:challenge|browser-verification)|__cf_chl_/i,
  /_Incapsula_Resource|distil_r_captcha/i,
];

/** CNKI's ~5.7KB anti-leech shell served for an expired/single-use order id. */
const CNKI_ERROR_PAGE_MARKERS: RegExp[] = [
  /服务端出现未知错误了/,
  /class=["']errCode["']/i,
  /应用不正确/,
];

/** A password field — a login form, whatever the page calls itself. */
function hasPasswordField(html: string): boolean {
  return /<input\b[^>]*\btype=["']password["']/i.test(html);
}

/**
 * Classify `html` as a gate, or null when it looks like real content.
 *
 * The size ceiling only bounds the work and reflects that gates are small
 * documents; it is generous (400KB) because CNKI's login page alone is 18KB and
 * a Cloudflare interstitial can carry a large inline script. Real HTML full text
 * that happens to exceed it is accepted, which is the safe direction.
 *
 * Title patterns are checked before the markup markers: CNKI's login page also
 * embeds a captcha widget, and "you need to sign in" is the more useful thing to
 * tell the user than "there was a captcha".
 */
export function detectGate(html: string): GateKind | null {
  if (html.length > 400_000) return null;

  const title = documentTitle(html);
  if (title) {
    for (const [kind, pattern] of GATE_TITLE_PATTERNS) {
      if (pattern.test(title)) return kind;
    }
  }
  // A password field on a small document is a login page; on a big one it is
  // more likely a site-wide header form sitting above real content.
  if (html.length < 60_000 && hasPasswordField(html)) return "login";
  if (CHALLENGE_MARKERS.some((pattern) => pattern.test(html))) return "challenge";
  if (CNKI_ERROR_PAGE_MARKERS.some((pattern) => pattern.test(html))) return "error";

  return null;
}

/** Byte-level entry point for fetched attachment bodies. */
export function detectGateBytes(bytes: Uint8Array): GateKind | null {
  if (bytes.byteLength > 400_000) return null;
  return detectGate(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
}
