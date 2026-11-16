/// XB 线报推送子模块：markdown 组装 + 钉钉机器人推送（与抓取/过滤/AI 解耦）。

import type { Env } from "../types";
import { notifyDingding } from "../lib/notify";

export interface XbPushItem {
  title: string;
  href: string;
  text: string;
  src_list?: string[];
  score: string;
}

export function buildXbMarkdown(items: XbPushItem[]): string {
  let markdown = "";
  for (const it of items) {
    markdown += `\n##### 📌[${it.title}🌟${it.score}](${it.href})\n${it.text}\n`;
    for (const img of it.src_list || []) markdown += `![](${img})`;
  }
  return markdown;
}

/** 推送到钉钉；未配置 token 视为无需推送（返回 true）。 */
export function pushXb(env: Env, title: string, markdown: string): Promise<boolean> {
  return notifyDingding(title, markdown, env.XB_BOT_TOKEN, env.XB_BOT_TOKEN_SECRET);
}
