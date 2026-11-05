import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyDingding, notifyServerJ } from "../src/lib/notify";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("notifyServerJ", () => {
  it("未配置 key：不发请求，视为成功", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await notifyServerJ("t", "c")).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });
  it("HTTP 2xx 成功；非 2xx / 网络异常失败", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    expect(await notifyServerJ("t", "c", "KEY")).toBe(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));
    expect(await notifyServerJ("t", "c", "KEY")).toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("x")));
    expect(await notifyServerJ("t", "c", "KEY")).toBe(false);
  });
  it("请求形态：URL 含 key，title/desp 编码，换行翻倍", async () => {
    const f = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", f);
    await notifyServerJ("标题", "a\nb", "KEY");
    expect(f.mock.calls[0][0]).toBe("https://sctapi.ftqq.com/KEY.send");
    expect(f.mock.calls[0][1].body).toBe(`text=${encodeURIComponent("标题")}&desp=${encodeURIComponent("a\n\nb")}`);
  });
});

describe("notifyDingding", () => {
  it("未配置 token：不发请求，视为成功", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await notifyDingding("t", "c")).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });
  it("errcode=0 成功；errcode!=0、非 2xx、非 JSON、网络异常均失败", async () => {
    const mk = (body: string, status = 200) => vi.fn().mockResolvedValue(new Response(body, { status }));
    vi.stubGlobal("fetch", mk('{"errcode":0}'));
    expect(await notifyDingding("t", "c", "T")).toBe(true);
    vi.stubGlobal("fetch", mk('{"errcode":310000}'));
    expect(await notifyDingding("t", "c", "T")).toBe(false);
    vi.stubGlobal("fetch", mk('{"errcode":0}', 500));
    expect(await notifyDingding("t", "c", "T")).toBe(false);
    vi.stubGlobal("fetch", mk("not json"));
    expect(await notifyDingding("t", "c", "T")).toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("x")));
    expect(await notifyDingding("t", "c", "T")).toBe(false);
  });
  it("配置 secret 时 URL 附带 timestamp 与 sign", async () => {
    const f = vi.fn().mockResolvedValue(new Response('{"errcode":0}'));
    vi.stubGlobal("fetch", f);
    await notifyDingding("t", "c", "TOKEN", "SECabc");
    const url = new URL(f.mock.calls[0][0]);
    expect(url.searchParams.get("access_token")).toBe("TOKEN");
    expect(url.searchParams.get("timestamp")).toMatch(/^\d{13}$/);
    expect(url.searchParams.get("sign")).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
  it("无 secret 时不带签名", async () => {
    const f = vi.fn().mockResolvedValue(new Response('{"errcode":0}'));
    vi.stubGlobal("fetch", f);
    await notifyDingding("t", "c", "TOKEN");
    expect(f.mock.calls[0][0]).not.toContain("sign=");
  });
});
