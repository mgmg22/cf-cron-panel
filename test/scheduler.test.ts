import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const mk = (id: string, defaultCron: string, supportsDry: boolean, result: any) => ({
    id,
    name: id,
    description: "",
    defaultCron,
    supportsDry,
    run: vi.fn(async (_env: unknown, opts?: { dry?: boolean }) => {
      calls.push(id + (opts?.dry ? ":dry" : ""));
      if (result instanceof Error) throw result;
      return result;
    }),
  });
  return { calls, mk, tasks: [] as any[] };
});

vi.mock("../src/tasks/registry", () => {
  h.tasks.push(
    h.mk("a", "8 0 * * *", false, { flag: "SUCCESS", content: "a ok" }),
    h.mk("b", "*/30 * * * *", true, new Error("boom")),
  );
  return { TASKS: h.tasks, getTask: (id: string) => h.tasks.find((t: any) => t.id === id) };
});

import { handleApi } from "../src/api";
import { runDue, runTask } from "../src/scheduler";
import { envWith, fakeKv, req } from "./helpers";

const bj = (h_: number, mi: number) => new Date(Date.UTC(2026, 0, 5, h_ - 8, mi));

beforeEach(() => {
  h.calls.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runDue", () => {
  it("只运行到点且启用的任务", async () => {
    const { kv } = fakeKv({ "cfg:tasks": { a: { cron: "8 0 * * *", enabled: true }, b: { cron: "0 12 * * *", enabled: true } } });
    await runDue(envWith(kv), bj(0, 8));
    expect(h.calls).toEqual(["a"]);
  });

  it("禁用的任务到点也不运行", async () => {
    const { kv } = fakeKv({ "cfg:tasks": { a: { cron: "8 0 * * *", enabled: false } } });
    await runDue(envWith(kv), bj(0, 8));
    expect(h.calls).toEqual([]);
  });

  it("没有配置 / 未绑定 KV 时按默认 cron 运行", async () => {
    await runDue(envWith(), bj(0, 8));
    expect(h.calls).toEqual(["a"]);
    h.calls.length = 0;
    await runDue(envWith(), bj(9, 30)); // b 默认 */30
    expect(h.calls).toEqual(["b"]);
  });

  it("KV 读取失败时回退默认配置而不是跳过", async () => {
    const { kv } = fakeKv({}, { failGet: true });
    await runDue(envWith(kv), bj(0, 8));
    expect(h.calls).toEqual(["a"]);
  });

  it("一个任务抛异常不影响同一分钟的其他任务", async () => {
    const { kv, store } = fakeKv({ "cfg:tasks": { a: { cron: "0 0 * * *", enabled: true }, b: { cron: "0 0 * * *", enabled: true } } });
    await runDue(envWith(kv), bj(0, 0));
    expect(h.calls).toEqual(["a", "b"]);
    expect(JSON.parse(store.get("run:b")!)).toMatchObject({ flag: "ERROR", trigger: "cron" });
  });
});

describe("runTask", () => {
  it("覆盖保存最近一次结果", async () => {
    const { kv, store } = fakeKv({ "run:a": { flag: "FAIL", content: "old" } });
    const rec = await runTask(envWith(kv), h.tasks[0], "manual");
    expect(rec).toMatchObject({ flag: "SUCCESS", content: "a ok", trigger: "manual" });
    expect(JSON.parse(store.get("run:a")!)).toMatchObject({ flag: "SUCCESS", content: "a ok" });
  });

  it("dry 不保存", async () => {
    const { kv, store } = fakeKv();
    await runTask(envWith(kv), h.tasks[1], "manual", { dry: true });
    expect(store.size).toBe(0);
  });

  it("超长内容被截断", async () => {
    const { kv, store } = fakeKv();
    h.tasks[0].run.mockResolvedValueOnce({ flag: "SUCCESS", content: "x".repeat(20000) });
    await runTask(envWith(kv), h.tasks[0], "cron");
    expect(JSON.parse(store.get("run:a")!).content.length).toBeLessThan(8100);
  });
});

describe("POST /api/tasks/:id/run", () => {
  it("手动运行并直接返回结果、保存最近一次", async () => {
    const { kv, store } = fakeKv();
    const res = await handleApi(req("/api/tasks/a/run", { method: "POST", json: {} }), envWith(kv));
    const d = (await res.json()) as any;
    expect(d.record).toMatchObject({ flag: "SUCCESS", trigger: "manual" });
    expect(store.has("run:a")).toBe(true);
  });

  it("dry 仅对 supportsDry 的任务生效", async () => {
    const { kv, store } = fakeKv();
    await handleApi(req("/api/tasks/a/run", { method: "POST", json: { dry: true } }), envWith(kv));
    expect(h.calls).toEqual(["a"]); // a 不支持 dry，按真实运行
    expect(store.has("run:a")).toBe(true);
    h.calls.length = 0;
    const d = (await (await handleApi(req("/api/tasks/b/run", { method: "POST", json: { dry: true } }), envWith(kv))).json()) as any;
    expect(h.calls).toEqual(["b:dry"]);
    expect(d.dry).toBe(true);
    expect(store.has("run:b")).toBe(false);
  });

  it("缺少 CSRF 头 403；任务不存在 404", async () => {
    const env = envWith(fakeKv().kv);
    expect((await handleApi(req("/api/tasks/a/run", { method: "POST", csrf: false }), env)).status).toBe(403);
    expect((await handleApi(req("/api/tasks/zzz/run", { method: "POST" }), env)).status).toBe(404);
  });
});

describe("定时触发的结果在面板可见", () => {
  it("runDue 运行后，GET /api/tasks 返回该任务最近一次结果且触发方式为 cron", async () => {
    const { kv } = fakeKv();
    const env = envWith(kv);
    await runDue(env, bj(0, 8)); // 默认 cron：a 在 00:08 到点
    const d = (await (await handleApi(req("/api/tasks"), env)).json()) as any;
    const a = d.tasks.find((t: any) => t.id === "a");
    const b = d.tasks.find((t: any) => t.id === "b");
    expect(a.lastRun).toMatchObject({ trigger: "cron", flag: "SUCCESS", content: "a ok" });
    expect(a.lastRun.startedAt).toBeGreaterThan(0);
    expect(b.lastRun).toBeNull(); // 未到点的任务没有记录
  });

  it("定时运行后手动运行会覆盖为 manual，反之亦然", async () => {
    const { kv } = fakeKv();
    const env = envWith(kv);
    await runDue(env, bj(0, 8));
    await handleApi(req("/api/tasks/a/run", { method: "POST", json: {} }), env);
    let d = (await (await handleApi(req("/api/tasks"), env)).json()) as any;
    expect(d.tasks[0].lastRun.trigger).toBe("manual");
    await runDue(env, bj(0, 8));
    d = (await (await handleApi(req("/api/tasks"), env)).json()) as any;
    expect(d.tasks[0].lastRun.trigger).toBe("cron");
  });

  it("未绑定 KV 时定时运行不保存结果（面板无记录）", async () => {
    const env = envWith();
    await runDue(env, bj(0, 8));
    expect(h.calls).toEqual(["a"]);
    const d = (await (await handleApi(req("/api/tasks"), env)).json()) as any;
    expect(d.tasks[0].lastRun).toBeNull();
  });
});
