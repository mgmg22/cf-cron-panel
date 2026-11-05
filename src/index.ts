/// <reference types="@cloudflare/workers-types" />
/// Worker 入口：
/// - scheduled()：Cron Trigger 每分钟触发，由 scheduler 按 KV 任务配置运行到点的任务；
/// - fetch()：/api/login|logout|session 处理登录，其余 /api/* 需已登录（auth.ts），其他请求交给静态资源（public/）。

import type { Env } from "./types";
import { handleApi } from "./api";
import { authorize, handleAuth } from "./auth";
import { runDue } from "./scheduler";

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        const authResponse = await handleAuth(request, env);
        if (authResponse) return authResponse;
        const denied = await authorize(request, env);
        if (denied) return denied;
        return await handleApi(request, env);
      } catch (e) {
        console.error("[api] 未捕获异常:", e);
        return jsonError(500, e instanceof Error ? e.message : String(e));
      }
    }
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not Found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await runDue(env, new Date(event.scheduledTime));
    } catch (e) {
      console.error("[scheduled] 执行异常:", e);
    }
  },
};
