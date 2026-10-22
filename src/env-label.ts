/**
 * Which deployment the extension is actually talking to.
 *
 * Derived from the *connected* API base URL (the paired web app's origin),
 * never from BUILD_ENV: one installed artifact can be re-paired against any
 * deployment, so a build-time constant answers the wrong question. When no
 * pairing exists yet, callers pass the build-time fallback so a locally loaded
 * or test-channel build still shows what it would connect to.
 */
export type EnvKind = "production" | "test" | "other";

export interface EnvBadge {
  kind: EnvKind;
  /** Badge text. Empty for production — production shows no badge by default. */
  label: string;
  /**
   * Always-populated display name, including for production. The badge stays
   * hidden on production for ordinary users, but the environment switcher
   * still has to name every row — and an admin sitting on production needs a
   * visible entry point to switch away from it.
   */
  name: string;
  /** Host shown next to the label for "other"; empty otherwise. */
  detail: string;
}

const PRODUCTION_HOSTS = new Set(["mangowrite.com", "www.mangowrite.com"]);
const TEST_HOSTS = new Set(["write.aidenchen.cn"]);

export function classifyEnv(apiBaseUrl: string | null | undefined): EnvBadge {
  const host = hostnameOf(apiBaseUrl);

  if (host && PRODUCTION_HOSTS.has(host)) {
    return { kind: "production", label: "", name: "正式环境", detail: "" };
  }
  if (host && TEST_HOSTS.has(host)) {
    return { kind: "test", label: "测试环境", name: "测试环境", detail: "" };
  }
  // Unparseable URLs land here too: an unknown target is exactly the case the
  // badge exists to surface, so fail loud rather than assuming production.
  return { kind: "other", label: "其他环境", name: "其他环境", detail: host };
}

function hostnameOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
