import { afterEach, describe, expect, it, vi } from "vitest";
import { postJson, requestJson } from "../src/lib/http";

afterEach(() => vi.unstubAllGlobals());

describe("postJson / requestJson", () => {
  it("返回 [status, json]，并附带 JSON 头与序列化 body", async () => {
    const f = vi.fn().mockResolvedValue(new Response('{"ok":1}', { status: 200 }));
    vi.stubGlobal("fetch", f);
    expect(await postJson("https://x", { A: "b" }, { k: 1 })).toEqual([200, { ok: 1 }]);
    const init = f.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json", A: "b" });
    expect(init.body).toBe('{"k":1}');
  });

  it("字符串 body 原样发送", async () => {
    const f = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", f);
    await postJson("https://x", {}, "raw");
    expect(f.mock.calls[0][1].body).toBe("raw");
  });

  it("非 JSON 响应保留前 300 字符到 raw", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x".repeat(500), { status: 502 })));
    const [sc, body] = await postJson("https://x", {});
    expect(sc).toBe(502);
    expect(body.raw).toHaveLength(300);
  });

  it("网络异常返回 [0, {error}]", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await postJson("https://x", {})).toEqual([0, { error: "down" }]);
    expect(await requestJson("https://x", "GET", {})).toEqual([0, { error: "down" }]);
  });

  it("超时会中止请求", async () => {
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) =>
      new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted")))),
    );
    expect(await postJson("https://x", {}, {}, 10)).toEqual([0, { error: "aborted" }]);
  });

  it("requestJson：GET 不带 body，方法名转大写", async () => {
    const f = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", f);
    await requestJson("https://x", "get", {}, { a: 1 });
    expect(f.mock.calls[0][1].method).toBe("GET");
    expect(f.mock.calls[0][1].body).toBeUndefined();
  });

  it("requestJson：POST 序列化对象、字符串原样", async () => {
    const f = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", f);
    await requestJson("https://x", "POST", {}, { a: 1 });
    await requestJson("https://x", "POST", {}, "s");
    expect(f.mock.calls[0][1].body).toBe('{"a":1}');
    expect(f.mock.calls[1][1].body).toBe("s");
  });
});
