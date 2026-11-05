/// 面板可管理的任务清单。新增任务：在此登记 id / 名称 / 默认 cron / run。

import type { CheckinResult, Env } from "../types";
import { run as checkinRun } from "./checkin";
import { run as xbRun } from "./xb";

export type TaskId = "checkin" | "xb";

export interface RunOptions {
  dry?: boolean; // 仅 supportsDry 的任务生效：试运行，不写状态、不推送
}

export interface TaskDef {
  id: TaskId;
  name: string;
  description: string;
  defaultCron: string; // 北京时间 5 段 cron；KV 里没有配置时使用
  supportsDry: boolean;
  run: (env: Env, opts?: RunOptions) => Promise<CheckinResult>;
}

export const TASKS: TaskDef[] = [
  {
    id: "checkin",
    name: "聚合签到",
    description: "WorkBuddy → Trae Work → MiniMax Code 依次签到，汇总一条 server酱通知",
    defaultCron: "8 0 * * *",
    supportsDry: false,
    run: (env) => checkinRun(env),
  },
  {
    id: "xb",
    name: "XB 线报",
    description: "抓取线报 → 过滤去重 → AI 评分 → 钉钉推送",
    defaultCron: "3,33 8-23 * * *",
    supportsDry: true,
    run: (env, opts) => xbRun(env, { dry: opts?.dry }),
  },
];

export function getTask(id: string): TaskDef | undefined {
  return TASKS.find((t) => t.id === id);
}
