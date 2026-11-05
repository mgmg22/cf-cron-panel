/// <reference types="@cloudflare/workers-types" />

export interface Env {
  // 所有凭据类变量均为可选：缺失时由各任务返回 NO_CREDENTIAL
  // WorkBuddy（账号 1）
  WB_ACCESS_TOKEN?: string;
  WB_USER_ID?: string;
  WB_REFRESH_TOKEN?: string; // 可选：配置后自动续期 token（由 export-env.mjs --login-workbuddy 导出）
  WB_DOMAIN?: string; // 可选：出站 X-Domain 头（取自登录态 auth.domain，如 www.workbuddy.cn）
  // WorkBuddy（账号 2，可选；不配置则只跑账号 1）
  WB2_ACCESS_TOKEN?: string;
  WB2_USER_ID?: string;
  WB2_REFRESH_TOKEN?: string;
  WB2_DOMAIN?: string; // 同 WB_DOMAIN
  // Trae Work
  TRAE_TOKEN?: string;
  TRAE_DEVICE_ID?: string;
  TRAE_USER_ID?: string;
  TRAE_REFRESH_TOKEN?: string;
  TRAE_DEVICE_KEY_PEM?: string; // base64(PEM) 单行
  TRAE_DEVICE_PUB_PEM?: string; // base64(PEM) 单行
  TRAE_MACHINE_ID?: string;
  TRAE_APP_VERSION?: string;
  // MiniMax Code（OAuth2 设备授权，见 scripts/export-env.mjs --login-minimax）
  MINIMAX_REFRESH_TOKEN?: string; // 长效凭据：设备授权获得的独立 refresh token（轮换后的值由 Worker 存 KV）
  MINIMAX_ACCESS_TOKEN?: string; // 可选：直接给短时 accessToken（mmoat_ 开头），一般不用配
  MINIMAX_USER_ID?: string;
  MINIMAX_UUID?: string;
  MINIMAX_DEVICE_ID?: string;
  // XB 线报（AI 分析 + 钉钉推送）
  API_KEY?: string; // OpenAI 兼容接口密钥
  API_URL?: string; // OpenAI 兼容接口地址（含 /chat/completions）
  XB_BOT_TOKEN?: string; // 线报钉钉机器人 access_token
  XB_BOT_TOKEN_SECRET?: string; // 可选：钉钉机器人加签密钥（SEC 开头）
  // 通知
  NOTIFY_PUSH_KEY?: string;
  // KV（wrangler.toml 绑定，可选）：面板配置与运行结果、续期凭据、线报去重都存这里；不绑定则这些都不可用
  CHECKIN_STATE?: KVNamespace;
  // 面板登录密码（未配置则面板接口返回 503；本地 localhost 开发免登录）
  ADMIN_PASSWORD?: string;
  // 静态资源（wrangler.toml [assets] 绑定）
  ASSETS?: Fetcher;
}

/** 任务结果标识；新增取值须同步 tasks/checkin.ts 的 FLAG_ICON（Record<Flag,...> 会在编译期提示）。 */
export type Flag =
  | "SUCCESS"
  | "ALREADY_TODAY"
  | "NET_ERR"
  | "HTTP_ERR"
  | "FAIL"
  | "TOKEN_EXPIRED"
  | "AUTH_EXPIRED"
  | "RATE_LIMITED"
  | "NO_CREDENTIAL"
  | "STATUS_ERR"
  | "IMPORT_FAIL"
  | "ERROR";

export interface CheckinResult {
  flag: Flag;
  content: string;
}
