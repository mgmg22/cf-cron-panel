/// 面板状态存储（KV）：任务配置 `cfg:tasks`、每个任务最近一次运行结果 `run:<id>`。
/// 读取失败或字段非法时回退默认值，保证没有面板配置时任务仍按默认 cron 运行。

import type { Flag } from "../types";
import { validateCron } from "./cron";
import { kvReadJson, kvWriteJson } from "./kv";

const CONFIG_KEY = "cfg:tasks";
const RUN_KEY_PREFIX = "run:";
const MAX_CONTENT_CHARS = 8000;

export interface TaskConfig {
  cron: string;
  enabled: boolean;
}

export interface RunRecord {
  trigger: "cron" | "manual";
  startedAt: number;
  flag: Flag;
  content: string;
}

/** 读取任务配置并与默认值合并；error 非空表示 KV 读取失败（此时返回全部默认值）。 */
export async function loadConfig(
  kv: KVNamespace | undefined,
  defaults: Record<string, TaskConfig>,
): Promise<{ config: Record<string, TaskConfig>; error: string }> {
  const r = await kvReadJson<Record<string, Partial<TaskConfig>>>(kv, CONFIG_KEY);
  const saved = r.value && typeof r.value === "object" ? r.value : {};
  const config: Record<string, TaskConfig> = {};
  for (const [id, def] of Object.entries(defaults)) {
    const s = saved[id];
    const cron = typeof s?.cron === "string" && !validateCron(s.cron) ? s.cron.trim() : def.cron;
    const enabled = typeof s?.enabled === "boolean" ? s.enabled : def.enabled;
    config[id] = { cron, enabled };
  }
  return { config, error: r.error };
}

/** 保存完整任务配置；返回失败原因，成功返回空串。未绑定 KV 视为失败。 */
export async function saveConfig(kv: KVNamespace | undefined, config: Record<string, TaskConfig>): Promise<string> {
  if (!kv) return "未绑定 KV（CHECKIN_STATE），无法保存";
  return kvWriteJson(kv, CONFIG_KEY, config);
}

export async function loadLastRun(kv: KVNamespace | undefined, id: string): Promise<RunRecord | null> {
  return (await kvReadJson<RunRecord>(kv, RUN_KEY_PREFIX + id)).value;
}

/** 覆盖保存最近一次结果；内容超长会截断。返回失败原因，成功或未绑定 KV 返回空串。 */
export async function saveLastRun(kv: KVNamespace | undefined, id: string, rec: RunRecord): Promise<string> {
  const content = rec.content.length > MAX_CONTENT_CHARS ? rec.content.slice(0, MAX_CONTENT_CHARS) + "\n…(已截断)" : rec.content;
  return kvWriteJson(kv, RUN_KEY_PREFIX + id, { ...rec, content });
}
