#!/usr/bin/env node
// 从本机已登录的桌面端读取 WorkBuddy / Trae / MiniMax 的登录态，导出 Worker 所需变量，
// 可选直接推送到 Cloudflare Secrets（wrangler secret put）。
//
// 用法：
//   node scripts/export-env.mjs                          # 打印 KEY=VALUE（stdout），诊断信息走 stderr
//   node scripts/export-env.mjs --only trae,minimax      # 只处理指定应用（workbuddy / trae / minimax）
//   node scripts/export-env.mjs --mask                   # 值只显示首尾几位，便于检查
//   node scripts/export-env.mjs --json                   # 以 JSON 输出
//   node scripts/export-env.mjs --push [--worker 名称]   # 推送到 Cloudflare Secrets
//   node scripts/export-env.mjs --login-workbuddy        # WorkBuddy 改用浏览器授权登录获取令牌
//   node scripts/export-env.mjs --login-workbuddy --wb2 --only workbuddy --push  # 给账号 2 授权并导出 WB2_*
//   node scripts/export-env.mjs --login-minimax [--push] # MiniMax 用 OAuth2 设备授权获取独立 refresh token（默认只处理 minimax）
//   node scripts/export-env.mjs --login-minimax --resume # 中断后续接等待授权（device_code 仍在有效期内）
//   node scripts/export-env.mjs --login-minimax --minimax-user-id <id>  # 指定签到用用户 ID（也可用 MINIMAX_USER_ID 环境变量或 .dev.vars）
//
// MiniMax 新版桌面端（MiniMax Code）已改为 OAuth2 设备授权，旧 minimax-agent-config.json 里不再有 token；
// --only minimax 会直接提示改用 --login-minimax。设备授权得到的是独立于桌面端会话的 refresh token，
// Worker 每次运行自行刷新并把轮换后的值写入 KV，不会把桌面端挤下线。
//
// WorkBuddy 支持双账号：账号 1 用 WB_*，账号 2 用 WB2_*（不配 WB2_* 则只跑账号 1）。
// --wb2 把 WorkBuddy 的输出键整体映射为 WB2_*，用于给账号 2 单独授权；授权时浏览器必须处于
// 账号 2 的登录态（建议开无痕窗口），若取到的 uid 与 .dev.vars 里账号 1 相同会直接报错。
// --wb2 --push 只推送本次产出的 WB2_*，不会顺带覆盖账号 1 或其他 shell 环境变量。
//
// --push 时，以下无法从本机读取的变量若已在当前 shell 环境中设置，也会一并推送（优先于本机读取值）：
//   WB_ACCESS_TOKEN / WB_REFRESH_TOKEN / NOTIFY_PUSH_KEY / API_KEY / API_URL / XB_BOT_TOKEN / XB_BOT_TOKEN_SECRET /
//   ADMIN_PASSWORD（面板登录密码）/ MINIMAX_USER_ID
//   例：API_KEY=xxx API_URL=https://... node scripts/export-env.mjs --push
//
// 登录态路径覆盖：--workbuddy-info / --trae-storage / --minimax-config <文件路径>
// 仅依赖 Node >= 18 内置模块。导出的值包含访问令牌与设备私钥，注意不要写入仓库或日志。

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 无法从本机读取、或本机读不到时由 shell 环境变量显式提供的变量（--push 时一并推送，环境变量优先于本机读取值）
const EXTRA_KEYS = ["WB_ACCESS_TOKEN", "WB_REFRESH_TOKEN", "NOTIFY_PUSH_KEY", "API_KEY", "API_URL", "XB_BOT_TOKEN", "XB_BOT_TOKEN_SECRET", "ADMIN_PASSWORD", "MINIMAX_USER_ID"];

// ---- 参数 ----

function parseArgs(argv) {
  const opts = { only: null, mask: false, json: false, push: false, loginWorkbuddy: false, loginMinimax: false, workbuddySlot2: false, resume: false, minimaxUserId: "", worker: "", paths: {} };
  const valueOf = (i, name) => {
    if (i + 1 >= argv.length) fail(`${name} 需要一个值`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mask") opts.mask = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--push") opts.push = true;
    else if (a === "--login-workbuddy") opts.loginWorkbuddy = true;
    else if (a === "--wb2") opts.workbuddySlot2 = true;
    else if (a === "--login-minimax") opts.loginMinimax = true;
    else if (a === "--resume") opts.resume = true;
    else if (a === "--minimax-user-id") opts.minimaxUserId = valueOf(i++, a);
    else if (a === "--worker") opts.worker = valueOf(i++, a);
    else if (a === "--only") opts.only = valueOf(i++, a).split(",").map((s) => s.trim().toLowerCase());
    else if (a === "--workbuddy-info") opts.paths.workbuddy = valueOf(i++, a);
    else if (a === "--trae-storage") opts.paths.trae = valueOf(i++, a);
    else if (a === "--minimax-config") opts.paths.minimax = valueOf(i++, a);
    else if (a === "-h" || a === "--help") {
      console.error(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 32).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
      process.exit(0);
    } else fail(`未知参数：${a}`);
  }
  return opts;
}

function fail(msg) {
  console.error(`错误：${msg}`);
  process.exit(2);
}

const log = (msg) => console.error(msg);

// ---- 通用工具 ----

/** 桌面端配置根目录候选：Windows 的 APPDATA/LOCALAPPDATA、macOS 的 Application Support、Linux 的 ~/.config。 */
function configRoots() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean);
  }
  if (process.platform === "darwin") return [path.join(home, "Library", "Application Support")];
  return [path.join(home, ".config")];
}

function firstExisting(candidates) {
  return candidates.find((f) => fs.existsSync(f) && fs.statSync(f).isFile()) || null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** 解码 JWT 的 exp（毫秒），失败返回 0。 */
function jwtExpMs(token) {
  try {
    const part = String(token).split(".")[1];
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return Number(payload.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

function parseTimeMs(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return value;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

function expText(ms) {
  if (!ms) return "过期时间未知";
  const days = (ms - Date.now()) / 86400000;
  const at = new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  return days > 0 ? `剩余 ${days.toFixed(1)} 天（UTC ${at}）` : `已于 ${(-days).toFixed(1)} 天前过期（UTC ${at}）`;
}

// ---- WorkBuddy ----

function exportWorkbuddy(override) {
  const rel = ["CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"];
  const file = override || firstExisting(configRoots().map((r) => path.join(r, ...rel)));
  if (!file) throw new Error("未找到 workbuddy-desktop.info，请先登录 WorkBuddy 桌面端（v5.3.8+），或用 --workbuddy-info 指定");
  const j = readJson(file);
  const uid = String(j.account?.uid ?? "").trim();
  if (!uid) throw new Error(`${file} 中缺少 account.uid`);
  const values = { WB_USER_ID: uid };
  const domain = String(j.auth?.domain || "").trim();
  if (domain) values.WB_DOMAIN = domain;

  const raw = j.auth?.accessToken;
  if (typeof raw === "string" && raw.trim()) {
    values.WB_ACCESS_TOKEN = raw.trim();
    const exp = jwtExpMs(values.WB_ACCESS_TOKEN);
    log(`[workbuddy] 读取 ${file}${exp ? `；token ${expText(exp)}` : ""}`);
  } else {
    // 桌面端把 accessToken 加密存储（{ $wbEncrypted, envelope }，密钥不在该文件内），无法从文件直接读取
    log(`[workbuddy] 读取 ${file}：accessToken 已被桌面端加密，只导出 WB_USER_ID / WB_DOMAIN；` +
      "WB_ACCESS_TOKEN 可用 --login-workbuddy 通过浏览器授权登录获取，或手动设置环境变量后 --push");
  }
  return values;
}

/** WorkBuddy 浏览器授权登录（设备授权流程）：取 state 与授权链接 → 用户在浏览器登录 → 轮询换取令牌。
 *  WB_API 是设备授权专用端点（copilot.tencent.com），与 Worker 调用的业务主域（www.workbuddy.cn）
 *  无关——授权在这域、业务在那域，都是官方客户端的固定行为。
 *  platform/UA/头族必须与官方桌面端一致：上游网关按客户端形态风控，形态不符时 token 签发
 *  出来也无法调用业务接口（401）。 */
const WB_API = "https://copilot.tencent.com"; // 设备授权专用端点（业务主域在 Worker 侧：www.workbuddy.cn）
const WB_PLATFORM = "workbuddy"; // 设备授权 platform 参数（桌面端口径）
const WB_UA = "WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0"; // 桌面端 RPC 族 UA
const WB_CODE_PENDING = new Set([11217, 12151]); // 登录尚未完成，继续轮询
const WB_CODE_FATAL = new Set([12005, 11212, 11216]); // 席位已满 / 许可过期 / 试用过期，直接失败
const WB_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const WB_POLL_INTERVAL_MS = 3000;

function wbHeaders(extra) {
  return {
    Accept: "application/json, text/plain, */*",
    "User-Agent": WB_UA,
    "X-Product": "SaaS",
    "X-Request-ID": crypto.randomBytes(16).toString("hex"),
    ...extra,
  };
}

async function wbRequest(method, url, headers, body) {
  const res = await fetch(url, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await res.text();
  let respBody;
  try {
    respBody = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}，响应不是 JSON：${text.slice(0, 120)}`);
  }
  if (res.status >= 400) throw new Error(`HTTP ${res.status}：${respBody?.msg || text.slice(0, 120)}`);
  return respBody; // { code, msg, data }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loginWorkbuddy() {
  // 设备码三端点头族（真机形态）：state/account 带 X-Domain 与 X-No-* 哨兵，
  // token 只带哨兵；均不带 Content-Type（GET 无 body）。
  const st = await wbRequest("POST", `${WB_API}/v2/plugin/auth/state?platform=${WB_PLATFORM}`, wbHeaders({
    "Content-Type": "application/json",
    "X-Domain": "www.workbuddy.cn",
    "X-Custom-Channel-Id": "unknown",
    "X-No-User-Id": "true",
    "X-No-Enterprise-Id": "true",
    "X-No-Department-Info": "true",
    "X-No-Authorization": "true",
  }));
  if (st.code !== 0 || !st.data?.state || !st.data?.authUrl) {
    throw new Error(`获取授权链接失败：code=${st.code} ${st.msg || ""}`);
  }
  log("[workbuddy] 请在浏览器打开下面的链接并完成登录（5 分钟内有效）：");
  log(st.data.authUrl.toString());

  const state = encodeURIComponent(st.data.state);
  const deadline = Date.now() + WB_LOGIN_TIMEOUT_MS;
  let tok = null;
  while (Date.now() < deadline) {
    const r = await wbRequest("GET", `${WB_API}/v2/plugin/auth/token?state=${state}`, wbHeaders({
      "X-No-User-Id": "true",
      "X-No-Enterprise-Id": "true",
      "X-No-Department-Info": "true",
      "X-No-Authorization": "true",
    }));
    if (r.code === 0 && r.data?.accessToken) {
      tok = r.data;
      break;
    }
    if (WB_CODE_FATAL.has(r.code)) throw new Error(`登录被上游拒绝（code=${r.code}）：${r.msg}`);
    if (!WB_CODE_PENDING.has(r.code) && r.code !== 0) throw new Error(`轮询登录状态失败：code=${r.code} ${r.msg || ""}`);
    await sleep(WB_POLL_INTERVAL_MS);
  }
  if (!tok) throw new Error("等待登录超时，请重新运行");

  // 账号信息可能晚于 token 落库（12151），短暂重试
  let uid = "";
  for (let i = 0; i < 5 && !uid; i++) {
    const a = await wbRequest("GET", `${WB_API}/v2/plugin/login/account?state=${state}`, wbHeaders({
      "X-Domain": "www.workbuddy.cn",
      Authorization: `Bearer ${tok.accessToken}`,
      "X-No-User-Id": "true",
      "X-No-Enterprise-Id": "true",
      "X-No-Department-Info": "true",
    }));
    if (a.code === 0) uid = String(a.data?.uid ?? "").trim();
    else if (WB_CODE_FATAL.has(a.code)) throw new Error(`登录被上游拒绝（code=${a.code}）：${a.msg}`);
    else if (WB_CODE_PENDING.has(a.code)) await sleep(WB_POLL_INTERVAL_MS);
    else throw new Error(`获取账号信息失败：code=${a.code} ${a.msg || ""}`);
  }
  if (!uid) throw new Error("登录成功但未取到 uid，请稍后重试");

  const values = { WB_ACCESS_TOKEN: tok.accessToken, WB_USER_ID: uid };
  if (tok.refreshToken) values.WB_REFRESH_TOKEN = tok.refreshToken;
  if (tok.domain) values.WB_DOMAIN = String(tok.domain);
  const expMs = tok.expiresIn ? Date.now() + Number(tok.expiresIn) * 1000 : jwtExpMs(tok.accessToken);
  log(`[workbuddy] 登录成功；token ${expText(expMs)}`);
  return values;
}

// ---- Trae ----

const TRAE_HEADER = Buffer.from([116, 99, 5, 16, 0, 0]);
const TRAE_LEFT = Buffer.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
  124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
  84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
  8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
]);
const TRAE_RIGHT = Buffer.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
  96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
  160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
  23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
]);
const TRAE_AUTH_KEY = "iCubeAuthInfo://icube.cloudide";
const TRAE_DC_PREFIX = "iCubeAuthInfo://icube-dc:";
const TRAE_APP_DIRS = ["TRAE SOLO CN", "Trae CN"]; // 两个桌面端目录名，按序探测

const sha512 = (buf) => crypto.createHash("sha512").update(buf).digest();

/** 解密 Trae 桌面端 base64 信封：头 6 字节 + 32 字节随机 key + AES-128-CBC 密文（明文 = sha512 摘要 + JSON）。 */
function decryptTraeEnvelope(encoded) {
  const env = Buffer.from(encoded, "base64");
  if (env.length <= 38 || !env.subarray(0, 6).equals(TRAE_HEADER)) throw new Error("无效的 Trae 凭据信封");
  const secret = Buffer.from(TRAE_LEFT.map((b, i) => b ^ TRAE_RIGHT[i]));
  const derived = sha512(Buffer.concat([sha512(env.subarray(6, 38)), secret]));
  const decipher = crypto.createDecipheriv("aes-128-cbc", derived.subarray(0, 16), derived.subarray(16, 32));
  const plain = Buffer.concat([decipher.update(env.subarray(38)), decipher.final()]);
  if (plain.length < 64) throw new Error("解密结果过短");
  const payload = plain.subarray(64);
  if (!sha512(payload).equals(plain.subarray(0, 64))) throw new Error("Trae 凭据完整性校验失败");
  return JSON.parse(payload.toString("utf8"));
}

function exportTrae(override) {
  const rel = ["User", "globalStorage", "storage.json"];
  const file =
    override ||
    firstExisting(configRoots().flatMap((r) => TRAE_APP_DIRS.map((d) => path.join(r, d, ...rel))));
  if (!file) throw new Error("未找到 Trae 的 storage.json，请先登录 Trae 桌面端，或用 --trae-storage 指定");
  const storage = readJson(file);
  const encrypted = storage[TRAE_AUTH_KEY];
  if (!encrypted) throw new Error(`${file} 中没有 ${TRAE_AUTH_KEY}（未登录？）`);
  const auth = decryptTraeEnvelope(encrypted);
  const token = (auth.token || "").trim();
  if (!token) throw new Error("解密后的登录态没有 token");

  // 设备 id 取 iCubeAuthInfo://icube-dc:<id> 键的 id；优先纯数字（UUID 格式不被服务端识别为注册设备）
  const dcIds = Object.keys(storage)
    .filter((k) => k.startsWith(TRAE_DC_PREFIX))
    .map((k) => k.slice(TRAE_DC_PREFIX.length));
  const deviceId = dcIds.find((d) => /^\d+$/.test(d)) || dcIds[0] || (storage["telemetry.devDeviceId"] || "").trim();

  let keyPem = "";
  let pubPem = "";
  const devEncrypted = deviceId && storage[TRAE_DC_PREFIX + deviceId];
  if (devEncrypted) {
    try {
      const dev = decryptTraeEnvelope(devEncrypted);
      keyPem = (dev.privateKeyPEM || "").trim();
      pubPem = (dev.publicKeyPEM || "").trim();
    } catch (e) {
      log(`[trae] 警告：解密设备密钥失败：${e.message}`);
    }
  }
  const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
  const values = {
    TRAE_TOKEN: token,
    TRAE_DEVICE_ID: deviceId,
    TRAE_USER_ID: String(auth.userId ?? ""),
    TRAE_REFRESH_TOKEN: (auth.refreshToken || "").trim(),
    TRAE_DEVICE_KEY_PEM: keyPem ? b64(keyPem) : "",
    TRAE_DEVICE_PUB_PEM: pubPem ? b64(pubPem) : "",
    TRAE_MACHINE_ID: (storage["telemetry.machineId"] || "").trim(),
  };
  log(`[trae] 读取 ${file}；token ${expText(parseTimeMs(auth.expiredAt) || jwtExpMs(token))}`);
  if (!values.TRAE_REFRESH_TOKEN || !keyPem || !pubPem) {
    log("[trae] 警告：缺少 refreshToken 或设备密钥，Worker 将无法自动续期");
  }
  return values;
}

// ---- MiniMax（OAuth2 设备授权） ----

// 桌面端 MiniMax Code 已停用旧 JWT（token: 头 / /v1/api/user/renewal），改为标准 OAuth2 设备授权：
//   device/code 下发 device_code + 浏览器授权链接 → oauth2/token 轮询换 access/refresh token
//   → refresh token 每次刷新会轮换，Worker 把新值写回 KV（绝不能复用桌面端自己的 refresh token）
// 端点与参数逆向自 app.asar 内 mcode-tools 的 contracts.js / oauth-client.js / endpoint-config.js。
const MM_ACCOUNT_ORIGIN = "https://account.minimax.io"; // 国际版；国内版为 https://account.minimax.cn
const MM_DEVICE_CODE_URL = `${MM_ACCOUNT_ORIGIN}/oauth2/device/code`;
const MM_TOKEN_URL = `${MM_ACCOUNT_ORIGIN}/oauth2/token`;
const MM_CLIENT_ID = "mcode-public";
const MM_SCOPE = "agent.default";
const MM_AUDIENCE = "agent-backend";
const MM_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MM_SESSION_FILE = path.join(os.tmpdir(), "cf-cron-panel-minimax-device.json");
const MM_DEFAULT_UUID = "3548c8fa-9ac2-4a28-8f6b-71ecd88bc048";
const MM_DEFAULT_DEVICE_ID = "1790426211";

function cleanString(s) {
  let v = String(s || "").trim();
  while (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === "'" || v[0] === '"')) v = v.slice(1, -1).trim();
  return v;
}

/** .dev.vars 里取一个已配置的值（仅本地用，不写入仓库、不打印）。 */
function devVarsValue(key) {
  const file = path.join(REPO_ROOT, ".dev.vars");
  if (!fs.existsSync(file)) return "";
  const line = fs.readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.trim().startsWith(`${key}=`));
  return line ? cleanString(line.slice(line.indexOf("=") + 1)) : "";
}

async function mmPostForm(url, values) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  });
  const text = await res.text().catch(() => "");
  let body = {};
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: res.status, body };
}

async function mmStartDevice() {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
  const { status, body } = await mmPostForm(MM_DEVICE_CODE_URL, {
    client_id: MM_CLIENT_ID,
    scope: MM_SCOPE,
    audience: MM_AUDIENCE,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  const deviceCode = String(body?.device_code || "").trim();
  const userCode = String(body?.user_code || "").trim();
  // 上游另有「用 user_code 轮询」的变体（无 device_code 且给 expired_in），按官方客户端逻辑兼容
  const usesUserCode = !deviceCode && !!userCode && Number(body?.expired_in) > 0;
  const pollingCode = deviceCode || (usesUserCode ? userCode : "");
  const verificationUri = String(body?.verification_uri_complete || body?.verification_uri || "").trim();
  let expiresInSec = Number(body?.expires_in);
  if (!(expiresInSec > 0)) {
    expiresInSec = Number(body?.expired_in) > 0
      ? Math.max(1, Math.floor((Number(body.expired_in) - Date.now()) / 1000)) : 300;
  }
  let intervalSec = Number(body?.interval) || 5;
  if (usesUserCode && Number(body?.interval) > 1000) intervalSec = Number(body.interval) / 1000;
  if (status >= 400 || !pollingCode || !userCode || !verificationUri) {
    throw new Error(`获取设备授权失败：HTTP ${status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  const session = {
    version: 1,
    codeVerifier,
    pollingParameter: usesUserCode ? "user_code" : "device_code",
    pollingCode,
    userCode,
    verificationUri,
    expiresAtMs: Date.now() + expiresInSec * 1000,
    intervalMs: intervalSec * 1000,
  };
  // 会话里只有 PKCE verifier 与设备码（没有令牌），中断后可用 --resume 续接
  fs.writeFileSync(MM_SESSION_FILE, JSON.stringify(session), { mode: 0o600 });
  return session;
}

async function mmPoll(session) {
  let intervalMs = session.intervalMs || 5000;
  let ticks = 0;
  while (Date.now() < session.expiresAtMs) {
    const { status, body } = await mmPostForm(MM_TOKEN_URL, {
      grant_type: MM_DEVICE_GRANT,
      [session.pollingParameter]: session.pollingCode,
      client_id: MM_CLIENT_ID,
      code_verifier: session.codeVerifier,
    });
    const st = String(body?.status || "").toLowerCase();
    const err = String(body?.error || "").toLowerCase();
    if (status < 400 && typeof body?.access_token === "string" && body.access_token.trim()) return body;
    if (st === "pending" || err === "authorization_pending") {
      if (ticks++ % 10 === 0) log("[minimax] 等待浏览器完成授权…");
      await sleep(intervalMs);
      continue;
    }
    if (st === "slow_down" || err === "slow_down") {
      intervalMs += 5000;
      await sleep(intervalMs);
      continue;
    }
    if (["denied", "access_denied"].includes(st) || err === "access_denied") throw new Error("授权被拒绝");
    if (["expired", "expired_token"].includes(st) || err === "expired_token") {
      throw new Error("设备授权已过期，请重新运行 --login-minimax");
    }
    throw new Error(`轮询授权结果失败：HTTP ${status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  throw new Error("等待授权超时（设备码 5 分钟有效），请重新运行 --login-minimax");
}

/** 用新 accessToken 打一次签到状态接口，确认 Bearer + 签名链路可用（失败只警告，不影响导出）。 */
function mmQuotePlus(s) {
  let out = "";
  for (const b of Buffer.from(s, "utf8")) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9_.\-~]/.test(c)) out += c;
    else if (b === 0x20) out += "+";
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}
const mmMd5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");

async function mmVerify(accessToken, userId) {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const pathname = "/minimax-cloud/api/v1/signin/status";
  const params = {
    device_platform: "web", biz_id: "3", app_id: "3001", version_code: "22201",
    unix: String(nowMs), timezone_offset: "28800", is_desktop: "1", desktop_version: "",
    sys_language: "en", lang: "en",
    uuid: devVarsValue("MINIMAX_UUID") || MM_DEFAULT_UUID,
    device_id: devVarsValue("MINIMAX_DEVICE_ID") || MM_DEFAULT_DEVICE_ID,
    os_name: "Windows", browser_name: "Chrome", device_memory: "16", cpu_core_num: "4",
    browser_language: "zh-CN", browser_platform: "Win32", user_id: userId,
    op_ticket: "undefined", screen_width: "1536", screen_height: "864", client: "desktop",
  };
  const query = Object.entries(params).map(([k, v]) => `${mmQuotePlus(k)}=${mmQuotePlus(v)}`).join("&");
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    yy: mmMd5(encodeURIComponent(`${pathname}?${query}`) + "_" + "{}" + mmMd5(String(nowMs)) + "ooui"),
    "x-timestamp": String(nowSec),
    "x-signature": mmMd5(`${nowSec}I*7Cf%WZ#S&%1RlZJ&C2`),
    origin: "https://agent.minimax.io",
    referer: "https://agent.minimax.io/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MiniMaxAgent/desktop Chrome/124.0 Safari/537.36",
    Accept: "application/json",
  };
  try {
    const res = await fetch(`https://agent.minimax.io${pathname}?${query}`, { headers });
    const text = await res.text();
    let j = {};
    try { j = JSON.parse(text); } catch { /* 非 JSON 响应按失败处理 */ }
    if (res.status === 200 && (j?.base_resp?.status_code === 0 || j?.data)) return { ok: true };
    return { ok: false, reason: `HTTP ${res.status} ${text.slice(0, 120)}` };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function loginMinimax(opts) {
  let session;
  if (opts.resume) {
    if (!fs.existsSync(MM_SESSION_FILE)) throw new Error("没有可续接的设备授权会话，请先运行 --login-minimax");
    session = JSON.parse(fs.readFileSync(MM_SESSION_FILE, "utf8"));
    if (session.expiresAtMs <= Date.now()) throw new Error("上次设备授权已过期，请重新运行 --login-minimax");
    log(`[minimax] 续接等待授权（用户码 ${session.userCode}）…`);
  } else {
    session = await mmStartDevice();
    log("[minimax] 请在浏览器打开下面的链接并完成登录（5 分钟内有效）：");
    log(session.verificationUri);
    log(`[minimax] 用户码：${session.userCode}（链接通常已带上，若页面要求输入请填这个）`);
  }

  const grant = await mmPoll(session);
  fs.rmSync(MM_SESSION_FILE, { force: true });
  const refreshToken = String(grant.refresh_token || "").trim();
  const accessToken = String(grant.access_token || "").trim();
  if (!refreshToken) throw new Error("授权响应缺少 refresh_token，Worker 无法长期自续，请重新授权");
  const expMs = Number(grant.expires_in) > 0 ? Date.now() + Number(grant.expires_in) * 1000 : 0;
  log(`[minimax] 授权成功；accessToken ${expText(expMs)}；已取得独立 refreshToken（不影响桌面端会话）`);

  const values = { MINIMAX_REFRESH_TOKEN: refreshToken };
  if (accessToken) values.MINIMAX_ACCESS_TOKEN = accessToken;
  const userId = cleanString(opts.minimaxUserId || process.env.MINIMAX_USER_ID || devVarsValue("MINIMAX_USER_ID"));
  if (userId) {
    values.MINIMAX_USER_ID = userId;
    const v = await mmVerify(accessToken, userId);
    log(v.ok
      ? "[minimax] 签到接口验证通过（Authorization: Bearer 可用）"
      : `[minimax] 警告：签到接口验证未通过 ${v.reason}；凭据仍已导出，可稍后在面板点「运行」复查`);
  } else {
    log("[minimax] 未找到 MINIMAX_USER_ID，跳过签到接口验证；请确认该 Secret 已配置（可用 --minimax-user-id 指定）");
  }
  return values;
}

/** 旧路径已废弃：桌面端配置文件里不再有 token，且共用桌面端 refresh token 会把桌面端挤下线。 */
function exportMinimax() {
  throw new Error("MiniMax 已改用 OAuth2 设备授权；请运行 node scripts/export-env.mjs --login-minimax [--push]");
}

// ---- 输出 / 推送 ----

const APPS = {
  workbuddy: exportWorkbuddy,
  trae: exportTrae,
  minimax: exportMinimax,
};

function mask(v) {
  if (v.length <= 12) return "*".repeat(v.length);
  return `${v.slice(0, 4)}…${v.slice(-4)}（${v.length} 字符）`;
}

function pushSecrets(values, worker) {
  let failed = 0;
  for (const [name, value] of Object.entries(values)) {
    const args = ["wrangler", "secret", "put", name];
    if (worker) args.push("--name", worker);
    const npx = process.platform === "win32" ? "npx.cmd" : "npx"; // Windows 下 npx 是 .cmd，spawnSync 需要带扩展名
    const r = spawnSync(npx, args, { cwd: REPO_ROOT, input: value, encoding: "utf8", shell: process.platform === "win32" }); // Node 修 CVE-2024-27980 后 spawn .cmd 必须开 shell
    if (r.status === 0) {
      log(`[push] ${name} OK`);
    } else {
      failed++;
      const tail = `${r.stderr || ""}${r.stdout || ""}`.trim().split("\n").slice(-3).join(" ");
      log(`[push] ${name} 失败：${tail || r.error?.message || `exit ${r.status}`}`);
    }
  }
  return failed;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.resume && !opts.loginMinimax) fail("--resume 需与 --login-minimax 一起使用");
  const targets = opts.only || (opts.loginMinimax ? ["minimax"] : Object.keys(APPS));
  for (const t of targets) if (!APPS[t]) fail(`未知应用：${t}（可选 ${Object.keys(APPS).join(" / ")}）`);
  if (opts.workbuddySlot2 && !targets.includes("workbuddy")) fail("--wb2 需与 workbuddy 一起使用（建议加 --only workbuddy）");

  const values = {};
  let okApps = 0;
  for (const t of targets) {
    try {
      const getter = t === "workbuddy" && opts.loginWorkbuddy
        ? loginWorkbuddy
        : t === "minimax" && opts.loginMinimax
          ? () => loginMinimax(opts)
          : () => APPS[t](opts.paths[t]);
      let got = await getter();
      if (t === "workbuddy" && opts.workbuddySlot2) {
        got = Object.fromEntries(Object.entries(got).map(([k, v]) => [k.replace(/^WB_/, "WB2_"), v]));
        const uid1 = devVarsValue("WB_USER_ID");
        if (uid1 && got.WB2_USER_ID === uid1) {
          fail("拿到的 uid 与账号 1 相同；请在无痕窗口（或退出账号 1 后）用账号 2 重新授权，本次结果未写入");
        }
      }
      Object.assign(values, got);
      okApps++;
    } catch (e) {
      log(`[${t}] 跳过：${e.message}`);
    }
  }
  if (!okApps) {
    log("没有导出任何登录态");
    process.exit(1);
  }

  for (const k of Object.keys(values)) if (!values[k]) delete values[k];

  if (opts.push) {
    // --wb2 只推本次授权产出的 WB2_*，避免 shell 里账号 1 的 WB_* 或其他变量被顺带覆盖
    if (!opts.workbuddySlot2) for (const k of EXTRA_KEYS) if (process.env[k]) values[k] = process.env[k];
    const failed = pushSecrets(values, opts.worker);
    process.exit(failed ? 1 : 0);
  }

  if (opts.json) {
    const out = opts.mask ? Object.fromEntries(Object.entries(values).map(([k, v]) => [k, mask(v)])) : values;
    console.log(JSON.stringify(out, null, 2));
  } else {
    for (const [k, v] of Object.entries(values)) console.log(`${k}=${opts.mask ? mask(v) : v}`);
  }
}

main().catch((e) => {
  log(`错误：${e.message}`);
  process.exit(1);
});
