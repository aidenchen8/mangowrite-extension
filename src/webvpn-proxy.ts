// WebVPN 式代理页的 URL 改写。
//
// 校园 webvpn（如 webvpn.ccnu.edu.cn）把整个出版商站点代理在单一 origin 下：
// `https://webvpn.<school>.edu.cn/https/<host 前缀>/<原 path>`。改写器只处理
// href/src 属性，`<meta name="citation_pdf_url">` 里的出版商原始 URL 原样保留
// ——于是插件拿着跨域原始 URL 走 service worker 直连，没有校园会话，撞付费墙；
// 而页面上被改写成同源的下载链接（真正可用的那条）从未被尝试。
//
// 这里不做任何厂商加密算法：host 前缀直接复用页面 URL 自带的那段（同 host 的
// 前缀固定），出版商明文 origin 从页面自己的声明（og:url 等 meta）读出来。两个
// 输入都在手上时，同 host 的任意目标 URL 都能改写成页面同源形式，交由 tab 会话
// 抓取。

/** 一个被代理页的「明文 origin ↔ 代理前缀」对应关系。 */
export interface ProxyPageMapping {
  /** 代理站点 origin，如 `https://webvpn.ccnu.edu.cn`。 */
  proxyOrigin: string;
  /** 出版商 host 的代理前缀（webvpn 加密段），同 host 固定。 */
  hostPrefix: string;
  /** 页面被代理的出版商明文 origin，如 `https://www.nature.com`。 */
  plainOrigin: string;
}

const PROXIED_URL_PATTERN = /^\/(https?)\/([0-9a-f]{16,})(\/.*)?$/i;

/**
 * 识别 `https://webvpn…/https/<hex>/path` 形式的代理页 URL。hex 段是加密过的
 * host（各家算法不同，这里不解读，只确认形状）；scheme 段必须是 http/https。
 */
export function parseProxiedPageUrl(pageUrl: string): {
  proxyOrigin: string;
  hostPrefix: string;
} | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  const match = url.pathname.match(PROXIED_URL_PATTERN);
  if (!match) return null;
  return { proxyOrigin: url.origin, hostPrefix: match[2]! };
}

/**
 * 从页面 HTML 里读出版商的明文 origin。改写器不动 meta 内容，所以 og:url /
 * citation_pdf_url 保留着原始绝对 URL——它们声明了「这个页面本来是谁」。
 * 优先 og:url（页面自身的规范地址）；citation_pdf_url 的 host 在极少数站点
 * 与页面不同（CDN），所以只作次选。
 */
export function plainOriginFromHtml(html: string): string | null {
  for (const pattern of [
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i,
    /<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_pdf_url["']/i,
  ]) {
    const value = html.match(pattern)?.[1];
    if (!value) continue;
    try {
      return new URL(value).origin;
    } catch {
      // 不是绝对 URL（相对声明），看下一个来源
    }
  }
  return null;
}

/**
 * 由代理页 URL + 页面 HTML 建立映射。任一输入不成立（不是代理页、页面没有
 * 明文声明）返回 null，调用方保持原有直连行为。
 */
export function proxyMappingFromPage(pageUrl: string, html: string): ProxyPageMapping | null {
  const parsed = parseProxiedPageUrl(pageUrl);
  if (!parsed) return null;
  const plainOrigin = plainOriginFromHtml(html);
  if (!plainOrigin || plainOrigin === parsed.proxyOrigin) return null;
  return { proxyOrigin: parsed.proxyOrigin, hostPrefix: parsed.hostPrefix, plainOrigin };
}

/**
 * 把出版商原始 URL 改写成代理页同源形式。只改写映射声明的那一个明文 origin
 * （跨 host 的 hex 前缀无从得知）；目标已是代理 origin 或无关 host 时返回
 * null，由调用方走原逻辑。
 */
export function toProxiedUrl(mapping: ProxyPageMapping, target: string): string | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.origin === mapping.proxyOrigin) return target; // 已经是同源代理形式
  if (url.origin !== mapping.plainOrigin) return null;
  const scheme = url.protocol.replace(":", "");
  // 代理形式把 scheme 与 host 前缀编进 path：/https/<hex><原 path>。
  return `${mapping.proxyOrigin}/${scheme}/${mapping.hostPrefix}${url.pathname}${url.search}`;
}
