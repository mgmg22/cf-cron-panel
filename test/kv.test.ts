import { describe, expect, it, vi } from "vitest";
import { kvReadJson, kvWriteJson } from "../src/lib/kv";

function fakeKv(impl: Partial<{ get: any; put: any }>): KVNamespace {
  return impl as unknown as KVNamespace;
}

describe("kv", () => {
  it("未绑定 KV：读返回 null 无错误，写返回空串", async () => {
    expect(await kvReadJson(undefined, "k")).toEqual({ value: null, error: "" });
    expect(await kvWriteJson(undefined, "k", 1)).toBe("");
  });

  it("读成功/键不存在", async () => {
    const get = vi.fn().mockResolvedValue({ a: 1 });
    expect(await kvReadJson(fakeKv({ get }), "k")).toEqual({ value: { a: 1 }, error: "" });
    expect(get).toHaveBeenCalledWith("k", "json");
    expect(await kvReadJson(fakeKv({ get: async () => null }), "k")).toEqual({ value: null, error: "" });
  });

  it("读失败不抛异常，返回错误文本", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await kvReadJson(fakeKv({ get: async () => { throw new Error("boom"); } }), "k");
    expect(r).toEqual({ value: null, error: "boom" });
  });

  it("写成功返回空串，失败返回错误文本", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const put = vi.fn().mockResolvedValue(undefined);
    expect(await kvWriteJson(fakeKv({ put }), "k", { x: 1 })).toBe("");
    expect(put).toHaveBeenCalledWith("k", '{"x":1}');
    expect(await kvWriteJson(fakeKv({ put: async () => { throw new Error("quota"); } }), "k", 1)).toBe("quota");
  });
});
