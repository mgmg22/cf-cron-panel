/// 面板 JSON 接口（/api/*）。登录鉴权在 index.ts / auth.ts 完成；这里只做路由、参数校验与业务编排。

import type { Env } from "./types";
import { csrfError } from "./auth";
import { nextRun, parseCron, validateCron } from "./lib/cron";
import { loadLastRun, saveConfig, type RunRecord, type TaskConfig } from "./lib/store";
import { loadTaskConfig, runTask } from "./scheduler";
import { getTask, TASKS } from "./tasks/registry";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const fail = (status: number, error: string) => json({ error }, status);

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await request.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function nextRunAt(cfg: TaskConfig, now: Date): number | null {
  if (!cfg.enabled) return null;
  return nextRun(parseCron(cfg.cron), now)?.getTime() ?? null;
}

async function listTasks(env: Env): Promise<Response> {
  const now = new Date();
  const { config, error } = await loadTaskConfig(env);
  const tasks = await Promise.all(
    TASKS.map(async (t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      defaultCron: t.defaultCron,
      supportsDry: t.supportsDry,
      cron: config[t.id].cron,
      enabled: config[t.id].enabled,
      nextRunAt: nextRunAt(config[t.id], now),
      lastRun: await loadLastRun(env.CHECKIN_STATE, t.id),
    })),
  );
  return json({ now: now.getTime(), kvBound: Boolean(env.CHECKIN_STATE), kvError: error, tasks });
}

async function updateTask(request: Request, env: Env, id: string): Promise<Response> {
  const task = getTask(id);
  if (!task) return fail(404, "任务不存在");
  const body = await readBody(request);
  const { config, error } = await loadTaskConfig(env);
  // 读取失败时不能基于默认值覆盖保存，否则会冲掉已有配置
  if (error) return fail(503, `读取任务配置失败，已拒绝保存：${error}`);

  const next = { ...config[id] };
  if (body.cron !== undefined) {
    if (typeof body.cron !== "string") return fail(400, "cron 须为字符串");
    const err = validateCron(body.cron);
    if (err) return fail(400, err);
    next.cron = body.cron.trim().split(/\s+/).join(" ");
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return fail(400, "enabled 须为布尔值");
    next.enabled = body.enabled;
  }
  const saveErr = await saveConfig(env.CHECKIN_STATE, { ...config, [id]: next });
  if (saveErr) return fail(503, `保存失败：${saveErr}`);
  return json({ id, cron: next.cron, enabled: next.enabled, nextRunAt: nextRunAt(next, new Date()) });
}

async function runNow(request: Request, env: Env, id: string): Promise<Response> {
  const task = getTask(id);
  if (!task) return fail(404, "任务不存在");
  const body = await readBody(request);
  const dry = body.dry === true && task.supportsDry;
  const record: RunRecord = await runTask(env, task, "manual", { dry });
  return json({ id, dry, record });
}

function previewCron(url: URL): Response {
  const expr = url.searchParams.get("expr") || "";
  const error = validateCron(expr);
  if (error) return json({ ok: false, error, next: [] });
  const spec = parseCron(expr);
  const next: number[] = [];
  let cursor = new Date();
  for (let i = 0; i < 3; i++) {
    const n = nextRun(spec, cursor);
    if (!n) break;
    next.push(n.getTime());
    cursor = n;
  }
  return json({ ok: true, error: "", next });
}

/** 凭据 / 绑定是否已配置（只返回布尔值与变量名，不返回任何内容）。 */
function status(env: Env): Response {
  const has = (v: unknown) => typeof v === "string" && v.trim() !== "";
  const items = [
    { id: "workbuddy", label: "WorkBuddy 账号 1", usedBy: "聚合签到", vars: ["WB_ACCESS_TOKEN", "WB_USER_ID", "WB_REFRESH_TOKEN（可选）"], optional: false, configured: has(env.WB_ACCESS_TOKEN) && has(env.WB_USER_ID), whenMissing: "WorkBuddy 签到返回「未配置凭据」" },
    { id: "workbuddy2", label: "WorkBuddy 账号 2", usedBy: "聚合签到", vars: ["WB2_ACCESS_TOKEN", "WB2_USER_ID", "WB2_REFRESH_TOKEN（可选）"], optional: true, configured: has(env.WB2_ACCESS_TOKEN) && has(env.WB2_USER_ID), whenMissing: "只签到账号 1" },
    { id: "trae", label: "Trae Work", usedBy: "聚合签到", vars: ["TRAE_TOKEN", "TRAE_REFRESH_TOKEN", "TRAE_DEVICE_KEY_PEM", "TRAE_DEVICE_PUB_PEM", "TRAE_DEVICE_ID"], optional: false, configured: has(env.TRAE_TOKEN) || (has(env.TRAE_REFRESH_TOKEN) && has(env.TRAE_DEVICE_KEY_PEM)), whenMissing: "Trae 签到返回「未配置凭据」" },
    { id: "minimax", label: "MiniMax Code", usedBy: "聚合签到", vars: ["MINIMAX_TOKEN", "MINIMAX_USER_ID"], optional: false, configured: has(env.MINIMAX_TOKEN) && has(env.MINIMAX_USER_ID), whenMissing: "MiniMax 签到返回「未配置凭据」" },
    { id: "serverJ", label: "server酱 通知", usedBy: "聚合签到（汇总通知）", vars: ["NOTIFY_PUSH_KEY"], optional: true, configured: has(env.NOTIFY_PUSH_KEY), whenMissing: "不发送签到汇总通知" },
    { id: "xbAi", label: "AI 接口", usedBy: "XB 线报（AI 评分筛选）", vars: ["API_KEY", "API_URL"], optional: true, configured: has(env.API_KEY) && has(env.API_URL), whenMissing: "跳过 AI 筛选，按原列表推送" },
    { id: "xbDingding", label: "钉钉机器人", usedBy: "XB 线报（推送）", vars: ["XB_BOT_TOKEN", "XB_BOT_TOKEN_SECRET（可选，加签）"], optional: false, configured: has(env.XB_BOT_TOKEN), whenMissing: "线报不会推送" },
    { id: "kv", label: "KV 存储", usedBy: "面板配置、运行结果、续期凭据、线报去重", vars: ["CHECKIN_STATE（wrangler.toml 绑定）"], optional: false, configured: Boolean(env.CHECKIN_STATE), whenMissing: "无法保存面板配置与运行结果，续期凭据不缓存，线报会重复推送" },
  ];
  return json({ items });
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  const blocked = csrfError(request);
  if (blocked) return blocked;

  const path = url.pathname.replace(/\/+$/, "");
  if (method === "GET" && path === "/api/tasks") return listTasks(env);
  if (method === "GET" && path === "/api/status") return status(env);
  if (method === "GET" && path === "/api/cron/preview") return previewCron(url);

  const m = /^\/api\/tasks\/([^/]+)(\/run)?$/.exec(path);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (m[2] && method === "POST") return runNow(request, env, id);
    if (!m[2] && method === "PUT") return updateTask(request, env, id);
  }
  return fail(404, "接口不存在");
}
