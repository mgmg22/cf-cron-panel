/// 面板登录：单个管理员密码（Secret `ADMIN_PASSWORD`），无状态 Cookie 会话。
/// - 登录成功下发 `auth` Cookie，值为 HMAC-SHA256(密码, 固定串)；校验时重算比对，因此修改密码即让全部会话失效；
/// - 未配置 ADMIN_PASSWORD 时所有面板接口返回 503；本地开发（localhost）免登录；
/// - 修改类请求须带 `X-Requested-With: dashboard` 且 Origin（若有）同源，防跨站触发。

import type { Env } from "./types";

const COOKIE_NAME = "auth";
const COOKIE_MAX_AGE_S = 30 * 86400; // 仅浏览器端保存时长；服务端不记录会话，也不校验过期
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const enc = new TextEncoder();

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

async function hmacHex(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 管理员密码（去掉误带的换行）；未配置返回空串。 */
function adminPassword(env: Env): string {
  return (env.ADMIN_PASSWORD || "").replace(/[\r\n]/g, "");
}

const sessionToken = (password: string) => hmacHex(password, "checkin-dashboard-session");

/** 输入先各自做 HMAC 再比较，避免长度和内容泄露。 */
async function passwordMatches(input: string, password: string): Promise<boolean> {
  return constantTimeEqual(await hmacHex("password-compare", input), await hmacHex("password-compare", password));
}

function readCookie(header: string | null, name: string): string {
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

const isLocal = (request: Request) => LOCAL_HOSTS.has(new URL(request.url).hostname);

async function hasValidSession(request: Request, password: string): Promise<boolean> {
  const cookie = readCookie(request.headers.get("cookie"), COOKIE_NAME);
  return Boolean(password && cookie) && constantTimeEqual(cookie, await sessionToken(password));
}

/** 修改类请求的跨站防护；通过返回 null。 */
export function csrfError(request: Request): Response | null {
  if (request.method.toUpperCase() === "GET") return null;
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "跨站请求被拒绝" }, 403);
  if (request.headers.get("x-requested-with") !== "dashboard") return json({ error: "缺少 X-Requested-With 请求头" }, 403);
  return null;
}

const cookieAttrs = "Path=/; HttpOnly; Secure; SameSite=Strict";

/** 登录 / 退出 / 会话查询（无需已登录）。不属于这三个接口时返回 null。 */
export async function handleAuth(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  const method = request.method.toUpperCase();
  const password = adminPassword(env);

  if (method === "GET" && path === "/api/session") {
    const local = isLocal(request);
    return json({ authenticated: local || (await hasValidSession(request, password)), required: !local, configured: Boolean(password) });
  }

  if (method === "POST" && path === "/api/login") {
    const blocked = csrfError(request);
    if (blocked) return blocked;
    if (!password) return json({ error: "未配置 ADMIN_PASSWORD，面板已禁用" }, 503);
    let input = "";
    try {
      const body = (await request.json()) as { password?: unknown };
      if (typeof body?.password === "string") input = body.password.replace(/[\r\n]/g, "");
    } catch {
      /* 视为空密码 */
    }
    if (!(await passwordMatches(input, password))) return json({ error: "密码错误" }, 401);
    return json({ ok: true }, 200, {
      "set-cookie": `${COOKIE_NAME}=${await sessionToken(password)}; Max-Age=${COOKIE_MAX_AGE_S}; ${cookieAttrs}`,
    });
  }

  if (method === "POST" && path === "/api/logout") {
    const blocked = csrfError(request);
    if (blocked) return blocked;
    return json({ ok: true }, 200, { "set-cookie": `${COOKIE_NAME}=; Max-Age=0; ${cookieAttrs}` });
  }
  return null;
}

/** 其余 /api/* 的准入：本地放行；未配置密码 503；无有效会话 401。放行返回 null。 */
export async function authorize(request: Request, env: Env): Promise<Response | null> {
  if (isLocal(request)) return null;
  const password = adminPassword(env);
  if (!password) return json({ error: "未配置 ADMIN_PASSWORD，面板已禁用" }, 503);
  if (await hasValidSession(request, password)) return null;
  return json({ error: "未登录" }, 401);
}
