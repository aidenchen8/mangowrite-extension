import { detectGateBytes, type GateKind } from "./interstitial.js";
import type { Attachment, PdfFileAsset, TeamTarget } from "./protocol.js";
import { looksLikePdfBytes } from "./pdf-detect.js";
import { findEmbeddedPdfUrl } from "./translators/embedded-pdf.js";

/**
 * Fetches raw bytes for a URL. Callers pass in either a direct background
 * fetch or a relay through the originating tab's content script — the latter
 * is required for anti-leech/SSO-gated links (CNKI via WebVPN, etc.) whose
 * session cookies a service-worker-initiated cross-origin fetch won't carry.
 */
export type ByteFetcher = (
  url: string,
  onProgress?: (loaded: number, total?: number) => void,
) => Promise<{
  bytes: Uint8Array;
  contentType: string | null;
  contentDisposition: string | null;
} | null>;

export interface PluginSession {
  token: string;
  uploadPath: string;
  expiresAt: string;
}

export interface PluginPdfCandidate {
  url: string;
  strategy: string;
  publisher: string;
}

export interface PluginCaptureResponse {
  sourceId: string;
  created: boolean;
  state: string;
  resolved: boolean;
  ingestStatus:
    | "pending"
    | "parsing"
    | "metadata_resolving"
    | "quota_blocked"
    | "completed"
    | "failed"
    | null;
  uploadedFile: boolean;
  validation: {
    matchedBy: "doi" | "title" | "unknown";
    extractedDoi: string | null;
    extractedTitle: string | null;
  } | null;
  /** Parse job id; populated when a file was uploaded and queued for parsing. */
  jobId: string | null;
  /**
   * The paper is already in the library with a *different* PDF; the captured
   * file was NOT written. Ask the user, then re-submit with
   * `replaceSourceId = sourceId` to update in place.
   */
  needsReplaceConfirm?: boolean;
  /**
   * The paper (and its full text, if any) was already in the user's library and
   * this capture added nothing new. Surface "已在库中" instead of a fresh-import note.
   */
  alreadyInLibrary?: boolean;
  /**
   * A team target was given but the server kept this metadata-only capture out
   * of the team because full text was gated. Tell the user the entry is personal
   * only for now, and they can share it once the full text arrives.
   */
  teamSkipped?: "gated-fulltext";
}


/**
 * `deviceToken` is the long-lived `mwx_...` bearer minted by the web app's
 * pairing flow (POST /api/import/extension/pair) and pushed to the extension
 * via externally_connectable. The server also accepts the `mango_session`
 * cookie as a fallback, but that cookie is `SameSite=Lax` and this is a
 * cross-site subresource fetch from the extension's own context, so the
 * browser won't actually attach it — the bearer is the real credential path.
 */
export async function requestPluginSession(
  apiBaseUrl: string,
  deviceToken: string | null,
): Promise<PluginSession> {
  return fetchJson(`${apiBaseUrl}/api/import/plugin/session`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(deviceToken ? { Authorization: `Bearer ${deviceToken}` } : {}),
    },
    body: JSON.stringify({}),
  });
}

/**
 * Best-effort self-revoke: tells the server to invalidate this device's own
 * token so the web app's "已连接设备" list reflects a disconnect immediately,
 * instead of only forgetting the pairing locally. Never throws — logout must
 * always succeed locally even if the request fails (offline, token already
 * revoked, wrong apiBaseUrl for a stale pairing, etc.).
 */
export async function revokeSelf(apiBaseUrl: string, deviceToken: string): Promise<void> {
  try {
    await fetchJson(`${apiBaseUrl}/api/import/extension/self/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
  } catch {
    // best-effort — local pairing is cleared by the caller regardless.
  }
}

/** The plan a membership tier resolves to right now (display name). */
export interface MembershipPlan {
  id: string;
  name: string;
  tierRank: number;
}

/** The membership slice of self/status the popup's membership bar renders. */
export interface MembershipInfo {
  tier: string;
  plan: MembershipPlan | null;
  expiresAt: string | null;
  parseWeek: { used: number; limit: number };
}

/** Result of the self/status probe: token validity + membership + writable teams. */
export interface DeviceTokenStatus {
  valid: boolean;
  /** Null when the account has no membership or the body didn't parse. */
  membership: MembershipInfo | null;
  /** Writable teams for the import destination selector; [] when none/unknown. */
  teams: TeamTarget[];
}

/**
 * Live-checks whether this device's token is still valid server-side. There's
 * no way to push a revoke notification to a browser extension, so callers
 * (popup open, capture start) poll this instead and self-heal locally on a
 * confirmed 401. Network errors / other statuses keep valid=true (can't
 * confirm revocation, so don't force a logout the user didn't cause — e.g.
 * offline).
 *
 * The same response now carries `membership` (plan tier + weekly parse usage)
 * and `teams` (writable team targets for the import destination selector); both
 * ride this existing probe so the popup's bars refresh on popup open with no
 * extra round-trip or polling loop of their own.
 */
export async function checkDeviceTokenValid(
  apiBaseUrl: string,
  deviceToken: string,
): Promise<DeviceTokenStatus> {
  try {
    const response = await fetch(`${apiBaseUrl}/api/import/extension/self/status`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
    if (response.status === 401) return { valid: false, membership: null, teams: [] };
    // membership 与 teams 同住一份 body——只读一次 JSON，两段各解析各的。
    const body = await readStatusBody(response);
    return { valid: true, membership: parseMembership(body), teams: parseTeams(body) };
  } catch {
    return { valid: true, membership: null, teams: [] };
  }
}

/** 解析 `teams`（可写团队目标）；任何畸形形态都降级为 []。 */
function parseTeams(body: Record<string, unknown> | null): TeamTarget[] {
  const raw = body?.teams;
  if (!Array.isArray(raw)) return [];
  const teams: TeamTarget[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const t = entry as Record<string, unknown>;
    if (typeof t.id !== "string" || !t.id) continue;
    teams.push({ id: t.id, name: typeof t.name === "string" ? t.name : t.id });
  }
  return teams;
}

async function readStatusBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Parse `membership` out of a self/status body; anything malformed → null. */
function parseMembership(body: Record<string, unknown> | null): MembershipInfo | null {
  try {
    const info = body?.membership;
    if (typeof info !== "object" || info === null) return null;
    const m = info as Record<string, unknown>;
    if (typeof m.tier !== "string") return null;
    const week = m.parseWeek as Record<string, unknown> | undefined;
    if (
      typeof week?.used !== "number" ||
      typeof week?.limit !== "number" ||
      !Number.isFinite(week.used) ||
      !Number.isFinite(week.limit)
    ) {
      return null;
    }
    const plan = m.plan as Record<string, unknown> | null;
    return {
      tier: m.tier,
      plan:
        plan && typeof plan === "object"
          ? {
              id: String(plan.id ?? ""),
              name: String(plan.name ?? ""),
              tierRank: Number(plan.tierRank ?? 0)
            }
          : null,
      expiresAt: typeof m.expiresAt === "string" ? m.expiresAt : null,
      parseWeek: { used: week.used, limit: week.limit },
    };
  } catch {
    return null;
  }
}

export async function extractPluginPdfCandidates(input: {
  apiBaseUrl: string;
  token: string;
  pageUrl: string;
  html: string;
}): Promise<PluginPdfCandidate[]> {
  const result = await fetchJson<{ candidates: PluginPdfCandidate[] }>(
    `${input.apiBaseUrl}/api/import/plugin/extract-pdf`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token: input.token,
        pageUrl: input.pageUrl,
        html: input.html,
      }),
    },
  );

  return result.candidates;
}

/**
 * 下载前去重预检（严格口径）：库里已有这篇且已带文件时返回 inLibrary +
 * hasContent，调用方据此跳过全文下载。设备 token Bearer 直连（票据链之外）。
 * 任何失败都抛出——调用方按「未命中」处理照旧下载，预检绝不能挡导入。
 */
export async function checkLibraryDuplicate(input: {
  apiBaseUrl: string;
  deviceToken: string;
  metadata: Record<string, unknown>;
  identifier: string | null;
}): Promise<{ inLibrary: boolean; hasContent: boolean }> {
  return fetchJson(`${input.apiBaseUrl}/api/import/plugin/duplicate-check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.deviceToken}`,
    },
    body: JSON.stringify({
      identifier: input.identifier,
      metadata: input.metadata,
    }),
  });
}

export async function uploadPluginCapture(input: {
  apiBaseUrl: string;
  token: string;
  identifier: string | null;
  originUrl: string;
  /** Authoritative translator metadata (PartialCsl); wins over server resolve. */
  metadata?: Record<string, unknown> | null;
  resolverSource?: string | null;
  /** A downloaded full-text file (PDF → MinerU, HTML full-text → html-adapter). */
  file?: PdfFileAsset | null;
  /** Raw page HTML fallback for generic sites (uploaded as an HTML asset). */
  pageHtml?: string | null;
  /** Page title — keys a webpage capture's source title server-side. */
  title?: string | null;
  /** Set on a re-submit after the user confirmed a different-file conflict. */
  replaceSourceId?: string | null;
  /** 导入目标团队；null/缺省 = 个人文库。服务端判权后把文献共享进团队空间。 */
  teamId?: string | null;
  /**
   * 全文下载被访问墙挡住的信号（有题录无 file 的降级捕获）。服务端据此不把
   * 这条 metadata-only 占位自动分享进团队，响应 teamSkipped 说明原因。
   */
  attachmentGate?: string | null;
  /** 服务端 enrich 跳过名单（白名单 openalex）；题录齐全时省服务端计量池额度。 */
  skipEnrichSources?: string[];
}): Promise<PluginCaptureResponse> {
  const form = new FormData();
  form.append("token", input.token);
  if (input.identifier) form.append("identifier", input.identifier);
  form.append("originUrl", input.originUrl);
  if (input.metadata) form.append("metadata", JSON.stringify(input.metadata));
  if (input.resolverSource) form.append("resolverSource", input.resolverSource);
  if (input.title) form.append("title", input.title);
  if (input.replaceSourceId) form.append("replaceSourceId", input.replaceSourceId);
  if (input.teamId) form.append("teamId", input.teamId);
  if (input.attachmentGate) form.append("attachmentGate", input.attachmentGate);
  if (input.skipEnrichSources?.length) {
    form.append("skipEnrichSources", input.skipEnrichSources.join(","));
  }

  if (input.file) {
    form.append(
      "file",
      new File([toArrayBuffer(input.file.bytes)], input.file.filename, {
        type: input.file.mime,
      }),
    );
  } else if (input.pageHtml) {
    form.append("pageHtml", input.pageHtml);
    form.append(
      "file",
      new File([input.pageHtml], "capture.html", { type: "text/html" }),
    );
  }

  return fetchJson(`${input.apiBaseUrl}/api/import/plugin/import`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
}

export interface AttachmentDownload {
  file: PdfFileAsset | null;
  /**
   * Set when we refused the response because it was a gate — a login wall, an
   * anti-bot challenge, a permission refusal, or a vendor error shell — not the
   * article. Distinct from "no full text offered": a gate is something the user
   * can clear (sign in, get an entitlement) and then retry via 取原文, so the
   * reason has to reach them instead of collapsing into a generic "未取到原文".
   */
  gate: GateKind | null;
  /**
   * Machine-readable failure code when `file` is null and no gate applied
   * (no-url / fetch-failed / empty-body). Surfaced into import_events so a
   * silent "no-attachment" is distinguishable from "nothing offered" in prod.
   */
  reason?: string;
}

const NOT_FOUND = (reason: string): AttachmentDownload => ({ file: null, gate: null, reason });

/**
 * Download a translator attachment with the user's cookies. PDF attachments
 * reject HTML/non-`%PDF-` responses (login walls); HTML attachments are rejected
 * when the body is a gate rather than the article — all of which arrive as a
 * normal 200 response, so only the body tells them apart (see interstitial.ts).
 * Yields no file when the fetch fails or the response isn't the article, which
 * leaves the capture metadata-only instead of filing a gate as the full text.
 */
export async function downloadAttachment(
  attachment: Attachment,
  fallbackTitle: string,
  fetchBytes: ByteFetcher,
  onProgress?: (loaded: number, total?: number) => void,
): Promise<AttachmentDownload> {
  if (!attachment.url) {
    return attachment.inlineHtml
      ? {
          file: {
            bytes: new TextEncoder().encode(attachment.inlineHtml),
            filename: attachment.filename,
            mime: attachment.mime,
          },
          gate: null,
        }
      : NOT_FOUND("no-url");
  }

  const result = await fetchBytes(attachment.url, onProgress);
  if (!result) return NOT_FOUND("fetch-failed");

  const contentType = result.contentType ?? "";
  const isHtml = /text\/html|application\/xhtml/i.test(contentType);
  if (isHtml) {
    if (attachment.kind === "pdf") {
      // Some publishers serve a PDF-viewer HTML shell at the "PDF" link instead
      // of the file — IEEE's stamp.jsp is `<iframe src=".../<id>.pdf?<jwt>">`.
      // Follow that one hop to the embedded PDF before giving up as a login wall.
      const embedded = await resolveEmbeddedPdf(attachment.url, result.bytes, fetchBytes, onProgress);
      if (embedded) {
        return {
          file: {
            bytes: embedded.bytes,
            filename: resolvePdfFilename(embedded.url, embedded.contentDisposition, fallbackTitle),
            mime: resolveDownloadMime("pdf", embedded.contentType ?? "", embedded.bytes),
          },
          gate: null,
        };
      }
      // A login/redirect page, not the PDF. Classify it so the caller can tell
      // the user *which* wall they hit; an unrecognizable one is still a wall.
      return { file: null, gate: detectGateBytes(result.bytes) ?? "login" };
    }
    const gate = detectGateBytes(result.bytes);
    if (gate) return { file: null, gate }; // login / captcha / error shell
  }

  if (!result.bytes.byteLength) return NOT_FOUND("empty-body");

  // A "PDF" that isn't PDF bytes is a gate the Content-Type didn't admit to:
  // bar.cnki.net answers a rejected order link with a login page, and object
  // stores serve error bodies as octet-stream. Uploading it would file a login
  // page as the paper's full text, so refuse and let the caller fall through to
  // the next attachment (or a metadata-only import).
  if (attachment.kind === "pdf" && !looksLikePdfBytes(result.bytes)) {
    return { file: null, gate: detectGateBytes(result.bytes) ?? "login" };
  }

  const mime = resolveDownloadMime(attachment.kind, contentType, result.bytes);

  return {
    file: {
      bytes: result.bytes,
      filename:
        attachment.kind === "html"
          ? attachment.filename
          : resolvePdfFilename(attachment.url, result.contentDisposition, fallbackTitle),
      mime,
    },
    gate: null,
  };
}

/**
 * The mime we record for downloaded bytes. `Content-Type` is a claim, and for
 * PDFs a frequently wrong one: raw.githubusercontent.com and object stores
 * answer with `application/octet-stream`. That claim rides the upload all the
 * way into the parse job, and the parser rejects anything not labelled PDF —
 * so a perfectly good paper fails to parse because of a header. The bytes have
 * already been proven to start with `%PDF-` by the time we get here, so let
 * them win; only a non-PDF body keeps the declared type.
 */
function resolveDownloadMime(
  kind: Attachment["kind"],
  contentType: string,
  bytes: Uint8Array,
): string {
  if (kind === "pdf" && looksLikePdfBytes(bytes)) return "application/pdf";
  return (
    contentType.split(";")[0]?.trim() ||
    (kind === "pdf" ? "application/pdf" : "text/html")
  );
}

/**
 * A `kind:"pdf"` attachment came back as HTML. If that HTML is a PDF-viewer
 * shell (an `<iframe>/<embed>/<object>` pointing at a `.pdf`), fetch the embedded
 * PDF one hop and return it — but only if the bytes are really a PDF (an
 * unentitled session gets another HTML paywall there, which we reject). Returns
 * null when there's no embed or the hop doesn't yield a PDF.
 */
async function resolveEmbeddedPdf(
  shellUrl: string,
  shellBytes: Uint8Array,
  fetchBytes: ByteFetcher,
  onProgress?: (loaded: number, total?: number) => void,
): Promise<{ url: string; bytes: Uint8Array; contentType: string | null; contentDisposition: string | null } | null> {
  const html = new TextDecoder("utf-8", { fatal: false }).decode(shellBytes);
  const embeddedUrl = findEmbeddedPdfUrl(html, shellUrl);
  if (!embeddedUrl) return null;

  const inner = await fetchBytes(embeddedUrl, onProgress);
  if (!inner || !inner.bytes.byteLength || !looksLikePdfBytes(inner.bytes)) return null;

  return {
    url: embeddedUrl,
    bytes: inner.bytes,
    contentType: inner.contentType,
    contentDisposition: inner.contentDisposition,
  };
}

export async function uploadOriginPdf(input: {
  apiBaseUrl: string;
  token: string;
  file: PdfFileAsset;
}): Promise<unknown> {
  const form = new FormData();
  form.append("token", input.token);
  form.append(
    "file",
    new File([toArrayBuffer(input.file.bytes)], input.file.filename, {
      type: input.file.mime,
    }),
  );

  return fetchJson(`${input.apiBaseUrl}/api/import/plugin-origin/upload`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
}

export async function reportPluginFailure(input: {
  apiBaseUrl: string;
  token: string;
  reason: string;
  originUrl: string;
  sourceId?: string;
}): Promise<void> {
  await fetchJson(`${input.apiBaseUrl}/api/import/plugin/report-failure`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      token: input.token,
      reason: input.reason,
      originUrl: input.originUrl,
      sourceId: input.sourceId,
    }),
  });
}

/**
 * 服务端 409 的错配明细（补全/更正回路）：归因 + 两边可核对的值。文件冲突
 * （另一条也带不同原文）单独一类——它不是「仍要更新」能解决的，用户要去
 * 文库决定保留哪条。
 */
export interface CompletionSubmitDetail {
  error?: string;
  reason?: "title" | "identity" | "doi";
  expectedTitle?: string | null;
  capturedTitle?: string | null;
  expectedDoi?: string | null;
  capturedDoi?: string | null;
  conflictTitle?: string | null;
}

/**
 * 补全/更正回路回填的失败分类：服务端状态码与 body 决定重试策略——409 错配
 * （用户核对后可「仍要更新」重试）、409 文件冲突（回文库处理重复条目）、
 * 401 票据失效（只能回文库重新发起）、其余（网络/5xx）原样重试。
 * fetchJson 只抛 message，这里补回状态码与结构化明细。
 */
export class CompletionSubmitError extends Error {
  readonly status: number;
  readonly detail: CompletionSubmitDetail | null;

  constructor(status: number, message: string, detail: CompletionSubmitDetail | null = null) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** fetchJson 的失败载体：message 面向用户/日志，status/body 供调用方分支。 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown> | null;

  constructor(status: number, message: string, body: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * 补全/更正回路回填（#100 D1）：把 translator 在原站详情页认出的题录用一次性
 * 补全票回填到票面指定的 source。票据即鉴权；sourceId 与票面不一致由服务端
 * 强制（不一致 401）。票在提交时原子抢占：同一张票的并发回填只有一个成功；
 * 回填失败时票原样归还——409 错配不吞票，allowMismatch 重试或换页重抓都带
 * 同一张票。absorbedTitles 是撞库合并时被吸收条目的题名（确认卡说明实际
 * 合并对象用）。
 */
export async function completeOriginMetadata(input: {
  apiBaseUrl: string;
  token: string;
  sourceId: string;
  metadata: Record<string, unknown>;
  resolverSource: string;
  originUrl: string | null;
  allowMismatch?: boolean;
}): Promise<{
  appliedFields: string[];
  needsCompletion: boolean;
  absorbedSourceIds: string[];
  absorbedTitles?: string[];
}> {
  try {
    return await fetchJson(`${input.apiBaseUrl}/api/import/plugin-origin/metadata`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token: input.token,
        sourceId: input.sourceId,
        metadata: input.metadata,
        resolverSource: input.resolverSource,
        originUrl: input.originUrl,
        ...(input.allowMismatch ? { allowMismatch: true } : {}),
      }),
    });
  } catch (error) {
    if (error instanceof ApiRequestError) {
      throw new CompletionSubmitError(
        error.status,
        error.message,
        error.body as CompletionSubmitDetail | null,
      );
    }
    throw error;
  }
}

export interface PluginImportEventItem {
  step: string;
  status: "ok" | "failed" | "info";
  reason?: string;
  detail?: Record<string, unknown>;
  occurredAt?: string;
}

/**
 * 导入日志：把插件端关键步骤上报到服务端 import_events。
 * 观测绝不影响主流程——任何失败都静默吞掉。
 */
export async function reportPluginEvents(input: {
  apiBaseUrl: string;
  token: string;
  sourceId?: string;
  events: PluginImportEventItem[];
}): Promise<void> {
  if (input.events.length === 0) return;
  try {
    await fetchJson(`${input.apiBaseUrl}/api/import/plugin/report-event`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token: input.token,
        sourceId: input.sourceId,
        events: input.events,
      }),
    });
  } catch {
    // fire-and-forget
  }
}

export async function downloadPdfCandidate(
  candidate: PluginPdfCandidate,
  fallbackTitle: string,
  fetchBytes: ByteFetcher,
  onProgress?: (loaded: number, total?: number) => void,
): Promise<{ file: PdfFileAsset | null; reason?: string }> {
  const result = await fetchBytes(candidate.url, onProgress);
  if (!result) return { file: null, reason: "fetch-failed" };

  const contentType = result.contentType ?? "";
  if (/text\/html|application\/html/i.test(contentType)) {
    return { file: null, reason: "html-shell" };
  }

  if (!result.bytes.byteLength) {
    return { file: null, reason: "empty-body" };
  }

  return {
    file: {
      bytes: result.bytes,
      filename: resolvePdfFilename(candidate.url, result.contentDisposition, fallbackTitle),
      mime: contentType || "application/pdf",
    },
  };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const { message, body } = await readErrorResponse(response);
    throw new ApiRequestError(response.status, message || `request_failed:${response.status}`, body);
  }
  return response.json() as Promise<T>;
}

async function readErrorResponse(
  response: Response,
): Promise<{ message: string; body: Record<string, unknown> | null }> {
  try {
    const json = (await response.json()) as Record<string, unknown> | null;
    if (!json || typeof json !== "object") {
      return { message: response.statusText, body: null };
    }
    return {
      message: typeof json.message === "string" ? json.message : "",
      body: json,
    };
  } catch {
    return { message: response.statusText, body: null };
  }
}

export function resolvePdfFilename(
  candidateUrl: string,
  contentDisposition: string | null,
  fallbackTitle: string,
): string {
  const encodedMatch = contentDisposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encodedMatch) {
    return decodeURIComponent(encodedMatch);
  }

  const plainMatch = contentDisposition?.match(/filename="?([^"]+)"?/i)?.[1];
  if (plainMatch) {
    return plainMatch;
  }

  try {
    const pathname = new URL(candidateUrl).pathname.split("/").filter(Boolean).at(-1);
    if (pathname) {
      // URL path segments arrive percent-encoded — local files (file:///D:/…)
      // always, publisher URLs usually. The filename rides into the upload and
      // becomes the library's interim title, so decode it into a human name
      // instead of a %E4%BA%A7… soup.
      const segment = safeDecodePathSegment(pathname);
      return segment.endsWith(".pdf") ? segment : `${segment}.pdf`;
    }
  } catch {
    // ignore invalid URLs; fall back to title
  }

  const slug = fallbackTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "article"}.pdf`;
}

function safeDecodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // stray '%' — keep the raw segment
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
