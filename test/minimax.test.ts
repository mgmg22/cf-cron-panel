import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthHeader,
  cleanValue,
  oauthForm,
  parseTokenGrant,
  pyQuotePlus,
  readCachedAuth,
  run,
} from "../src/tasks/minimax";
import type { Env } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pyQuotePlus（须与 Python urllib.parse.quote_plus 一致）", () => {
  it("安全字符不转义", () => {
    expect(pyQuotePlus("AZaz09_.-~")).toBe("AZaz09_.-~");
  });
  it("空格 -> +", () => {
    expect(pyQuotePlus("a b")).toBe("a+b");
  });
  it("保留字符按大写十六进制转义", () => {
    expect(pyQuotePlus("a/b?c=d&e")).toBe("a%2Fb%3Fc%3Dd%26e");
    expect(pyQuotePlus("*'()!")).toBe("%2A%27%28%29%21");
  });
  it("空串", () => {
    expect(pyQuotePlus("")).toBe("");
  });
  it("非 ASCII 字符按 UTF-8 字节转义（与 Python 一致）", () => {
    expect(pyQuotePlus("你")).toBe("%E4%BD%A0");
    expect(pyQuotePlus("é a")).toBe("%C3%A9+a");
    expect(pyQuotePlus("😀")).toBe("%F0%9F%98%80");
  });
});

describe("cleanValue", () => {
  it("去首尾空白", () => {
    expect(cleanValue("  abc \n")).toBe("abc");
  });
  it("去成对引号（含嵌套与引号内空白）", () => {
    expect(cleanValue('"abc"')).toBe("abc");
    expect(cleanValue("'abc'")).toBe("abc");
    expect(cleanValue(`" 'abc' "`)).toBe("abc");
  });
  it("不成对的引号保留", () => {
    expect(cleanValue(`"abc'`)).toBe(`"abc'`);
    expect(cleanValue(`"abc`)).toBe(`"abc`);
  });
  it("空/undefined 输入", () => {
    expect(cleanValue("")).toBe("");
    expect(cleanValue(undefined as unknown as string)).toBe("");
  });
});

describe("OAuth2 凭据辅助函数", () => {
  it("只发 Bearer 头", () => {
    expect(buildAuthHeader("mmoat_abc")).toBe("Bearer mmoat_abc");
  });
  it("忽略字段不完整的 KV 记录，读取完整结构", () => {
    expect(readCachedAuth({ token: "eyJhbGciOiJIUzI1NiJ9.x.y", updated_at: 1 })).toBeNull();
    expect(readCachedAuth(null)).toBeNull();
    expect(readCachedAuth({
      accessToken: "mmoat_a", refreshToken: "mmort_b", expiresAtMs: 123, updated_at: 1,
    })).toEqual({ accessToken: "mmoat_a", refreshToken: "mmort_b", expiresAtMs: 123, updated_at: 1 });
  });
  it("refresh token 轮换：有新值用新值，缺失时沿用旧值", () => {
    const g = parseTokenGrant({ access_token: "mmoat_new", refresh_token: "mmort_new", expires_in: 3600 }, "mmort_old");
    expect(g?.accessToken).toBe("mmoat_new");
    expect(g?.refreshToken).toBe("mmort_new");
    expect(g!.expiresAtMs - Date.now()).toBeGreaterThan(3500 * 1000);
    expect(parseTokenGrant({ access_token: "mmoat_new" }, "mmort_old")?.refreshToken).toBe("mmort_old");
    expect(parseTokenGrant({ error: "invalid_grant" }, "mmort_old")).toBeNull();
  });
  it("刷新表单包含官方客户端的四要素", () => {
    const body = oauthForm({
      grant_type: "refresh_token", refresh_token: "mmort_a b", client_id: "mcode-public",
      scope: "agent.default", audience: "agent-backend",
    });
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=mmort_a+b");
    expect(body).toContain("scope=agent.default");
    expect(body).toContain("audience=agent-backend");
  });
});

// ---- run() 流程测试：mock fetch 与 KV ----

const OK_STATUS = { base_resp: { status_code: 0, status_msg: "ok" }, data: { days: [{ is_today: true, status: 1, day_no: 2 }] } };
const OK_CLAIM = { base_resp: { status_code: 0, status_msg: "ok" }, data: { claim_result: 1, points: 400, day_no: 2 } };
const GRANT = {
  access_token: "mmoat_new", refresh_token: "mmort_new", token_type: "bearer",
  expires_in: 43200, scope: "agent.default",
};
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function mockKv(value: unknown = null) {
  return { get: vi.fn().mockResolvedValue(value), put: vi.fn().mockResolvedValue(undefined) };
}

function baseEnv(kv: ReturnType<typeof mockKv>, extra: Partial<Env> = {}): Env {
  return { MINIMAX_USER_ID: "547901267608952833", CHECKIN_STATE: kv as any, ...extra };
}

describe("run() OAuth2 自续签到", () => {
  it("无缓存时用 Secret 里的 refresh token 刷新，写回 KV 并用 Bearer 签到", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const kv = mockKv();
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.startsWith("https://account.minimax.io/oauth2/token")) return jsonRes(GRANT);
      if (url.includes("/signin/status")) return jsonRes(OK_STATUS);
      if (url.includes("/signin/claim")) return jsonRes(OK_CLAIM);
      return jsonRes({}, 404);
    }));

    const r = await run(baseEnv(kv, { MINIMAX_REFRESH_TOKEN: "mmort_old" }));
    expect(r.flag).toBe("SUCCESS");
    expect(r.content).toContain("+400");

    const oauthCall = calls.find((c) => c.url.startsWith("https://account.minimax.io/oauth2/token"))!;
    expect(oauthCall.init.body).toContain("grant_type=refresh_token");
    expect(oauthCall.init.body).toContain("client_id=mcode-public");
    expect(oauthCall.init.body).toContain("audience=agent-backend");

    const statusCall = calls.find((c) => c.url.includes("/signin/status"))!;
    expect(statusCall.init.headers).toMatchObject({ authorization: "Bearer mmoat_new" });
    expect(JSON.stringify(statusCall.init.headers)).not.toContain('"token"');

    expect(kv.put).toHaveBeenCalledTimes(1);
    const [key, raw] = kv.put.mock.calls[0];
    expect(key).toBe("minimax");
    expect(JSON.parse(raw)).toMatchObject({ accessToken: "mmoat_new", refreshToken: "mmort_new" });
  });

  it("KV 缓存未过期时直接复用，不触发轮换（避免并发刷新作废凭据）", async () => {
    const kv = mockKv({
      accessToken: "mmoat_cached", refreshToken: "mmort_cached",
      expiresAtMs: Date.now() + 3600_000, updated_at: Date.now(),
    });
    const f = vi.fn(async (url: string) => {
      if (url.includes("/signin/status")) {
        return jsonRes({ base_resp: { status_code: 0 }, data: { days: [{ is_today: true, status: 3, day_no: 2 }] } });
      }
      return jsonRes({}, 404);
    });
    vi.stubGlobal("fetch", f);

    const r = await run(baseEnv(kv));
    expect(r.flag).toBe("ALREADY_TODAY");
    expect(f).toHaveBeenCalledTimes(1);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("缓存 token 被服务端判 401 时强制刷新一次再重试", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const kv = mockKv({
      accessToken: "mmoat_stale", refreshToken: "mmort_cached",
      expiresAtMs: Date.now() + 3600_000, updated_at: Date.now(),
    });
    let statusHits = 0;
    const f = vi.fn(async (url: string) => {
      if (url.startsWith("https://account.minimax.io/oauth2/token")) return jsonRes(GRANT);
      if (url.includes("/signin/status")) {
        statusHits++;
        return statusHits === 1 ? jsonRes({ message: "unauthorized" }, 401) : jsonRes(OK_STATUS);
      }
      if (url.includes("/signin/claim")) return jsonRes(OK_CLAIM);
      return jsonRes({}, 404);
    });
    vi.stubGlobal("fetch", f);

    const r = await run(baseEnv(kv));
    expect(r.flag).toBe("SUCCESS");
    expect(statusHits).toBe(2);
    expect(f.mock.calls.filter((c) => String(c[0]).startsWith("https://account.minimax.io/oauth2/token"))).toHaveLength(1);
  });

  it("未配置任何凭据时给出重新授权指引", async () => {
    const kv = mockKv();
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const r = await run(baseEnv(kv));
    expect(r.flag).toBe("AUTH_EXPIRED");
    expect(r.content).toContain("--login-minimax");
    expect(r.content).toContain("未找到 refresh token");
    expect(f).not.toHaveBeenCalled();
  });
});
