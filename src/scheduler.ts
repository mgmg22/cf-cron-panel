/// 任务执行与按分钟调度：Cron Trigger 每分钟触发一次，这里按 KV 中的任务配置判断哪些任务到点。

import type { CheckinResult, Env } from "./types";
import { cronMatches, parseCron } from "./lib/cron";
import { loadConfig, saveLastRun, type RunRecord, type TaskConfig } from "./lib/store";
import { TASKS, type RunOptions, type TaskDef } from "./tasks/registry";

export function defaultConfig(): Record<string, TaskConfig> {
  return Object.fromEntries(TASKS.map((t) => [t.id, { cron: t.defaultCron, enabled: true }]));
}

export function loadTaskConfig(env: Env) {
  return loadConfig(env.CHECKIN_STATE, defaultConfig());
}

/** 执行单个任务：异常转为 ERROR 结果；非 dry 时覆盖保存「最近一次结果」。 */
export async function runTask(
  env: Env,
  task: TaskDef,
  trigger: RunRecord["trigger"],
  opts?: RunOptions,
): Promise<RunRecord> {
  const startedAt = Date.now();
  let result: CheckinResult;
  try {
    result = await task.run(env, opts);
  } catch (e: any) {
    console.error(`[${task.id}] 执行异常`, e);
    result = { flag: "ERROR", content: `⚠️ 执行异常：${e?.message || e}` };
  }
  const record: RunRecord = { trigger, startedAt, ...result };
  console.log(`[${task.id}] ${record.flag}（${trigger}）`);
  if (!opts?.dry) {
    const err = await saveLastRun(env.CHECKIN_STATE, task.id, record);
    if (err) console.warn(`[${task.id}] 保存运行结果失败：${err}`);
  }
  return record;
}

/** 运行 `now` 这一分钟到点的所有已启用任务（顺序执行，共用本次调用的子请求额度）。 */
export async function runDue(env: Env, now: Date): Promise<void> {
  const { config, error } = await loadTaskConfig(env);
  if (error) console.warn(`[scheduler] 读取任务配置失败，使用默认配置：${error}`);
  for (const task of TASKS) {
    const cfg = config[task.id];
    if (!cfg.enabled || !cronMatches(parseCron(cfg.cron), now)) continue;
    await runTask(env, task, "cron");
  }
}
