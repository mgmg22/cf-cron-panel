import type { CheckinResult, Env } from "../types";
import { postJson } from "../lib/http";
import { randomHex } from "../lib/encoding";
import { signCanonical, resolvePem } from "../lib/crypto";
import { decodeJwtExp } from "../lib/jwt";
import { kvReadJson, kvWriteJson } from "../lib/kv";
import { apiSucceeded, isAuthStatus, isTransientStatus } from "../lib/api";

const HOST = "https://api.trae.cn";
const STATUS_PATH = "/trae/api/v2/ug/checkin_credits/status";
const CLAIM_PATH = "/trae/api/v2/ug/checkin_credits/claim";
const ENTITLEMENT_PATH = "/trae/api/v2/pay/user_current_entitlement_list";
const EXCHANGE_PATH = "/trae/api/v3/oauth/ExchangeToken";
const CLIENT_ID = "en1oxy7wnw8j9n";
const APP_VERSION = "1.107.1";
const STORE_KEY = "trae";

interface TraeCred {
  token: string;
  device_id: string;
  user_id: string;
  refresh_token: string;
  device_key_pem: string;
  device_pub_pem: string;
  machine_id: string;
  expires_ms: number;
  refresh_expires_ms: number;
  base: string; // env 里的 TRAE_TOKEN，写入 KV 时一并记录，用于识别 secret 是否已被重新推送
  kv_error: string; // 本次读取 KV 失败的原因，续期失败时附在提示里
}

function readCred(env: Env): TraeCred {
  return {
    token: (env.TRAE_TOKEN || "").trim(),
    device_id: (env.TRAE_DEVICE_ID || "").trim(),
    user_id: (env.TRAE_USER_ID || "").trim(),
    refresh_token: (env.TRAE_REFRESH_TOKEN || "").trim(),
    // PEM 兼容两种形式：真 PEM，或 base64(PEM) 单行（export-env.mjs 导出的格式，读取侧还原）
    device_key_pem: resolvePem((env.TRAE_DEVICE_KEY_PEM || "").trim(), "PRIVATE"),
    device_pub_pem: resolvePem((env.TRAE_DEVICE_PUB_PEM || "").trim(), "PUBLIC"),
    machine_id: (env.TRAE_MACHINE_ID || "").trim(),
    expires_ms: 0,
    refresh_expires_ms: 0,
    base: (env.TRAE_TOKEN || "").trim(),
    kv_error: "",
  };
}

function canHeal(c: TraeCred): boolean {
  return Boolean(c.refresh_token && c.device_key_pem && c.device_pub_pem);
}

function expiringSoon(c: TraeCred): boolean {
  const exp = c.expires_ms || decodeJwtExp(c.token);
  if (!exp) return false;
  return (exp - Date.now()) / 3600000 <= 48;
}

function buildDeviceProof(c: TraeCred): Promise<{ Timestamp: number; Nonce: string; Signature: string }> {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomHex(16);
  const canonical = ["POST", EXCHANGE_PATH, CLIENT_ID, c.refresh_token, String(ts), nonce].join("\n");
  return signCanonical(c.device_key_pem, canonical).then((signature) => ({ Timestamp: ts, Nonce: nonce, Signature: signature }));
}

function buildDeviceInfo(c: TraeCred, appVersion: string): any {
  return {
    DeviceID: c.device_id,
    MachineID: c.machine_id || "",
    PlatformCode: "SOLO_PC",
    DeviceType: "PC",
    DeviceName: "user",
    DeviceModel: "",
    ClientVersion: appVersion,
    DevicePublicKey: resolvePem(c.device_pub_pem),
    DeviceBrand: "",
    DeviceCPU: "",
    OSInfo: "Windows",
    OSVersion: "",
  };
}

async function exchangeToken(c: TraeCred, appVersion: string): Promise<[boolean, any, string]> {
  if (!canHeal(c)) return [false, null, "缺少 refreshToken / 设备私钥材料"];
  let proof: { Timestamp: number; Nonce: string; Signature: string };
  try {
    proof = await buildDeviceProof(c);
  } catch (e: any) {
    return [false, null, `设备证明生成失败：${e?.message || e}`];
  }
  const body = {
    ClientID: CLIENT_ID,
    ClientSecret: "",
    RefreshToken: c.refresh_token,
    DeviceInfo: buildDeviceInfo(c, appVersion),
    DeviceProof: proof,
    IDEVersion: appVersion,
  };
  const [sc, sb] = await postJson(HOST + EXCHANGE_PATH, { "Content-Type": "application/json", "x-cloudide-token": "" }, body);
  if (typeof sb !== "object") return [false, null, `续期响应非 JSON（HTTP ${sc}）`];
  const err = (sb as any).ResponseMetadata?.Error;
  if (err) return [false, null, `续期被拒 HTTP ${sc} code=${err.Code} msg=${err.Message}`];
  const res = (sb as any).Result || {};
  const token = res.Token;
  if (!token) return [false, null, `续期响应无 Token：${JSON.stringify(sb).slice(0, 200)}`];
  return [
    true,
    {
      token,
      refresh_token: res.RefreshToken || c.refresh_token,
      expires_ms: parseFloat(res.TokenExpireAt || 0),
      refresh_expires_ms: parseFloat(res.RefreshExpireAt || 0),
    },
    "",
  ];
}

async function selfHeal(env: Env, c: TraeCred, appVersion: string): Promise<[boolean, string]> {
  const [ok, fields, err] = await exchangeToken(c, appVersion);
  if (!ok) {
    const hint = c.kv_error ? `（注意：读取 KV 失败，可能未使用已续期的凭据：${c.kv_error}）` : "";
    return [false, `自动续期失败：${err}${hint}`];
  }
  c.token = fields.token;
  c.refresh_token = fields.refresh_token;
  c.expires_ms = fields.expires_ms;
  c.refresh_expires_ms = fields.refresh_expires_ms;
  const writeErr = await kvWriteJson(env.CHECKIN_STATE, STORE_KEY, {
    token: c.token,
    refresh_token: c.refresh_token,
    expires_ms: c.expires_ms,
    refresh_expires_ms: c.refresh_expires_ms,
    base: c.base,
    updated_at: Date.now(),
  });
  if (writeErr) {
    return [true, `已自动续期，但 KV 写入失败（${writeErr}），请留意 refresh_token 是否失效`];
  }
  const remain = c.expires_ms ? (c.expires_ms - Date.now()) / 86400000 : 0;
  return [true, `已自动续期 token（新有效期约 ${remain.toFixed(1)} 天）`];
}

function buildHeaders(token: string, deviceId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: token.startsWith("Cloud-IDE-JWT ") ? token : `Cloud-IDE-JWT ${token}`,
    "x-device-id": deviceId || "",
  };
}

function isAuthFailure(sc: number, d: any): boolean {
  if (isAuthStatus(sc)) return true;
  const code = d?.code;
  return typeof code === "number" && (code === 401 || code === 403 || code === 1001);
}

async function queryPoints(token: string, deviceId: string): Promise<number | null> {
  const [, sb] = await postJson(HOST + ENTITLEMENT_PATH, buildHeaders(token, deviceId), { require_usage: true });
  try {
    const packs = (sb as any)?.data?.user_entitlement_pack_list;
    if (!Array.isArray(packs)) return null;
    let total = 0;
    let found = false;
    for (const p of packs) {
      const limit = (p?.entitlement_base_info?.quota)?.credits_limit || 0;
      const used = p?.usage?.credits_amount || 0;
      if (limit > 0) {
        found = true;
        total += Math.max(limit - used, 0);
      }
    }
    return found ? total : null;
  } catch {
    return null;
  }
}

interface AuthedResult {
  sc: number;
  sb: any;
  healed: boolean; // 本次调用中是否已自动续期并重试
  healErr: string; // 续期失败原因，空串表示未失败或未尝试
}

/** 调用接口；鉴权失败且具备续期材料时续期一次并重试。 */
async function callAuthed(env: Env, c: TraeCred, appVersion: string, path: string): Promise<AuthedResult> {
  let [sc, sb] = await postJson(HOST + path, buildHeaders(c.token, c.device_id), {});
  if (!isAuthFailure(sc, sb) || !canHeal(c)) return { sc, sb, healed: false, healErr: "" };
  const [ok, msg] = await selfHeal(env, c, appVersion);
  if (!ok) return { sc, sb, healed: false, healErr: msg };
  [sc, sb] = await postJson(HOST + path, buildHeaders(c.token, c.device_id), {});
  return { sc, sb, healed: true, healErr: "" };
}

/** 鉴权仍失败时生成对应的 AUTH_EXPIRED 结果；否则返回 null。what 为场景前缀，如「领取时」。 */
function authError(r: AuthedResult, what: string): CheckinResult | null {
  if (!isAuthFailure(r.sc, r.sb)) return null;
  if (r.healErr) {
    return { flag: "AUTH_EXPIRED", content: `⚠️ ${what}鉴权失败（HTTP ${r.sc}）且自动续期失败：${r.healErr}` };
  }
  if (r.healed) {
    return { flag: "AUTH_EXPIRED", content: "⚠️ 续期后再次鉴权失败，请检查设备证明材料" };
  }
  const m = r.sb?.message || r.sb?.msg || "未知错误";
  return {
    flag: "AUTH_EXPIRED",
    content: `⚠️ ${what}鉴权失败（HTTP ${r.sc}）：${m}，请在 Trae 桌面端刷新登录态后运行 node scripts/export-env.mjs --only trae --push 更新变量`,
  };
}

/** 总可用积分行（查询失败返回空串）。 */
async function pointsLine(c: TraeCred): Promise<string> {
  const pts = await queryPoints(c.token, c.device_id);
  return pts != null ? `\n- 总可用积分：${pts.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "";
}

export async function run(env: Env): Promise<CheckinResult> {
  const appVersion = env.TRAE_APP_VERSION || APP_VERSION;
  const c = readCred(env);

  // 合并 KV 中续期后的滚动凭据；仅当记录基于当前 secret 生成（base 一致）才采用，
  // secret 被重新推送后以 secret 为准
  const kv = await kvReadJson(env.CHECKIN_STATE, STORE_KEY);
  c.kv_error = kv.error;
  const cached = kv.value;
  if (cached && cached.base === c.base) {
    for (const k of ["token", "refresh_token", "expires_ms", "refresh_expires_ms"]) {
      if (cached[k]) (c as any)[k] = cached[k];
    }
  }

  if (!c.token) {
    if (!canHeal(c)) {
      return { flag: "NO_CREDENTIAL", content: "未获取到 token 且无续期材料，请设置 TRAE_TOKEN，或配置 TRAE_REFRESH_TOKEN + TRAE_DEVICE_KEY_PEM + TRAE_DEVICE_PUB_PEM 以自动续期" +
        "（可在装有 Trae 桌面端且已登录的电脑上运行 node scripts/export-env.mjs --only trae --push）" };
    }
    const [ok, msg] = await selfHeal(env, c, appVersion);
    if (!ok) return { flag: "NO_CREDENTIAL", content: `⚠️ ${msg}` };
  } else if (canHeal(c) && expiringSoon(c)) {
    // 主动续期失败不影响本次签到：现有 token 仍可能有效，真正鉴权失败时再报错
    const [ok, msg] = await selfHeal(env, c, appVersion);
    if (!ok) console.warn(`[trae] 主动续期失败，沿用现有 token：${msg}`);
  }

  // 1) 状态
  const st = await callAuthed(env, c, appVersion, STATUS_PATH);
  const stAuthErr = authError(st, "");
  if (stAuthErr) return stAuthErr;
  const healNote = st.healed ? "（已自动续期）" : "";
  if (typeof st.sb === "object" && st.sb.checked_in) {
    return { flag: "ALREADY_TODAY", content: `ℹ️ 今日已签到${await pointsLine(c)}${healNote}` };
  }
  if (!apiSucceeded(st.sb)) {
    const m = st.sb?.message || st.sb?.msg || JSON.stringify(st.sb).slice(0, 120);
    if (isTransientStatus(st.sc)) {
      return { flag: "RATE_LIMITED", content: `⏳ 服务端限频/临时故障：${m}，建议错峰或稍后重试` };
    }
    return { flag: "STATUS_ERR", content: `⚠️ 状态查询异常：HTTP ${st.sc} ${m}` };
  }

  // 2) 领取
  const cl = await callAuthed(env, c, appVersion, CLAIM_PATH);
  const clAuthErr = authError(cl, "领取时");
  if (clAuthErr) return clAuthErr;
  const cb = cl.sb;
  if (apiSucceeded(cb)) {
    const points = cb?.data?.points ?? cb?.points;
    const message = cb?.message || cb?.msg || "";
    const gain = points ? `本次 +${points} 积分` : message === "success" ? "签到成功" : message;
    return { flag: "SUCCESS", content: `✅ ${gain}${await pointsLine(c)}` };
  }
  const m = cb?.message || cb?.msg || JSON.stringify(cb).slice(0, 150);
  if (isTransientStatus(cl.sc)) {
    return { flag: "RATE_LIMITED", content: `⏳ 服务端限频/临时故障：${m}，建议错峰或稍后重试` };
  }
  return { flag: "FAIL", content: `⚠️ 签到未成功：HTTP ${cl.sc} ${m}` };
}
