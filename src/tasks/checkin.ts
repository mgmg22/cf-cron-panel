/// 聚合签到任务组：WorkBuddy -> Trae Work -> MiniMax Code 依次执行，汇总成一条 server酱 通知。
/// 单个子任务抛异常只影响自己（记为 ERROR），不中断后续子任务。

import type { CheckinResult, Env, Flag } from "../types";
import { notifyServerJ } from "../lib/notify";
import { run as workbuddyRun } from "./workbuddy";
import { run as traeRun } from "./trae";
import { run as minimaxRun } from "./minimax";

interface StepDef {
  name: string;
  fn: (env: Env) => Promise<CheckinResult>;
}

// 顺序即执行顺序
const STEPS: StepDef[] = [
  { name: "WorkBuddy", fn: workbuddyRun },
  { name: "Trae Work", fn: traeRun },
  { name: "MiniMax Code", fn: minimaxRun },
];

const FLAG_ICON: Record<Flag, string> = {
  SUCCESS: "✅",
  ALREADY_TODAY: "ℹ️",
  NET_ERR: "⚠️",
  HTTP_ERR: "⚠️",
  FAIL: "⚠️",
  TOKEN_EXPIRED: "⚠️",
  AUTH_EXPIRED: "⚠️",
  RATE_LIMITED: "⏳",
  NO_CREDENTIAL: "⚠️",
  STATUS_ERR: "⚠️",
  IMPORT_FAIL: "⚠️",
  ERROR: "⚠️",
};

const isOk = (f: Flag) => f === "SUCCESS" || f === "ALREADY_TODAY";

export function buildSummary(results: [string, CheckinResult][]): string {
  const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" });
  const lines = [`## ${now} Token签到汇总`, ""];
  let ok = 0;
  for (const [name, r] of results) {
    lines.push(`${FLAG_ICON[r.flag]} **${name}**：`);
    const body = (r.content || "").trim();
    if (body) {
      for (const ln of body.split("\n")) lines.push(ln.trim() ? `> ${ln}` : "");
    } else {
      lines.push("> (空)");
    }
    if (isOk(r.flag)) ok++;
    lines.push("");
  }
  lines.push(`**共 ${results.length} 项，成功/已签 ${ok} 项**`);
  return lines.join("\n");
}

/** 整组结果：全部成功/已签时，有任一 SUCCESS 为 SUCCESS，否则 ALREADY_TODAY；否则取第一个异常子任务的 flag。 */
function groupFlag(results: [string, CheckinResult][]): Flag {
  const bad = results.find(([, r]) => !isOk(r.flag));
  if (bad) return bad[1].flag;
  return results.some(([, r]) => r.flag === "SUCCESS") ? "SUCCESS" : "ALREADY_TODAY";
}

export async function run(env: Env): Promise<CheckinResult> {
  const results: [string, CheckinResult][] = [];
  for (const s of STEPS) {
    try {
      const r = await s.fn(env);
      results.push([s.name, r]);
      console.log(`[${s.name}] ${r.flag}`);
    } catch (e: any) {
      results.push([s.name, { flag: "ERROR", content: `⚠️ 执行异常：${e?.message || e}` }]);
      console.error(`[${s.name}] ERROR`, e);
    }
  }
  const summary = buildSummary(results);
  const okCount = results.filter(([, r]) => isOk(r.flag)).length;
  try {
    const sent = await notifyServerJ(`每日Token签到汇总✅${okCount}/${results.length}`, summary, env.NOTIFY_PUSH_KEY);
    if (!sent) console.warn("[notify] 汇总通知推送失败");
  } catch (e) {
    console.warn("[notify] 通知失败", e);
  }
  return { flag: groupFlag(results), content: summary };
}
