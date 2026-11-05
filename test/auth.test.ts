import { describe, expect, it } from "vitest";
import { authorize, csrfError, handleAuth } from "../src/auth";
import { envWith } from "./helpers";

const PASSWORD = "correct horse battery staple";
const env = envWith(undefined, { ADMIN_PASSWORD: PASSWORD });

function r(path: string, init: { method?: string; json?: unknown; cookie?: string; headers?: Record<string, string>; host?: string; csrf?: boolean } = {}) {
  const method = init.method || "GET";
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (method !== "GET" && init.csrf !== false) headers.set("x-requested-with", "dashboard");
  return new Request(`https://${init.host || "panel.example"}${path}`, {
    method,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
}

async function login(e = env, password = PASSWORD) {
  const res = await handleAuth(r("/api/login", { method: "POST", json: { password } }), e);
  return res!;
}
const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0];

describe("POST /api/login", () => {
  it("密码正确：200 并下发 HttpOnly / Secure / SameSite=Strict 的 Cookie", async () => {
    const res = await login();
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^auth=[0-9a-f]{64};/);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) expect(setCookie).toContain(attr);
    expect(setCookie).not.toContain(PASSWORD);
  });

  it("密码错误 / 缺失 / 请求体非法：401 且不下发 Cookie", async () => {
    for (const json of [{ password: "nope" }, { password: "" }, {}, { password: 123 }]) {
      const res = await handleAuth(r("/api/login", { method: "POST", json }), env);
      expect(res!.status).toBe(401);
      expect(res!.headers.get("set-cookie")).toBeNull();
    }
    const bad = await handleAuth(new Request("https://panel.example/api/login", { method: "POST", headers: { "x-requested-with": "dashboard" }, body: "not json" }), env);
    expect(bad!.status).toBe(401);
  });

  it("未配置 ADMIN_PASSWORD：503", async () => {
    const res = await login(envWith(), "anything");
    expect(res.status).toBe(503);
  });

  it("密码里误带的换行会被忽略（env 与输入两侧）", async () => {
    const res = await login(envWith(undefined, { ADMIN_PASSWORD: PASSWORD + "\n" }));
    expect(res.status).toBe(200);
  });

  it("缺少 CSRF 头或跨站 Origin：403", async () => {
    expect((await handleAuth(r("/api/login", { method: "POST", json: { password: PASSWORD }, csrf: false }), env))!.status).toBe(403);
    expect((await handleAuth(r("/api/login", { method: "POST", json: { password: PASSWORD }, headers: { origin: "https://evil.example" } }), env))!.status).toBe(403);
  });
});

describe("authorize", () => {
  it("有效 Cookie 放行；无 Cookie / 错误 Cookie 返回 401", async () => {
    const c = cookieOf(await login());
    expect(await authorize(r("/api/tasks", { cookie: c }), env)).toBeNull();
    expect((await authorize(r("/api/tasks"), env))!.status).toBe(401);
    expect((await authorize(r("/api/tasks", { cookie: "auth=" + "0".repeat(64) }), env))!.status).toBe(401);
    expect((await authorize(r("/api/tasks", { cookie: "auth=short" }), env))!.status).toBe(401);
  });

  it("Cookie 在多个 Cookie 中也能被识别", async () => {
    const c = cookieOf(await login());
    expect(await authorize(r("/api/tasks", { cookie: `a=1; ${c}; b=2` }), env)).toBeNull();
  });

  it("修改密码后旧 Cookie 失效", async () => {
    const c = cookieOf(await login());
    const changed = envWith(undefined, { ADMIN_PASSWORD: "a different password" });
    expect((await authorize(r("/api/tasks", { cookie: c }), changed))!.status).toBe(401);
  });

  it("未配置密码：503（即使带了 Cookie）", async () => {
    const c = cookieOf(await login());
    expect((await authorize(r("/api/tasks", { cookie: c }), envWith()))!.status).toBe(503);
  });

  it("localhost 免登录（本地开发）", async () => {
    expect(await authorize(r("/api/tasks", { host: "localhost:8787" }), envWith())).toBeNull();
    expect(await authorize(r("/api/tasks", { host: "127.0.0.1:8787" }), env)).toBeNull();
  });
});

describe("GET /api/session", () => {
  it("未登录 / 已登录 / 未配置 / 本地", async () => {
    const get = async (cookie?: string, e = env, host?: string) => (await (await handleAuth(r("/api/session", { cookie, host }), e))!.json()) as any;
    expect(await get()).toEqual({ authenticated: false, required: true, configured: true });
    expect(await get(cookieOf(await login()))).toMatchObject({ authenticated: true, required: true });
    expect(await get(undefined, envWith())).toEqual({ authenticated: false, required: true, configured: false });
    expect(await get(undefined, envWith(), "localhost")).toMatchObject({ authenticated: true, required: false });
  });
});

describe("POST /api/logout", () => {
  it("清除 Cookie；缺少 CSRF 头时 403", async () => {
    const res = (await handleAuth(r("/api/logout", { method: "POST" }), env))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^auth=;.*Max-Age=0/);
    expect((await handleAuth(r("/api/logout", { method: "POST", csrf: false }), env))!.status).toBe(403);
  });
});

describe("路由与 csrfError", () => {
  it("非登录相关路径返回 null（交给后续处理）", async () => {
    expect(await handleAuth(r("/api/tasks"), env)).toBeNull();
    expect(await handleAuth(r("/api/login"), env)).toBeNull(); // GET 不是登录
  });
  it("GET 不做 CSRF 检查；同源 Origin 放行", () => {
    expect(csrfError(r("/api/tasks"))).toBeNull();
    expect(csrfError(r("/api/tasks", { method: "PUT", headers: { origin: "https://panel.example" } }))).toBeNull();
  });
});
