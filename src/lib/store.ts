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

const LEGACY_CONFIG_KEY = CONFIG_KEY; // 旧版整体存储在 cfg:tasks，仅作读取回退
const taskKey = (id: string) => `cfg:task:${id}`; // 每任务独立 key，保存互不覆盖

function sanitize(s: Partial<TaskConfig> | null | undefined, def: TaskConfig): TaskConfig {
  const cron = typeof s?.cron === "string" && !validateCron(s.cron) ? s.cron.trim() : def.cron;
  const enabled = typeof s?.enabled === "boolean" ? s.enabled : def.enabled;
  return { cron, enabled };
}

/** 读取任务配置并与默认值合并；error 非空表示 KV 读取失败（此时返回全部默认值）。
 *  并行读取各任务 key；仅当有任务尚无独立 key 时才再读一次旧版 cfg:tasks 作回退。 */
export async function loadConfig(
  kv: KVNamespace | undefined,
  defaults: Record<string, TaskConfig>,
): Promise<{ config: Record<string, TaskConfig>; error: string }> {
  const ids = Object.keys(defaults);
  const reads = await Promise.all(ids.map((id) => kvReadJson<Partial<TaskConfig>>(kv, taskKey(id))));
  let error = reads.map((r) => r.error).find(Boolean) || "";
  let legacy: Record<string, Partial<TaskConfig>> = {};
  if (!error && reads.some((r) => !r.value)) {
    const l = await kvReadJson<Record<string, Partial<TaskConfig>>>(kv, LEGACY_CONFIG_KEY);
    error = l.error;
    if (l.value && typeof l.value === "object") legacy = l.value;
  }
  const config: Record<string, TaskConfig> = {};
  ids.forEach((id, i) => {
    config[id] = sanitize(reads[i].value ?? legacy[id], defaults[id]);
  });
  return { config, error };
}

/** 只保存单个任务的配置（独立 key，并发保存不同任务互不覆盖）；返回失败原因，成功返回空串。 */
export async function saveTaskConfig(kv: KVNamespace | undefined, id: string, cfg: TaskConfig): Promise<string> {
  if (!kv) return "未绑定 KV（CHECKIN_STATE），无法保存";
  return kvWriteJson(kv, taskKey(id), cfg);
}

export async function loadLastRun(kv: KVNamespace | undefined, id: string): Promise<RunRecord | null> {
  return (await kvReadJson<RunRecord>(kv, RUN_KEY_PREFIX + id)).value;
}

/** 覆盖保存最近一次结果；内容超长会截断。返回失败原因，成功或未绑定 KV 返回空串。 */
export async function saveLastRun(kv: KVNamespace | undefined, id: string, rec: RunRecord): Promise<string> {
  const content = rec.content.length > MAX_CONTENT_CHARS ? rec.content.slice(0, MAX_CONTENT_CHARS) + "\n…(已截断)" : rec.content;
  return kvWriteJson(kv, RUN_KEY_PREFIX + id, { ...rec, content });
}
