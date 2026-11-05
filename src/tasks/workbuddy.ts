/// WorkBuddy 每日签到任务：每日签到 + 总剩余积分查询 + 成长中心（派猫旅行/开盲盒）。
/// 支持 2 个账号：账号 1 用 WB_*，账号 2 用 WB2_*（不配置则只跑账号 1）。
/// 每个账号的滚动凭据独立存 KV（键 workbuddy:<uid>）。
/// 配置了 *REFRESH_TOKEN 时自动续期：token 临近过期或签到返回 401/403 时调用刷新端点，
/// 新的 accessToken / refreshToken 写入 KV；未配置则失效后需手动更新变量。

import type { CheckinResult, Env } from "../types";
import { requestJson } from "../lib/http";
import { randomHex } from "../lib/encoding";
import { decodeJwtExp, decodeJwtSub } from "../lib/jwt";
import { kvReadJson, kvWriteJson } from "../lib/kv";

// CN 主入口：真机 5.9.3 客户端全部 billing/growth 请求都发往 www.workbuddy.cn，
// copilot.tencent.com 是官方 NetworkFailover 里的备选入口（两域同后端）。
const API_BASE = "https://www.workbuddy.cn";
const API_BASE_FALLBACK = "https://copilot.tencent.com";
const CHECKIN_PATH = "/v2/billing/meter/daily-checkin";
const CHECKIN_ACTIVITY_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
const REFRESH_PATH = "/v2/plugin/auth/token/refresh";
const STORE_KEY_PREFIX = "workbuddy:";
const REFRESH_AHEAD_MS = 72 * 3600_000; // 距过期不足 72 小时即主动续期
const EXPIRES_IN_MAX_S = 10 * 365 * 86400; // refresh 响应 expiresIn 的合理上限，超出视为脏数据
// 桌面端 RPC 族 UA（refresh / report 等 RPC 路径）
const WB_UA = "WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0";
// billing 族 UA：客户端 billing 请求走 axios 实例，UA 恒为 axios 默认串（无品牌段）
const BILLING_UA = "axios/1.16.1";

/** 纯随机 32 hex（真机 billing 族必带 X-Request-ID，无时间前缀）。 */
const randomHex32 = () => randomHex(16);

// 刷新端点头族（对齐真机 /v2/plugin/auth/token/refresh 抓包形态）：X-Refresh-Token 与
// Authorization 双发，另带 X-User-Id / X-Request-ID / X-Domain；网关按客户端形态风控，
// 头族不符会被 401。
function refreshHeaders(token: string, refreshToken: string, uid: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "X-Product": "SaaS",
    "X-Request-ID": randomHex32(),
    "User-Agent": WB_UA,
    "X-Refresh-Token": refreshToken,
    "X-Auth-Refresh-Source": "plugin",
    Authorization: `Bearer ${token}`,
    "X-User-Id": uid,
    "X-Domain": "www.workbuddy.cn",
  };
}

// 资源包余额接口（无 /v2 前缀）
const RESOURCE_SUMMARY_PATH = "/billing/meter/get-user-resource-summary";

// 成长中心（派猫旅行 + 开盲盒）——仅做可 API 化的部分，不自动完成成长计划任务
const GROWTH_BASE = "/v2/activity/growth";
const TRAVEL_STATUS = `${GROWTH_BASE}/buddy/travel/status`;
const TRAVEL_CONFIG = `${GROWTH_BASE}/buddy/travel/config`;
const TRAVEL_DEPART = `${GROWTH_BASE}/buddy/travel/depart`;
const TRAVEL_CLAIM = `${GROWTH_BASE}/buddy/travel/claim`;
// 开盲盒（能量开启 Buddy 盲盒）：每攒够 10 点能量可开启一次（开启消耗 10 能量）
const ENERGY = `${GROWTH_BASE}/energy`;
const BLINDBOX_ENERGY_COST = 10;
const BUDDY_OPEN = `${GROWTH_BASE}/buddy/open`;

// 以 POST 发送但无副作用的查询接口：允许与 GET 同等回落
const READ_ONLY_POST_PATHS = new Set([CHECKIN_ACTIVITY_STATUS_PATH, RESOURCE_SUMMARY_PATH]);

function baseHeaders(token: string, uid: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    // billing 族真机 UA 是 axios 默认串（客户端 billing 走 axios 实例，与桌面 UA 不同）
    "User-Agent": BILLING_UA,
    // billing 族必带 X-Request-ID（纯随机 32 hex）
    "X-Request-ID": randomHex32(),
    Authorization: `Bearer ${token}`,
    "X-User-Id": uid,
  };
}

function fmtCredits(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 剥掉 data 信封：{code, data:{...}} -> {...}；非信封原样返回。 */
function unwrap(body: any): any {
  if (body && typeof body === "object" && body.data && typeof body.data === "object") {
    return body.data;
  }
  return body;
}

/** HTTP 2xx 且业务 code 非错误（缺失/0 视为成功）。 */
function ok2xx(sc: number, sb: any): boolean {
  if (!(sc >= 200 && sc < 300)) return false;
  if (sb && typeof sb === "object" && sb.code != null && sb.code !== 0) return false;
  return true;
}

/** 通用请求：默认 POST，GET 用于状态/配置/能量查询。
 *  主域 www.workbuddy.cn；被网关拒绝时回落备选域 copilot.tencent.com 一次：
 *  只读请求遇 401/403、HTML 页、5xx、无业务信封响应都回落；写请求只在 401/403 或 HTML 页时回落
 *  （5xx 可能已被后端处理，回落会重复执行）。 */
async function wbCall(
  token: string,
  uid: string,
  path: string,
  method: "GET" | "POST" = "POST",
  payload?: any,
  domain = "",
): Promise<[number, any]> {
  const headers = baseHeaders(token, uid);
  // 出站 X-Domain 头：显式 WB_DOMAIN 时以配置为准，默认主域
  headers["X-Domain"] = domain || "www.workbuddy.cn";
  const [sc, sb] = await requestJson(API_BASE + path, method, headers, payload ?? {});
  if (!token || !uid) return [sc, sb];
  // 网关层拒绝（openresty HTML 页无业务信封）或上游 5xx：换备选域重试一次
  const gatewayBlocked = typeof sb === "object" && sb !== null && sb.code == null && !sb.raw && !sb.error;
  const serverErr = sc >= 500 && sc < 600;
  const htmlPage = typeof sb === "object" && typeof sb.raw === "string" && sb.raw.includes("<html");
  // 只读请求（GET / 只读 POST）可对全部上述情形回落；写请求（签到、领奖、派猫、开盲盒）
  // 仅在「请求明确被网关拒绝、未到达业务」时回落（401/403/HTML 页），
  // 5xx 与无信封响应可能已被后端处理，回落会造成重复执行
  const readOnly = method === "GET" || READ_ONLY_POST_PATHS.has(path);
  const rejectedAtGateway = sc === 401 || sc === 403 || htmlPage;
  if (readOnly ? rejectedAtGateway || serverErr || gatewayBlocked : rejectedAtGateway) {
    return requestJson(API_BASE_FALLBACK + path, method, headers, payload ?? {});
  }
  return [sc, sb];
}

async function fetchBalance(token: string, uid: string, domain: string): Promise<string> {
  const [sc, sb] = await wbCall(token, uid, RESOURCE_SUMMARY_PATH, "POST", {}, domain);
  if (sc !== 0 && typeof sb === "object" && (sb as any).code === 0) {
    const pkgs = (sb as any).data?.Packages;
    if (Array.isArray(pkgs)) {
      const total = pkgs.reduce(
        (acc: number, p: any) => acc + Math.max(0, parseFloat(p.CycleRemainCapacity || 0) || 0),
        0,
      );
      if (!Number.isNaN(total)) return `- 总剩余积分：${fmtCredits(total)}`;
    }
  }
  return "";
}

/** 查签到活动状态（只读、无副作用）。返回 null 表示查询失败——查询失败时
 *  fail-open 照常签到，签到自身的幂等判据仍是兜底。 */
async function fetchCheckinActivity(
  token: string,
  uid: string,
  domain: string,
): Promise<{ active: boolean; todayCheckedIn: boolean; streakDays: number; endTime: string } | null> {
  const [sc, sb] = await wbCall(token, uid, CHECKIN_ACTIVITY_STATUS_PATH, "POST", {}, domain);
  if (!ok2xx(sc, sb)) return null;
  const d = unwrap(sb);
  if (!d || typeof d !== "object" || typeof d.active !== "boolean") return null;
  return {
    active: d.active,
    todayCheckedIn: d.today_checked_in === true,
    streakDays: Number(d.streak_days) || 0,
    endTime: String(d.end_time || ""),
  };
}

/** 幂等判重：上游对重复签到返回 code!=0 且文案含"已签到"/"already"（中英文环境都可能）。 */
function isAlreadyCheckinMsg(msg: unknown): boolean {
  const s = String(msg ?? "").toLowerCase();
  return s.includes("已签到") || s.includes("already");
}

/** 瞬时错误有界重试：429「请求处理中」按 2s/5s/10s，5xx 按 2s/4s，各档打满即止。
 *  业务错误（已签到/参数错）不重试。 */
async function withBillingRetry(fn: () => Promise<[number, any]>): Promise<[number, any]> {
  let retries = 0;
  for (;;) {
    const [sc, sb] = await fn();
    const msg = String((sb as any)?.msg ?? "");
    const processing = sc === 429 && /处理中|processing/i.test(msg);
    const serverErr = sc >= 500 && sc < 600;
    if (!processing && !serverErr) return [sc, sb];
    if (retries >= (processing ? 3 : 2)) return [sc, sb];
    await new Promise((r) => setTimeout(r, processing ? [2000, 5000, 10000][retries] : (retries + 1) * 2000));
    retries++;
  }
}

async function checkinOnce(token: string, uid: string, domain: string): Promise<CheckinResult> {
  // 先查活动状态（只读）：官方客户端已签时省一次写调用。查询失败 fail-open 照常签到
  // （today_checked_in 偶发不准的风险由下方签到幂等判据兜底，不会漏签）。
  const act = await fetchCheckinActivity(token, uid, domain).catch(() => null);
  if (act && act.active && act.todayCheckedIn) {
    let content = `ℹ️ 今日已签到，无需重复领取（连登 ${act.streakDays} 天${act.endTime ? `，活动至 ${act.endTime}` : ""}）`;
    const bal = await fetchBalance(token, uid, domain);
    if (bal) content += `\n${bal}`;
    return { flag: "ALREADY_TODAY", content };
  }

  const [cc, cb] = await withBillingRetry(() => wbCall(token, uid, CHECKIN_PATH));

  if (cc === 0) {
    return { flag: "NET_ERR", content: `⚠️ 网络异常，签到请求未发出：${JSON.stringify(cb).slice(0, 200)}` };
  }
  if (typeof cb === "object") {
    const code = (cb as any).code;
    if (code === 0) {
      const d = (cb as any).data || {};
      let content = `✅ 领取成功\n- 本次积分：${d.credit}\n- 连续签到：第 ${d.streak_days} 天`;
      const bal = await fetchBalance(token, uid, domain);
      if (bal) content += `\n${bal}`;
      return { flag: "SUCCESS", content };
    }
    // code 10001 与"已签到"文案都视为幂等成功（上游两形态都出现过）
    if (code === 10001 || isAlreadyCheckinMsg((cb as any).msg)) {
      let content = "ℹ️ 今日已签到，无需重复领取";
      const bal = await fetchBalance(token, uid, domain);
      if (bal) content += `\n${bal}`;
      return { flag: "ALREADY_TODAY", content };
    }
    if (cc === 401 || cc === 403) {
      return { flag: "TOKEN_EXPIRED", content: `⚠️ 令牌失效（HTTP ${cc}），请刷新 WorkBuddy 登录态后重试` };
    }
    return { flag: "FAIL", content: `⚠️ 签到未成功：HTTP ${cc} code=${code} msg=${(cb as any).msg}` };
  }
  return { flag: "HTTP_ERR", content: `⚠️ 请求异常（HTTP ${cc}）：${JSON.stringify(cb).slice(0, 200)}` };
}

/** 派猫旅行状态机：arrived→领奖；idle→派出发；traveling→跳过。
 *  动作由服务端状态驱动，天然幂等，重复运行不会重复领/派。 */
async function buddyTravel(token: string, uid: string, domain: string): Promise<string> {
  const [sc, sb] = await wbCall(token, uid, TRAVEL_STATUS, "GET", undefined, domain);
  if (!ok2xx(sc, sb)) return `查询旅行状态失败（HTTP ${sc}）`;
  const data = unwrap(sb);
  let state = data?.state;
  const parts: string[] = [];

  if (state === "arrived") {
    const recordId = data.record_id;
    const [cc, cb] = await wbCall(token, uid, TRAVEL_CLAIM, "POST", { record_id: recordId }, domain);
    if (ok2xx(cc, cb)) {
      const reward = unwrap(cb)?.reward_credit;
      parts.push(reward != null ? `领旅行礼物 +${reward} 积分` : "领旅行礼物成功");
    } else {
      parts.push(`领旅行礼物失败（HTTP ${cc}）`);
    }
    state = "idle"; // 领完回到 idle，下方再派一程
  }

  if (state === "idle") {
    // 服务端标记今日派猫额度已用完时，depart 会 400 daily limit reached，属正常幂等态
    if (data?.daily_limit_reached) {
      parts.push("今日派猫额度已用完");
    } else {
      const [cc, cb] = await wbCall(token, uid, TRAVEL_CONFIG, "GET", undefined, domain);
      const locs = ok2xx(cc, cb) ? unwrap(cb)?.locations : null;
      if (Array.isArray(locs) && locs.length) {
        const loc = locs[0];
        const [dc, db] = await wbCall(token, uid, TRAVEL_DEPART, "POST", { location_id: loc.id }, domain);
        if (ok2xx(dc, db)) {
          const locName = unwrap(db)?.location?.name || "?";
          parts.push(`派 Buddy 去${locName}`);
        } else {
          parts.push(`派 Buddy 失败（HTTP ${dc}）`);
        }
      } else {
        parts.push("无可用旅行地点");
      }
    }
  } else if (state === "traveling") {
    parts.push(`Buddy 旅行中（${data?.location?.name || "?"}）`);
  }

  return parts.length ? parts.join("；") : "旅行无变动";
}

/** 开盲盒：先查能量余额，余额 >= 10 才开启一次，能量不足不开启。 */
async function openBlindbox(token: string, uid: string, domain: string): Promise<string> {
  const [es, eb] = await wbCall(token, uid, ENERGY, "GET", undefined, domain);
  if (!ok2xx(es, eb)) return `查询能量失败（HTTP ${es}）`;
  const energy = unwrap(eb)?.balance;
  if (typeof energy !== "number" || energy < BLINDBOX_ENERGY_COST) {
    return `能量不足（当前${energy}/${BLINDBOX_ENERGY_COST}），暂不能开盲盒`;
  }
  const [oc, ob] = await wbCall(token, uid, BUDDY_OPEN, "POST", {}, domain);
  if (ok2xx(oc, ob)) {
    const data = unwrap(ob);
    const results = data?.results || [];
    if (results.length) {
      const r0 = results[0] || {};
      const name = r0.name || r0.buddy?.name || r0.instance?.name || "未知 Buddy";
      const rarity = r0.rarity || r0.buddy?.rarity || r0.instance?.rarity || "";
      const got = rarity ? `${name}（${rarity}）` : name;
      const cnt = data?.count || results.length;
      return `开盲盒获得：${got}${cnt && cnt > 1 ? ` 等 ${cnt} 个` : ""}`;
    }
    return "开盲盒成功";
  }
  const msg = unwrap(ob)?.msg || "";
  return `开盲盒失败（HTTP ${oc}）${msg ? `：${msg}` : ""}`;
}

/** 成长中心编排：派猫旅行 + 开盲盒。不含任务领奖。 */
async function runGrowth(token: string, uid: string, domain: string): Promise<string> {
  const parts: string[] = [];
  const t = await buddyTravel(token, uid, domain);
  if (t) parts.push(t);
  const b = await openBlindbox(token, uid, domain);
  if (b) parts.push(`盲盒：${b}`);
  return parts.length ? parts.join("；") : "成长中心无可执行项";
}

interface WbCred {
  token: string;
  refresh_token: string;
  expires_ms: number; // 0 表示未知，回退到 JWT exp
  base: string; // KV 记录生成时 env 里的 WB_ACCESS_TOKEN，用于识别 secret 是否已被重新推送
  kv_error: string; // 本次读取 KV 失败的原因，续期失败时附在提示里
}

/** 该账号的 KV 存储键：按 uid 分离，两个账号互不覆盖。 */
function storeKeyFor(uid: string): string {
  return STORE_KEY_PREFIX + uid;
}

async function loadCred(env: Env, accessToken: string, refreshToken: string, uid: string): Promise<WbCred> {
  const c: WbCred = {
    token: accessToken.trim(),
    refresh_token: refreshToken.trim(),
    expires_ms: 0,
    base: "",
    kv_error: "",
  };
  c.base = c.token;
  const read = await kvReadJson<any>(env.CHECKIN_STATE, storeKeyFor(uid));
  c.kv_error = read.error;
  const kv = read.value;
  // 仅当 KV 记录基于当前 secret 生成（base 一致）时才采用；secret 被重新推送（值变化）后以 secret 为准
  if (kv && kv.token && kv.base === c.base) {
    c.token = kv.token;
    if (kv.refresh_token) c.refresh_token = kv.refresh_token;
    c.expires_ms = Number(kv.expires_ms) || 0;
  }
  return c;
}

function expiringSoon(c: WbCred): boolean {
  const exp = c.expires_ms || decodeJwtExp(c.token);
  return exp > 0 && exp - Date.now() <= REFRESH_AHEAD_MS;
}

function kvHint(c: WbCred): string {
  return c.kv_error ? `（注意：读取 KV 失败，可能未使用已续期的凭据：${c.kv_error}）` : "";
}

/** 调用刷新端点换发 token；成功时更新 c 并写入 KV。返回 [是否成功, 说明]。 */
async function refreshCred(env: Env, uid: string, c: WbCred): Promise<[boolean, string]> {
  if (!c.refresh_token) return [false, "未配置 WB_REFRESH_TOKEN"];
  const [sc, sb] = await requestJson(API_BASE + REFRESH_PATH, "POST", refreshHeaders(c.token, c.refresh_token, uid), {});
  if (sc === 0) return [false, `刷新请求未发出：${JSON.stringify(sb).slice(0, 120)}${kvHint(c)}`];
  const data = sb?.data;
  if (!(sc >= 200 && sc < 300) || sb?.code !== 0 || !data?.accessToken) {
    return [false, `刷新被拒 HTTP ${sc} code=${sb?.code} msg=${sb?.msg || sb?.raw || ""}`.slice(0, 200) + kvHint(c)];
  }
  c.token = data.accessToken;
  if (data.refreshToken) c.refresh_token = data.refreshToken;
  const expiresIn = Number(data.expiresIn) || 0;
  if (expiresIn > 0 && expiresIn < EXPIRES_IN_MAX_S) c.expires_ms = Date.now() + expiresIn * 1000;
  else c.expires_ms = decodeJwtExp(c.token);

  let note = `已自动续期 token（${c.expires_ms ? `新有效期约 ${((c.expires_ms - Date.now()) / 86400000).toFixed(1)} 天` : "有效期未知"}）`;
  const writeErr = await kvWriteJson(env.CHECKIN_STATE, storeKeyFor(uid), {
    token: c.token,
    refresh_token: c.refresh_token,
    expires_ms: c.expires_ms,
    base: c.base,
    updated_at: Date.now(),
  });
  if (writeErr) note += `；但 KV 写入失败（${writeErr}），请留意 refresh_token 是否失效`;
  return [true, note];
}

interface WbAccount {
  label: string; // 汇总里显示的名字，如 "WorkBuddy" / "WorkBuddy#2"
  uid: string;
  token: string;
  refresh_token: string;
  domain: string;
}

/** 从 env 收集已配置的账号（账号 1 必填，账号 2 可选）。 */
function collectAccounts(env: Env): WbAccount[] {
  const accounts: WbAccount[] = [];
  const uid1 = (env.WB_USER_ID || "").trim();
  if (uid1) {
    accounts.push({
      label: "WorkBuddy",
      uid: uid1,
      token: env.WB_ACCESS_TOKEN || "",
      refresh_token: env.WB_REFRESH_TOKEN || "",
      domain: (env.WB_DOMAIN || "").trim(),
    });
  }
  const uid2 = (env.WB2_USER_ID || "").trim();
  if (uid2) {
    accounts.push({
      label: "WorkBuddy#2",
      uid: uid2,
      token: env.WB2_ACCESS_TOKEN || "",
      refresh_token: env.WB2_REFRESH_TOKEN || "",
      domain: (env.WB2_DOMAIN || "").trim(),
    });
  }
  return accounts;
}

/** 单账号完整流程：续期 -> 签到 -> 成长中心。 */
async function runOne(env: Env, acc: WbAccount): Promise<CheckinResult> {
  const c = await loadCred(env, acc.token, acc.refresh_token, acc.uid);
  if (!c.token) {
    return {
      flag: "NO_CREDENTIAL",
      content: "未获取到 WorkBuddy 登录态，请设置 access token" +
        "（可运行 node scripts/export-env.mjs --login-workbuddy --push 重新登录并更新）",
    };
  }
  const notes: string[] = [];

  // 空 sub 的 token 是「未绑定用户身份」的空壳：签名合法、能过 /v3/config，但上游
  // 网关对 /v2/* 一律 401 HTML、refresh 回 12153。续期与重试都救不了，提前显形。
  if (!decodeJwtSub(c.token)) {
    return {
      flag: "AUTH_EXPIRED",
      content: "⚠️ token 未绑定用户身份（JWT 无 sub），上游将拒绝全部业务接口。" +
        "通常是该账号的设备授权登录没有完成身份联合（免费号首次授权常见），" +
        "请在官方客户端完成一次登录后再重新授权，或改用已开通会员/席位的账号。",
    };
  }

  // 临近过期先续期；续期失败不影响本次签到（现有 token 可能仍有效）
  if (c.refresh_token && expiringSoon(c)) {
    const [ok, msg] = await refreshCred(env, acc.uid, c);
    if (ok) notes.push(msg);
    else console.warn(`[workbuddy:${acc.uid}] 主动续期失败，沿用现有 token：${msg}`);
  }

  let result = await checkinOnce(c.token, acc.uid, acc.domain);
  // 鉴权失败：有续期材料时续期一次并重试
  if (result.flag === "TOKEN_EXPIRED" && c.refresh_token) {
    const [ok, msg] = await refreshCred(env, acc.uid, c);
    if (ok) {
      notes.push(msg);
      result = await checkinOnce(c.token, acc.uid, acc.domain);
    } else {
      result = { flag: result.flag, content: `${result.content}｜自动续期失败：${msg}` };
    }
  }

  let content = result.content;
  // 签到失败（令牌失效/网络异常等）时跳过成长中心；成长中心异常不影响已得到的签到结果
  if (result.flag === "SUCCESS" || result.flag === "ALREADY_TODAY") {
    try {
      content += `\n${await runGrowth(c.token, acc.uid, acc.domain)}`;
    } catch (e: any) {
      console.error(`[workbuddy:${acc.uid}] 成长中心异常:`, e);
      content += `\n成长中心异常：${e?.message || e}`;
    }
  }
  if (notes.length) content += `\n${notes.join("；")}`;
  return { flag: result.flag, content };
}

/** 完整运行：遍历所有已配置账号（账号间随机间隔，防同刻齐步触发风控）。
 *  返回值的 flag 取最差账号结果，content 按账号分段。 */
export async function run(env: Env): Promise<CheckinResult> {
  const accounts = collectAccounts(env);
  if (!accounts.length) {
    return {
      flag: "NO_CREDENTIAL",
      content: "未获取到 WorkBuddy 登录态，请设置 WB_ACCESS_TOKEN / WB_USER_ID" +
        "（账号 2 为 WB2_ACCESS_TOKEN / WB2_USER_ID，可选）",
    };
  }

  const results: CheckinResult[] = [];
  for (let i = 0; i < accounts.length; i++) {
    if (i > 0) {
      // 账号间随机停 2~6 秒：两个账号不要同一毫秒做同一动作
      const ms = 2000 + Math.floor(Math.random() * 4000);
      await new Promise((r) => setTimeout(r, ms));
    }
    const acc = accounts[i];
    try {
      results.push(await runOne(env, acc));
    } catch (e: any) {
      console.error(`[workbuddy:${acc.uid}] 执行异常:`, e);
      results.push({ flag: "ERROR", content: `⚠️ 执行异常：${e?.message || e}` });
    }
  }

  // 单账号：结果原样返回，不带账号分段标题
  if (results.length === 1) return results[0];

  // 多账号：flag 取最差（成功 < 已签 < 其他），content 按 label 分段
  const rank: Record<string, number> = { SUCCESS: 0, ALREADY_TODAY: 1 };
  let worst = results[0];
  for (const r of results) {
    if ((rank[r.flag] ?? 2) > (rank[worst.flag] ?? 2)) worst = r;
  }
  const lines = results.map((r, i) => `### ${accounts[i].label}\n${r.content.trim()}`);
  return { flag: worst.flag, content: lines.join("\n\n") };
}
