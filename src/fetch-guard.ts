/**
 * SW 抓取的 URL 闸门：只挡「字面」私网/环回地址与私网主机名，防快照内联
 * 请求被导向 trust boundary 之内。防不住 DNS rebinding——公网域名解析到内网
 * IP 照样放行；服务端 egress 才是最终防线。
 */
export function isPublicHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || /\.(?:localhost|local|internal)$/.test(host)) return false;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    // 畸形字面量（>255）一并拒绝：宁可少抓一张图。
    if (octets.some((n) => n > 255)) return false;
    const [a, b] = [octets[0]!, octets[1]!];
    if (a === 0 || a === 10 || a === 127) return false; // 0/8、10/8、127/8
    if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10 CGNAT
    if (a === 169 && b === 254) return false; // 169.254/16 链路本地
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12
    if (a === 192 && b === 168) return false; // 192.168/16
    return true;
  }

  // URL.hostname 保留 IPv6 字面量的方括号。
  if (host.startsWith("[") && host.endsWith("]")) {
    const bare = host.slice(1, -1);
    if (bare === "::1") return false;
    const first = Number.parseInt(bare.split(":")[0] ?? "", 16);
    if (Number.isNaN(first)) return true;
    return !((first >= 0xfc00 && first <= 0xfdff) || (first >= 0xfe80 && first <= 0xfebf));
  }
  return true;
}
