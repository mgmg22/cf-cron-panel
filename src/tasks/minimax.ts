/// MiniMax Code 每日签到任务（OAuth2 设备授权版）。
/// 上游已把鉴权从「本地 JWT + token: 头 + /v1/api/user/renewal 续期」换成
/// 「OAuth2 设备授权 + Authorization: Bearer mmoat_...」，旧链路一律 401。
///
/// 长效凭据是 --login-minimax 设备授权拿到的独立 refresh token（存 Secret MINIMAX_REFRESH_TOKEN）。
/// 每次运行：KV 中缓存的 accessToken 未过期就直接用；否则调 oauth2/token 刷新。
/// refresh token 会轮换且有重用检测，所以刷新成功后必须立刻把新 rt 写回 KV；
/// 缓存优先 + 尽量少刷新，避免两次运行并发刷新同一个 rt 导致凭据家族作废。
/// 签到接口的 yy / x-signature 签名见 signRequest（与鉴权头无关，保持不变）。

import type { CheckinResult, Env } from "../types";
import { md5hex } from "../lib/md5";
import { requestJson } from "../lib/http";
import { kvReadJson, kvWriteJson } from "../lib/kv";
import { apiSucceeded, isAuthStatus, isTransientStatus } from "../lib/api";

const HOST = "https://agent.minimax.io";
const STATUS_PATH = "/minimax-cloud/api/v1/signin/status";
const CLAIM_PATH = "/minimax-cloud/api/v1/signin/claim";

// 与桌面端 MiniMax Code 一致的标准 OAuth2 配置（逆向自 app.asar / mcode-tools）
const OAUTH_TOKEN_URL = "https://account.minimax.io/oauth2/token";
const OAUTH_CLIENT_ID = "mcode-public";
const OAUTH_SCOPE = "agent.default";
const OAUTH_AUDIENCE = "agent-backend";
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 上游 access token 默认 12 小时
const REFRESH_SKEW_MS = 5 * 60 * 1000; // 到期前 5 分钟就刷新，留足余量

const STORE_KEY = "minimax";

const DEVICE_PARAM_ORDER = [
  "device_platform", "biz_id", "app_id", "version_code", "unix",
  "timezone_offset", "is_desktop", "desktop_version", "sys_language",
  "lang", "uuid", "device_id", "os_name", "browser_name", "device_memory",
  "cpu_core_num", "browser_language", "browser_platform", "user_id",
  "op_ticket", "screen_width", "screen_height",
];

// 稳定的默认设备身份：仅在未设置对应变量时回落使用，避免设备指纹漂移
const DEFAULT_UUID = "3548c8fa-9ac2-4a28-8f6b-71ecd88bc048";
const DEFAULT_DEVICE_ID = "1790426211";

const AUTH_FAIL_KEYWORDS = ["unauthorized", "expired", "not login",
  "not logged", "登录", "鉴权", "invalid token", "token invalid", "异常用户"];
const RATE_LIMIT_KEYWORDS = ["频繁", "frequent", "too many", "太多", "稍后再试",
  "繁忙", "busy", "limit"];

/** 清洗变量：去首尾空白、去误粘贴的成对引号（手填变量最常见的 401 原因）。 */
export function cleanValue(raw: string): string {
  let s = (raw || "").trim();
  while (s.length >= 2 && s[0] === s[s.length - 1] && (s[0] === "'" || s[0] === '"')) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export function pyQuotePlus(s: string): string {
  // 须与 Python urllib.parse.quote_plus 的结果一致（签名依赖）：仅字母数字 + _ . - ~ 不转义，
  // 空格 -> +，其余字符按 UTF-8 字节逐个 %XX（大写十六进制）
  let out = "";
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9_.\-~]/.test(c)) out += c;
    else if (b === 0x20) out += "+";
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function buildDeviceParams(userId: string, uuid: string, deviceId: string): Record<string, string> {
  const nowMs = Date.now();
  const v: Record<string, string> = {
    device_platform: "web",
    biz_id: "3",
    app_id: "3001",
    version_code: "22201",
    unix: String(nowMs),
    timezone_offset: "28800",
    is_desktop: "1",
    desktop_version: "",
    sys_language: "en",
    lang: "en",
    uuid,
    device_id: deviceId,
    os_name: "Windows",
    browser_name: "Chrome",
    device_memory: "16",
    cpu_core_num: "4",
    browser_language: "zh-CN",
    browser_platform: "Win32",
    user_id: userId,
    op_ticket: "undefined",
    screen_width: "1536",
    screen_height: "864",
  };
  const out: Record<string, string> = {};
  for (const k of DEVICE_PARAM_ORDER) out[k] = v[k];
  return out;
}

interface Signed {
  url: string;
  headers: Record<string, string>;
  bodyStr: string;
}

/** 新版只认 Authorization: Bearer；旧 token: 头已废弃（实测单独 Bearer 亦为 200）。 */
export function buildAuthHeader(token: string): string {
  return `Bearer ${token}`;
}

function signRequest(path: string, token: string, params: Record<string, string>, method: string, body: any): Signed {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  // 设备参数里 unix 必须与签名用的 nowMs 完全一致
  const p = { ...params, unix: String(nowMs), client: "desktop" };
  const query = Object.entries(p)
    .map(([k, v]) => `${pyQuotePlus(k)}=${pyQuotePlus(v)}`)
    .join("&");
  const hasSearchParamsPath = `${path}?${query}`;
  const bodyStr = method.toLowerCase() === "get" ? "" : JSON.stringify(body || {});

  const xSignature = md5hex(`${nowSec}I*7Cf%WZ#S&%1RlZJ&C2${bodyStr}`);
  const yy = md5hex(
    encodeURIComponent(hasSearchParamsPath) + "_" + "{}" + md5hex(String(nowMs)) + "ooui",
  );

  const headers: Record<string, string> = {
    authorization: buildAuthHeader(token),
    yy,
    "x-timestamp": String(nowSec),
    "x-signature": xSignature,
    origin: "https://agent.minimax.io",
    referer: "https://agent.minimax.io/",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MiniMaxAgent/desktop Chrome/124.0 Safari/537.36",
  };
  if (method.toLowerCase() !== "get") headers["content-type"] = "application/json";
  return { url: HOST + path + "?" + query, headers, bodyStr };
}

function apiCall(signed: Signed, method: string): Promise<[number, any]> {
  const isGet = method.toLowerCase() === "get";
  return requestJson(signed.url, method, signed.headers, isGet ? undefined : signed.bodyStr);
}

function isAuthFailure(sc: number, d: any): boolean {
  if (isAuthStatus(sc)) return true;
  const code = d?.code;
  if (typeof code === "number" && (code === 401 || code === 403)) return true;
  const si = d?.statusInfo;
  if (si && (si.code === 1000021 || si.code === 1000022 || si.code === 1000023)) return true;
  const msg = String(d?.message || d?.msg || "").toLowerCase();
  // 命中限频词先排除，避免"请求过于频繁"被误判为鉴权失败
  if (RATE_LIMIT_KEYWORDS.some((k) => msg.includes(k))) return false;
  return AUTH_FAIL_KEYWORDS.some((k) => msg.includes(k));
}

function isRateLimited(sc: number, d: any): boolean {
  if (isTransientStatus(sc)) return true;
  const msg = String(d?.message || d?.msg || "");
  return RATE_LIMIT_KEYWORDS.some((k) => msg.includes(k));
}

function serverMsg(d: any): string {
  const si = d?.statusInfo;
  if (si?.message) return si.message;
  const br = d?.base_resp;
  if (br?.status_msg && br.status_code !== 0) return `${br.status_msg}(code=${br.status_code})`;
  return String(d?.message || d?.msg || "");
}

// ---- OAuth2 凭据 ----

/** KV 中的滚动凭据。旧结构 {token, updated_at}（JWT 时代）会被忽略，避免拿废弃 token 去刷新。 */
export interface MiniMaxAuth {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  updated_at: number;
}

export function readCachedAuth(raw: any): MiniMaxAuth | null {
  if (!raw || typeof raw !== "object") return null;
  const accessToken = typeof raw.accessToken === "string" ? raw.accessToken.trim() : "";
  const refreshToken = typeof raw.refreshToken === "string" ? raw.refreshToken.trim() : "";
  if (!accessToken && !refreshToken) return null;
  const expiresAtMs = Number(raw.expiresAtMs) || 0;
  return { accessToken, refreshToken, expiresAtMs, updated_at: Number(raw.updated_at) || 0 };
}

function authAlive(a: MiniMaxAuth): boolean {
  return !!a.accessToken && a.expiresAtMs - Date.now() > REFRESH_SKEW_MS;
}

export function oauthForm(values: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) p.set(k, v);
  return p.toString();
}

/** 把 oauth2/token 的响应解析成滚动凭据；refresh_token 缺省时沿用旧值。 */
export function parseTokenGrant(d: any, fallbackRefreshToken: string): MiniMaxAuth | null {
  const accessToken = typeof d?.access_token === "string" ? d.access_token.trim() : "";
  if (!accessToken) return null;
  const rotated = typeof d?.refresh_token === "string" ? d.refresh_token.trim() : "";
  const sec = Number(d?.expires_in);
  const ttlMs = Number.isFinite(sec) && sec > 0 ? sec * 1000 : DEFAULT_TTL_MS;
  return {
    accessToken,
    refreshToken: rotated || fallbackRefreshToken,
    expiresAtMs: Date.now() + ttlMs,
    updated_at: Date.now(),
  };
}

function oauthError(sc: number, d: any): string {
  const parts = [d?.error, d?.error_description, d?.message, d?.msg, d?.statusInfo?.message]
    .filter((x) => typeof x === "string" && x.trim())
    .map(String);
  return parts.join(" / ") || (sc ? `HTTP ${sc}` : "网络异常");
}

const OAUTH_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "Content-Type": "application/x-www-form-urlencoded",
};

interface TokenResolution {
  token: string;
  source: string;
  refreshed: boolean;
  warnings: string[];
  error: string;
}

/**
 * 取一个可用的 accessToken：优先复用 KV 缓存（避免无谓轮换），否则用 refresh token 换新并立刻写回 KV。
 * force=true 用于「缓存 token 被服务端判为鉴权失败」时强制刷新一次。
 */
async function resolveAccessToken(env: Env, force = false): Promise<TokenResolution> {
  const warnings: string[] = [];
  const readCache = async () => readCachedAuth((await kvReadJson<any>(env.CHECKIN_STATE, STORE_KEY)).value);
  const cache = await readCache();

  if (!force && cache && authAlive(cache)) {
    return { token: cache.accessToken, source: "KV 缓存", refreshed: false, warnings, error: "" };
  }

  // KV 里轮换过的 rt 优先，Secret 里的初始 rt 兜底（KV 丢失时可能已失效）
  const refreshTokens: string[] = [];
  for (const [rt, tag] of [[cache?.refreshToken || "", "KV 缓存"], [cleanValue(env.MINIMAX_REFRESH_TOKEN || ""), "环境变量"]] as [string, string][]) {
    if (rt && !refreshTokens.includes(rt)) refreshTokens.push(rt);
  }

  const failures: string[] = [];
  for (const rt of refreshTokens) {
    const [sc, d] = await requestJson(OAUTH_TOKEN_URL, "POST", OAUTH_HEADERS, oauthForm({
      grant_type: "refresh_token",
      refresh_token: rt,
      client_id: OAUTH_CLIENT_ID,
      scope: OAUTH_SCOPE,
      audience: OAUTH_AUDIENCE,
    }));
    const grant = sc > 0 && sc < 400 ? parseTokenGrant(d, rt) : null;
    if (grant) {
      const err = await kvWriteJson(env.CHECKIN_STATE, STORE_KEY, grant);
      if (err) warnings.push(`刷新成功但 KV 写入失败：${err}（下次运行可能需要重新授权）`);
      console.log(`[miniMax] OAuth2 刷新成功，新凭据已写回 KV`);
      return { token: grant.accessToken, source: "OAuth2 刷新", refreshed: true, warnings, error: "" };
    }
    failures.push(oauthError(sc, d));
    // 可能另一个运行刚刚刷新并写好了 KV：立刻改用它的新 token，避免继续用已作废的 rt
    const fresh = await readCache();
    if (fresh && authAlive(fresh) && fresh.accessToken !== cache?.accessToken) {
      return { token: fresh.accessToken, source: "KV 缓存（并发刷新）", refreshed: false, warnings, error: "" };
    }
  }

  // 刷新失败时的最后兜底：环境变量里直接给的 mmoat_ token（或 KV 里的旧 token，服务端可能仍有宽限）
  const direct = [cleanValue(env.MINIMAX_ACCESS_TOKEN || ""), cleanValue(env.MINIMAX_TOKEN || "")]
    .filter((t) => t.startsWith("mmoat_"));
  if (direct.length) {
    warnings.push(`refresh token 刷新失败（${failures.join("；") || "未配置"}），本次改用环境变量 accessToken`);
    return { token: direct[0], source: "环境变量 accessToken", refreshed: false, warnings, error: "" };
  }
  if (cache?.accessToken) {
    warnings.push(`refresh token 刷新失败（${failures.join("；") || "未配置"}），本次沿用已过期的缓存 token`);
    return { token: cache.accessToken, source: "KV 缓存（可能已过期）", refreshed: false, warnings, error: "" };
  }

  const legacy = cleanValue(env.MINIMAX_TOKEN || "");
  const legacyHint = legacy && !legacy.startsWith("mmoat_") ? "（当前 MINIMAX_TOKEN 是旧版 JWT，上游已停用）" : "";
  return {
    token: "",
    source: "",
    refreshed: false,
    warnings,
    error: `MiniMax OAuth2 凭据不可用：${failures.join("；") || "未找到 refresh token"}${legacyHint}。`,
  };
}

/** 用指定 accessToken 走一遍「状态 -> 领取」。 */
async function tryCheckin(params: Record<string, string>, token: string): Promise<CheckinResult> {
  // 1) 状态查询（GET）
  const [sc, sb] = await apiCall(signRequest(STATUS_PATH, token, params, "GET", {}), "GET");
  if (isAuthFailure(sc, sb)) {
    return { flag: "AUTH_EXPIRED", content: `⚠️ 鉴权失败：${serverMsg(sb) || `HTTP ${sc}`}` };
  }
  if (isRateLimited(sc, sb)) {
    return { flag: "RATE_LIMITED", content: `⏳ 服务端限频：${serverMsg(sb) || `HTTP ${sc}`}，建议错峰或稍后重试` };
  }
  if (!apiSucceeded(sb)) {
    return { flag: "STATUS_ERR", content: `⚠️ 状态查询异常：HTTP ${sc} ${serverMsg(sb) || JSON.stringify(sb).slice(0, 150)}` };
  }
  // 解析今日签到状态：days[] 中 is_today=true 的那天，status==3 表示已领取
  const days = sb?.data?.days || [];
  const today = days.find((d: any) => d.is_today);
  if (today && today.status === 3) {
    return { flag: "ALREADY_TODAY", content: `ℹ️ 今日已签到（第 ${today.day_no} 天）` };
  }

  // 2) 领取（POST，body {}）
  const [cc, cb] = await apiCall(signRequest(CLAIM_PATH, token, params, "POST", {}), "POST");
  if (isAuthFailure(cc, cb)) {
    return { flag: "AUTH_EXPIRED", content: `⚠️ 鉴权失败：${serverMsg(cb) || `HTTP ${cc}`}` };
  }
  if (isRateLimited(cc, cb)) {
    const msg = serverMsg(cb) || JSON.stringify(cb).slice(0, 120);
    return { flag: "RATE_LIMITED", content: `⏳ 服务端限频：${msg}，建议错峰或稍后重试` };
  }
  if (apiSucceeded(cb)) {
    // 解析领取结果：claim_result 1=新领取成功，2=今日已领取
    const cdata = cb?.data || {};
    if (cdata.claim_result === 2) {
      return { flag: "ALREADY_TODAY", content: `ℹ️ 今日已签到（claim_result=2）` };
    }
    const gain = cdata.points != null ? `本次 +${cdata.points} 积分` : "签到成功";
    return { flag: "SUCCESS", content: `✅ ${gain}（第 ${cdata.day_no} 天）` };
  }
  return { flag: "FAIL", content: `⚠️ 领取未成功：HTTP ${cc} ${serverMsg(cb) || JSON.stringify(cb).slice(0, 150)}` };
}

export async function run(env: Env): Promise<CheckinResult> {
  const user_id = cleanValue(env.MINIMAX_USER_ID || "");
  const uuid = cleanValue(env.MINIMAX_UUID || "") || DEFAULT_UUID;
  const device_id = cleanValue(env.MINIMAX_DEVICE_ID || "") || DEFAULT_DEVICE_ID;
  if (!user_id) {
    return { flag: "NO_CREDENTIAL", content: "未设置 MINIMAX_USER_ID，请先配置 MiniMax 用户 ID" };
  }

  const params = buildDeviceParams(user_id, uuid, device_id);
  const resolution = await resolveAccessToken(env);
  for (const w of resolution.warnings) console.warn(`[miniMax] ${w}`);
  if (resolution.error) {
    return {
      flag: "AUTH_EXPIRED",
      content: `⚠️ ${resolution.error}｜处理：在项目目录运行 node scripts/export-env.mjs --login-minimax --push 完成一次浏览器授权（生成独立 refresh token，不影响桌面端登录）`,
    };
  }

  let r: CheckinResult;
  try {
    r = await tryCheckin(params, resolution.token);
  } catch (e: any) {
    return { flag: "ERROR", content: `⚠️ 执行异常：${e?.message || e}` };
  }

  // 缓存 token 被服务端拒绝时，强制刷新一次再试（正常路径每天只在 token 到期时刷新）
  if (r.flag === "AUTH_EXPIRED" && !resolution.refreshed) {
    console.log(`[miniMax] 缓存 token 鉴权失败，强制刷新后重试一次`);
    const forced = await resolveAccessToken(env, true);
    for (const w of forced.warnings) console.warn(`[miniMax] ${w}`);
    if (!forced.error) {
      try {
        r = await tryCheckin(params, forced.token);
      } catch (e: any) {
        r = { flag: "ERROR", content: `⚠️ 强制刷新后执行异常：${e?.message || e}` };
      }
    } else {
      r = { flag: "AUTH_EXPIRED", content: `⚠️ ${forced.error}` };
    }
  }

  if (r.flag === "AUTH_EXPIRED") {
    r = {
      flag: r.flag,
      content: r.content +
        "｜处理：运行 node scripts/export-env.mjs --login-minimax --push 重新授权；若刚授权仍 401，多为出口 IP 被风控",
    };
  }
  return r;
}
