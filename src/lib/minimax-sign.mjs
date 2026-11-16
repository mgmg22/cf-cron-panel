// MiniMax 请求签名的共享实现：Worker（src/tasks/minimax.ts）与 scripts/export-env.mjs 共用，
// 避免两处各抄一份导致签名/设备参数改动漏同步。纯 JS、无依赖；MD5 由调用方注入
// （Worker 用自带 md5hex，Node 脚本用 node:crypto）。

export const HOST = "https://agent.minimax.io";

// 稳定的默认设备身份：仅在未设置对应变量时回落使用，避免设备指纹漂移
export const DEFAULT_UUID = "3548c8fa-9ac2-4a28-8f6b-71ecd88bc048";
export const DEFAULT_DEVICE_ID = "1790426211";

const DEVICE_PARAM_ORDER = [
  "device_platform", "biz_id", "app_id", "version_code", "unix",
  "timezone_offset", "is_desktop", "desktop_version", "sys_language",
  "lang", "uuid", "device_id", "os_name", "browser_name", "device_memory",
  "cpu_core_num", "browser_language", "browser_platform", "user_id",
  "op_ticket", "screen_width", "screen_height",
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MiniMaxAgent/desktop Chrome/124.0 Safari/537.36";

/** 须与 Python urllib.parse.quote_plus 一致（签名依赖）：仅字母数字 + _ . - ~ 不转义，空格 -> +，其余按 UTF-8 字节 %XX。 */
export function pyQuotePlus(s) {
  let out = "";
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9_.\-~]/.test(c)) out += c;
    else if (b === 0x20) out += "+";
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

export function buildDeviceParams(userId, uuid, deviceId) {
  const v = {
    device_platform: "web", biz_id: "3", app_id: "3001", version_code: "22201",
    unix: String(Date.now()), timezone_offset: "28800", is_desktop: "1", desktop_version: "",
    sys_language: "en", lang: "en", uuid, device_id: deviceId,
    os_name: "Windows", browser_name: "Chrome", device_memory: "16", cpu_core_num: "4",
    browser_language: "zh-CN", browser_platform: "Win32", user_id: userId,
    op_ticket: "undefined", screen_width: "1536", screen_height: "864",
  };
  const out = {};
  for (const k of DEVICE_PARAM_ORDER) out[k] = v[k];
  return out;
}

/** 生成带 yy / x-signature 的请求（url、headers、bodyStr）。md5hex 由调用方注入。 */
export function signRequest(path, token, params, method, body, md5hex) {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  // 设备参数里 unix 必须与签名用的 nowMs 完全一致
  const p = { ...params, unix: String(nowMs), client: "desktop" };
  const query = Object.entries(p).map(([k, v]) => `${pyQuotePlus(k)}=${pyQuotePlus(v)}`).join("&");
  const isGet = method.toLowerCase() === "get";
  const bodyStr = isGet ? "" : JSON.stringify(body || {});

  const headers = {
    authorization: `Bearer ${token}`,
    yy: md5hex(encodeURIComponent(`${path}?${query}`) + "_" + "{}" + md5hex(String(nowMs)) + "ooui"),
    "x-timestamp": String(nowSec),
    "x-signature": md5hex(`${nowSec}I*7Cf%WZ#S&%1RlZJ&C2${bodyStr}`),
    origin: HOST,
    referer: HOST + "/",
    "user-agent": USER_AGENT,
  };
  if (!isGet) headers["content-type"] = "application/json";
  return { url: `${HOST}${path}?${query}`, headers, bodyStr };
}
