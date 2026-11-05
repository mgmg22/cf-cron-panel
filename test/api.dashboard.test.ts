import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/api";
import { envWith, fakeKv, req } from "./helpers";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const body = async (r: Response) => (await r.json()) as any;

describe("GET /api/tasks", () => {
  it("未保存配置时返回默认 cron 与启用状态", async () => {
    const { kv } = fakeKv();
    const d = await body(await handleApi(req("/api/tasks"), envWith(kv)));
    expect(d.kvBound).toBe(true);
    expect(d.tasks.map((t: any) => [t.id, t.cron, t.enabled])).toEqual([
      ["checkin", "8 0 * * *", true],
      ["xb", "3,33 8-23 * * *", true],
    ]);
    expect(d.tasks[0].nextRunAt).toBeGreaterThan(d.now);
    expect(d.tasks[0].lastRun).toBeNull();
  });

  it("读取已保存配置、忽略非法 cron、禁用时无下次运行时间、带出最近一次结果", async () => {
    const last = { trigger: "cron", startedAt: 1, flag: "SUCCESS", content: "ok" };
    const { kv } = fakeKv({
      "cfg:tasks": { checkin: { cron: "0 9 * * *", enabled: false }, xb: { cron: "garbage", enabled: true } },
      "run:xb": last,
    });
    const d = await body(await handleApi(req("/api/tasks"), envWith(kv)));
    const [checkin, xb] = d.tasks;
    expect(checkin).toMatchObject({ cron: "0 9 * * *", enabled: false, nextRunAt: null });
    expect(xb).toMatchObject({ cron: "3,33 8-23 * * *", lastRun: last });
  });

  it("未绑定 KV 也能列出（默认配置）", async () => {
    const d = await body(await handleApi(req("/api/tasks"), envWith()));
    expect(d.kvBound).toBe(false);
    expect(d.tasks).toHaveLength(2);
  });
});

describe("PUT /api/tasks/:id", () => {
  it("缺少 X-Requested-With 或跨站 Origin 被拒绝", async () => {
    const { kv } = fakeKv();
    const r1 = await handleApi(req("/api/tasks/xb", { method: "PUT", json: { enabled: false }, csrf: false }), envWith(kv));
    expect(r1.status).toBe(403);
    const r2 = await handleApi(req("/api/tasks/xb", { method: "PUT", json: {}, headers: { origin: "https://evil.example" } }), envWith(kv));
    expect(r2.status).toBe(403);
    const r3 = await handleApi(req("/api/tasks/xb", { method: "PUT", json: { enabled: false }, headers: { origin: "https://panel.example" } }), envWith(kv));
    expect(r3.status).toBe(200);
  });

  it("保存 cron（规范化空白）并持久化；其他任务不受影响", async () => {
    const { kv, store } = fakeKv();
    const r = await handleApi(req("/api/tasks/xb", { method: "PUT", json: { cron: "  5   8-22   * * * " } }), envWith(kv));
    expect(r.status).toBe(200);
    expect((await body(r)).cron).toBe("5 8-22 * * *");
    expect(JSON.parse(store.get("cfg:tasks")!)).toEqual({
      checkin: { cron: "8 0 * * *", enabled: true },
      xb: { cron: "5 8-22 * * *", enabled: true },
    });
  });

  it("切换启用状态", async () => {
    const { kv, store } = fakeKv();
    const r = await body(await handleApi(req("/api/tasks/checkin", { method: "PUT", json: { enabled: false } }), envWith(kv)));
    expect(r).toMatchObject({ enabled: false, nextRunAt: null });
    expect(JSON.parse(store.get("cfg:tasks")!).checkin.enabled).toBe(false);
  });

  it("参数非法返回 400，且不写 KV", async () => {
    const { kv, store } = fakeKv();
    for (const json of [{ cron: "* * * *" }, { cron: 5 }, { enabled: "yes" }]) {
      const r = await handleApi(req("/api/tasks/xb", { method: "PUT", json }), envWith(kv));
      expect(r.status).toBe(400);
    }
    expect(store.size).toBe(0);
  });

  it("任务不存在 404", async () => {
    const r = await handleApi(req("/api/tasks/nope", { method: "PUT", json: { enabled: true } }), envWith(fakeKv().kv));
    expect(r.status).toBe(404);
  });

  it("未绑定 KV 返回 503；读取 KV 失败时拒绝覆盖保存", async () => {
    const r1 = await handleApi(req("/api/tasks/xb", { method: "PUT", json: { enabled: false } }), envWith());
    expect(r1.status).toBe(503);
    const failing = fakeKv({ "cfg:tasks": { xb: { cron: "1 * * * *", enabled: true } } }, { failGet: true });
    const r2 = await handleApi(req("/api/tasks/xb", { method: "PUT", json: { enabled: false } }), envWith(failing.kv));
    expect(r2.status).toBe(503);
    expect(JSON.parse(failing.store.get("cfg:tasks")!).xb.cron).toBe("1 * * * *");
  });

  it("KV 写失败返回 503", async () => {
    const { kv } = fakeKv({}, { failPut: true });
    const r = await handleApi(req("/api/tasks/xb", { method: "PUT", json: { enabled: false } }), envWith(kv));
    expect(r.status).toBe(503);
  });
});

describe("GET /api/cron/preview", () => {
  it("合法表达式返回接下来 3 次", async () => {
    const d = await body(await handleApi(req("/api/cron/preview?expr=" + encodeURIComponent("*/10 * * * *")), envWith()));
    expect(d.ok).toBe(true);
    expect(d.next).toHaveLength(3);
    expect(d.next[1] - d.next[0]).toBe(600_000);
  });
  it("非法表达式返回原因", async () => {
    const d = await body(await handleApi(req("/api/cron/preview?expr=bad"), envWith()));
    expect(d).toMatchObject({ ok: false, next: [] });
    expect(d.error).toBeTruthy();
  });
});

describe("GET /api/status", () => {
  it("只返回是否已配置与变量名，不泄露任何凭据内容", async () => {
    const env = envWith(fakeKv().kv, { WB_ACCESS_TOKEN: "TOP-SECRET-1", WB_USER_ID: "u1", API_KEY: "TOP-SECRET-2" });
    const res = await handleApi(req("/api/status"), env);
    const text = await res.text();
    expect(text).not.toContain("TOP-SECRET");
    const byId = Object.fromEntries(JSON.parse(text).items.map((i: any) => [i.id, i]));
    expect(byId.workbuddy).toMatchObject({ configured: true, optional: false, vars: expect.arrayContaining(["WB_ACCESS_TOKEN", "WB_USER_ID"]) });
    expect(byId.workbuddy2).toMatchObject({ configured: false, optional: true });
    expect(byId.xbAi.configured).toBe(false); // 只配了 API_KEY，缺 API_URL
    expect(byId.kv.configured).toBe(true);
    for (const i of Object.values<any>(byId)) expect(i.whenMissing).toBeTruthy();
  });
});

describe("路由", () => {
  it("未知接口 404", async () => {
    expect((await handleApi(req("/api/unknown"), envWith())).status).toBe(404);
    expect((await handleApi(req("/api/tasks/xb", { method: "DELETE" }), envWith())).status).toBe(404);
  });
});
