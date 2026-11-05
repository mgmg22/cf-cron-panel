# cf-cron-panel

运行在 Cloudflare Worker 上的定时任务面板：用一条每分钟的 Cron Trigger 按面板里保存的 cron 调度任务，面板可修改 cron、启停任务、手动运行、查看最近一次结果。无需常驻服务器，TypeScript 编写，无构建步骤的单页前端。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mgmg22/cf-cron-panel)

内置任务（变量名沿用青龙脚本库 [QinglongMy](https://github.com/mgmg22/QinglongMy) 中的同名脚本；与青龙项目无关联）：

| 任务 | 说明 |
| --- | --- |
| WorkBuddy | 多账号每日签到 + 成长中心（派猫旅行/开盲盒），并汇总「总剩余积分」 |
| Trae Work | 每日积分签到，内置 ECDSA 设备私钥自动续期 token |
| MiniMax Code | 每日积分签到，先续期再签到 |
| XB 线报 | 抓 0818tuan 线报 → 黑白名单过滤 → KV 去重 → AI 评分 → 钉钉推 markdown |

## 定时与面板

`wrangler.toml` 只配置**一条每分钟触发**的 Cron（`* * * * *`）。每次触发时 `scheduled()` 读取 KV 里的任务配置，按各任务的 cron 判断是否到点并执行（`src/scheduler.ts`）。因此任务的 cron 和启用状态都在**面板**里修改，不需要重新部署；KV 最终一致，改动在其他节点最长约 1 分钟后才会被调度读到。

| 任务 | 默认 cron（北京时间） | 说明 |
| --- | --- | --- |
| 聚合签到 `checkin` | `8 0 * * *`（00:08） | WorkBuddy → Trae → MiniMax 依次执行，合并成一条 server酱 通知 |
| XB 线报 `xb` | `3,33 8-23 * * *`（8~23 点每小时 03/33 分） | 线报抓取 + AI 评分 + 钉钉推送 |

- cron 为标准 5 段（分 时 日 月 周），**一律按北京时间**；日和周同时限定时取「或」。不支持秒级和名称（MON/JAN）。最小精度 1 分钟。
- 默认 cron 定义在 `src/tasks/registry.ts`；KV 里没有配置、未绑定 KV 或读取失败时按默认值运行。
- 「定时任务」页：每个任务一行，可编辑 cron（弹窗内有下次运行预览）、启用/禁用、立即运行、查看**最近一次**结果（状态、时间、触发方式、内容）；XB 另有「试运行」（不写去重、不推钉钉、结果不保存）。
- 「凭据状态」页：每项凭据/绑定的用途、变量名、是否已配置、未配置时的影响（只显示是否配置，不显示内容）。
- 定时和手动运行写入同一份「最近一次结果」，后写覆盖先写，`trigger` 区分来源。没有运行历史、实时日志、中途停止，也没有手动与定时运行之间的互斥锁；「运行中」只是当前页面的本地状态。
- KV 最终一致：定时运行刚结束时面板可能约 1 分钟内仍显示上一次结果。Cron 被平台延迟或丢失的那一分钟不会补跑，可通过「最近一次结果」的时间发现。

## 目录结构

```
├─ wrangler.toml          # Worker 配置、每分钟 cron、静态资源与 KV 绑定；不含 [vars]
├─ src/
│  ├─ index.ts            # scheduled() 每分钟入口 / fetch()：/api/* 需登录，其余走静态资源
│  ├─ api.ts              # 面板 JSON 接口
│  ├─ auth.ts             # 面板登录（ADMIN_PASSWORD + Cookie 会话）
│  ├─ scheduler.ts        # 任务执行（runTask）与按分钟调度（runDue）
│  ├─ types.ts            # Env / Flag / CheckinResult 类型
│  ├─ tasks/              # registry（面板任务清单）/ checkin（聚合）/ workbuddy / trae / minimax / xb
│  └─ lib/                # http / api / kv / store / cron / crypto / jwt / md5 / notify / encoding
├─ public/                # 面板前端（单页，无构建步骤）
├─ test/                  # vitest 单元测试
└─ scripts/
   └─ export-env.mjs      # 导出登录态变量，可直接推送到 Cloudflare Secrets
```

任务统一返回 `CheckinResult { flag, content }`；聚合签到的整组 `flag`：全部成功/已签时有任一 `SUCCESS` 为 `SUCCESS`、否则 `ALREADY_TODAY`，有异常时取第一个异常子任务的 `flag`；`flag` 是 `types.ts` 的 `Flag` 联合类型，`SUCCESS` / `ALREADY_TODAY` 计入成功，其余在汇总里标为异常。新增面板任务：在 `src/tasks/` 实现 `run(env)`，并在 `tasks/registry.ts` 登记（`id` 同时扩充 `TaskId`）；新增聚合签到子任务则加入 `tasks/checkin.ts` 的 `STEPS`；新增 `Flag` 取值须同步 `tasks/checkin.ts` 的 `FLAG_ICON`（`Record<Flag, string>`，漏写会编译报错）。

## 面板登录

只需设置一个 Secret：**`ADMIN_PASSWORD`**（管理员密码）。未设置时面板接口一律返回 503（面板默认关闭）。

```bash
npx wrangler secret put ADMIN_PASSWORD
```

- 打开 Worker 域名会进入登录页（`public/login.html`），密码正确后下发 `auth` Cookie（`HttpOnly; Secure; SameSite=Strict`，浏览器端保存 30 天），之后访问 `/api/*` 校验该 Cookie；左下角「退出登录」清除 Cookie。
- Cookie 值是 `HMAC-SHA256(ADMIN_PASSWORD, 固定串)`，**无状态**：服务端不保存会话，也没有服务端过期时间；修改 `ADMIN_PASSWORD` 即让所有已登录的浏览器失效。密码比较为常量时间。
- **没有登录失败次数限制**：请设置足够长的随机密码（建议 16 位以上）；如需更强保护，可在 Cloudflare 控制台给该域名加 Access 或 WAF 速率限制规则（与 Worker 无关，不需要改代码）。
- 修改类接口（PUT/POST，含登录）要求请求头 `X-Requested-With: dashboard`，且 `Origin`（若有）与请求同源，用于防止被其他网页跨站触发。
- `localhost` / `127.0.0.1` / `[::1]`（`npm run dev`）免登录，仅用于本地调试。
- 面板接口：`POST /api/login`（`{password}`）、`POST /api/logout`、`GET /api/session`（以上无需登录）；`GET /api/tasks`、`PUT /api/tasks/:id`（`{cron?, enabled?}`）、`POST /api/tasks/:id/run`（`{dry?}`）、`GET /api/cron/preview?expr=`、`GET /api/status`（需登录）。

## 变量（Secrets）

**不要写进 `wrangler.toml` 的 `[vars]`**（否则 `wrangler deploy` 会清空控制台里已填好的值）。全部用 Cloudflare Secrets（加密存储），Worker 内通过 `env.X` 读取，两种录入方式任选：

- `node scripts/export-env.mjs --push [--worker 名称]`：导出登录态并逐个 `wrangler secret put`（详见下一节）；
- 控制台「Workers & Pages → 你的 Worker → Settings → Variables and Secrets」逐项录入（类型选 Secret）。

清单与 `src/types.ts` 的 `Env` 一一对应，凭据类变量在类型上均为可选，缺失时对应任务返回 `NO_CREDENTIAL`（XB 缺 `API_URL` / `API_KEY` 时跳过 AI 筛选，按原列表推送）：

- WorkBuddy：`WB_ACCESS_TOKEN` / `WB_USER_ID`（`WB_REFRESH_TOKEN` 可选，配置后自动续期；`WB_DOMAIN` 可选，出站 X-Domain 头，默认 www.workbuddy.cn）。
  支持第 2 个账号（可选）：`WB2_ACCESS_TOKEN` / `WB2_USER_ID` / `WB2_REFRESH_TOKEN`（可选）/ `WB2_DOMAIN`（可选）。两个账号都会自动签到 + 成长中心，账号间随机间隔 2~6 秒防风控；不配置 WB2_* 则只跑账号 1。
  续期后的滚动凭据按账号分键存 KV（`workbuddy:<uid>`）。
- Trae：`TRAE_TOKEN` / `TRAE_DEVICE_ID` / `TRAE_USER_ID` / `TRAE_REFRESH_TOKEN` /
  `TRAE_DEVICE_KEY_PEM` / `TRAE_DEVICE_PUB_PEM`（base64(PEM) 单行或真 PEM）/ `TRAE_MACHINE_ID`（可选）；
  `TRAE_APP_VERSION` 内置默认 `1.107.1`，可选覆盖
- MiniMax：`MINIMAX_TOKEN` / `MINIMAX_USER_ID` / `MINIMAX_UUID`（可选）/ `MINIMAX_DEVICE_ID`（可选）
- XB 线报：`API_KEY` / `API_URL`（OpenAI 兼容接口，含 `/chat/completions`）、`XB_BOT_TOKEN` / `XB_BOT_TOKEN_SECRET`（可选，钉钉加签）
- 通知：`NOTIFY_PUSH_KEY`（server酱）
- 面板：`ADMIN_PASSWORD`（登录密码，见上一节，必填才能使用面板）

## 从本机导出变量（`scripts/export-env.mjs`）

只依赖 Node 内置模块。读取本机已登录桌面端的登录态：

| 应用 | 读取的文件 | 导出的变量 |
| --- | --- | --- |
| WorkBuddy | `CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`；或 `--login-workbuddy` 浏览器授权登录 | `WB_USER_ID`、`WB_DOMAIN`、`WB_ACCESS_TOKEN`、`WB_REFRESH_TOKEN`（见下方说明） |
| Trae | `<TRAE SOLO CN 或 Trae CN>/User/globalStorage/storage.json`（解密 `iCubeAuthInfo://` 信封） | `TRAE_TOKEN` / `TRAE_DEVICE_ID` / `TRAE_USER_ID` / `TRAE_REFRESH_TOKEN` / `TRAE_DEVICE_KEY_PEM` / `TRAE_DEVICE_PUB_PEM`（base64 单行）/ `TRAE_MACHINE_ID` |
| MiniMax | `MiniMax Agent/minimax-agent-config.json` | `MINIMAX_TOKEN` / `MINIMAX_USER_ID`（`MINIMAX_UUID` / `MINIMAX_DEVICE_ID` 使用 Worker 内默认值，Worker 每次运行会先续期 token） |

文件所在根目录：Windows 为 `%APPDATA%` / `%LOCALAPPDATA%`，macOS 为 `~/Library/Application Support`，Linux 为 `~/.config`；也可用 `--workbuddy-info` / `--trae-storage` / `--minimax-config` 指定文件。

```bash
node scripts/export-env.mjs                    # 打印 KEY=VALUE（诊断信息走 stderr）
node scripts/export-env.mjs --only trae --mask # 只导出 Trae，值只显示首尾几位
node scripts/export-env.mjs --json             # JSON 输出
node scripts/export-env.mjs --push             # 推送到 Cloudflare Secrets（--worker 指定 Worker 名）
```

- `--push` 时，shell 环境里已设置的 `WB_ACCESS_TOKEN` / `WB_REFRESH_TOKEN` / `NOTIFY_PUSH_KEY` / `API_KEY` / `API_URL` / `XB_BOT_TOKEN` / `XB_BOT_TOKEN_SECRET` / `ADMIN_PASSWORD` 会一并推送，且优先于本机读取值：`API_KEY=... API_URL=... node scripts/export-env.mjs --push`。
- WorkBuddy 桌面端把 `accessToken` 加密存储（`{ $wbEncrypted, envelope }`，密钥不在该文件内），脚本无法从文件读取，只导出 `WB_USER_ID` / `WB_DOMAIN`。需要令牌时用 `--login-workbuddy`：脚本向设备授权端点（`copilot.tencent.com`，授权专用，与 Worker 的业务主域无关）申请授权，打印授权链接，在浏览器登录后自动轮询换取 `WB_ACCESS_TOKEN` / `WB_REFRESH_TOKEN` / `WB_USER_ID` / `WB_DOMAIN`（5 分钟内有效）；也可手动设置环境变量后 `--push`。`--push` 时 access / refresh token 需一起推送。注意：授权完成后应检查 token 的 JWT `sub` 是否存在——无 `sub` 的空壳 token 无法调用业务接口，需在官方客户端登录一次该账号后重新授权。
- 某个应用读取失败只会跳过该应用，不影响其他应用；全部失败时退出码为 1。
- 导出内容含访问令牌和设备私钥，不要写入仓库或日志。

## KV（`CHECKIN_STATE`）

| 键 | 内容 | 用途 |
| --- | --- | --- |
| `trae` | `{token, refresh_token, expires_ms, refresh_expires_ms, base, updated_at}` | Trae 续期后的滚动凭据；`base` 为生成记录时的 `TRAE_TOKEN` |
| `workbuddy:<uid>` | `{token, refresh_token, expires_ms, base, updated_at}` | WorkBuddy 续期后的滚动凭据（多账号按 uid 分键）；`base` 为生成记录时的 `WB_ACCESS_TOKEN`，secret 被重新推送（值变化）后该记录作废 |
| `minimax` | `{token, updated_at}` | MiniMax 续期后的 token |
| `cfg:tasks` | `{checkin: {cron, enabled}, xb: {cron, enabled}}` | 面板保存的任务配置；缺失或字段非法的项回退默认值 |
| `run:<id>` | `{trigger, startedAt, flag, content}` | 任务最近一次运行结果（`content` 最多保留 8000 字符），每次运行覆盖 |
| `xb_seen` | `number[]`（最多 5000 个 path_id） | XB 线报去重 |

- 绑定可选：不配置时 token 不跨次缓存，线报会重复推送，面板无法保存配置和运行结果（任务按默认 cron 运行）。
- Trae / WorkBuddy：记录里的 `base` 与当前 secret 不一致（secret 被重新推送）时忽略 KV，以 secret 为准；重新推送时 access / refresh token 需一起更新。续期会轮换 refresh_token，KV 写入失败会在结果里提示。
- MiniMax：env 与 KV 里的 token 都作为候选，未过期的优先，到期时间晚的排前。
- 读写统一走 `lib/kv.ts`，失败不抛异常：读取失败时 Trae / WorkBuddy 在续期失败提示里注明“读取 KV 失败”，MiniMax 只记日志；XB 读取 `xb_seen` 失败（含 JSON 损坏）则放弃本轮，避免重推并覆盖历史，需要时到控制台删除该键；面板读取 `cfg:tasks` 失败时调度回退默认配置，但保存配置会被拒绝（避免覆盖已有配置），同样需要时到控制台删除或修复该键。
- WorkBuddy：需配置 `WB_REFRESH_TOKEN` 才会续期（距过期不足 72 小时，或签到返回 401/403 时调用 `/v2/plugin/auth/token/refresh`，续期会轮换 refresh_token）；主动续期失败时沿用现有 token 继续签到。账号 2 同理（`WB2_REFRESH_TOKEN`）。
- 首次运行或 KV 为空时，依赖 secrets 里的初始 token / refresh_token。
- `wrangler.toml` 的 KV 绑定不写 `id`：首次 `wrangler deploy` 自动创建命名空间（以 Worker 名为前缀）；要改用已有命名空间，在 `[[kv_namespaces]]` 里加 `id = "<命名空间 id>"`。

## 本地开发

```bash
npm install
# 新建 .dev.vars（已被 .gitignore 忽略），内容为 KEY=VALUE，key 与上面的变量名一致
npm test              # vitest 单元测试
npm run typecheck     # tsc --noEmit
npm run dev           # wrangler dev；打开 http://localhost:8787 即面板；定时触发可用 curl "http://localhost:8787/cdn-cgi/local/scheduled" 模拟
```

## 部署

需要自己的 Cloudflare 账号。Worker 名取自 `wrangler.toml` 的 `name`，与项目名无需一致；修改 `name` 会部署为一个新 Worker，已有的 Secrets、Git 集成连接和域名需要重新配置。

### Cloudflare Git 集成（推荐）

在控制台把 Worker 连到仓库，push 到 `main` 自动部署。GitHub 侧无需配置 secret。

连接步骤（Workers & Pages → `cf-cron-panel` → Settings → Builds）：

1. 如已连过别的仓库，先 **Disconnect**；
2. **Connect** → GitHub → 选**原始仓库 `mgmg22/cf-cron-panel`** → 分支 `main`；
3. Build command 留空，Deploy command 用默认 `npx wrangler deploy`，Root directory 留空。

「一键部署」按钮会 fork 一份副本并连到副本，之后 push 原仓库不会触发部署，所以要连原始仓库。
`wrangler.toml` 不含 `[vars]`，部署不会清空已有变量；任务 cron 存在 KV，也不会被部署覆盖。

### GitHub Actions

自建 `.github/workflows/deploy.yml`（`on: push → branches: [main]`），直接执行 `npm run deploy`，使用项目本地 wrangler，不依赖 `wrangler-action` 的默认版本。仓库 `Settings → Secrets and variables → Actions` 需配置：

- `CLOUDFLARE_API_TOKEN`（必需，用 *Edit Cloudflare Workers* 模板创建）；
- `CLOUDFLARE_ACCOUNT_ID`（可选，token 只授权单账号时自动推断）。

### 一键部署

点击页面顶部按钮，Worker 名取 `wrangler.toml` 的 `cf-cron-panel`。变量不在 `[vars]`，向导不会生成变量表单，部署后用 `scripts/export-env.mjs --push` 或控制台录入。KV 绑定默认启用。

### 手动部署

```bash
npx wrangler login
npx wrangler deploy                              # 先部署（同时自动创建 KV），secret 才能写入
node scripts/export-env.mjs --push
```

部署后在控制台 Settings → Triggers 应只有一条 `* * * * *` 的 Cron；排查看 Cron Events / Workers Logs。首次部署后设置 `ADMIN_PASSWORD`（见「面板登录」）。

## 实现要点

- **WebCrypto 限制**：运行时没有 MD5，ECDSA 返回 IEEE P1363（`r||s`）而非 DER。`md5.ts` 是纯 TS 实现；`crypto.ts` 把签名拆成 `(r,s)`、做低 s 归一化后按最小 DER 编码输出（Trae 服务端按 DER 校验）。
- **通知结果**：`lib/notify.ts` 的 `notifyServerJ` / `notifyDingding` 返回是否推送成功（未配置 key 视为成功），不抛异常；钉钉要求 HTTP 2xx 且 `errcode === 0`。
- **公共判断**：`lib/api.ts` 提供各接口共用的业务成功 / HTTP 鉴权失败 / HTTP 限频判断；各任务自己的鉴权关键词、业务 code 仍留在任务内。
- **编码工具**：`lib/encoding.ts` 提供 base64 / base64url / hex / 随机十六进制串，`crypto.ts`、`jwt.ts`、`notify.ts` 及各任务共用。
- **JWT 解析**：`lib/jwt.ts` 的 `decodeJwtExp` 供 Trae（过期前 48 小时主动续期）、WorkBuddy（过期前 72 小时主动续期）和 MiniMax（候选 token 排序）使用，解码失败返回 0；`decodeJwtSub` 供 WorkBuddy 识别未绑定用户身份的空壳 token（JWT 无 sub 时上游拒绝全部业务接口，续期无效）。Trae / WorkBuddy 主动续期失败时沿用现有 token 继续签到。
- **WorkBuddy 域回落**：主域 `www.workbuddy.cn` 被网关拒绝时回落 `copilot.tencent.com` 一次；写请求（签到、领奖、派猫、开盲盒）只在 401/403 或 HTML 网关页时回落，5xx 不回落，避免重复执行。
- **WorkBuddy 头族**：billing 族 UA 恒为 `axios/1.16.1` 且必带随机 `X-Request-ID`；refresh 端点 X-Refresh-Token 与 Authorization 双发。头族与官方客户端不一致会被网关 401。
- **WorkBuddy 空壳 token**：JWT 无 `sub` 的 token（授权时身份联合未完成）能过 `/v3/config` 但 `/v2/*` 全 401、refresh 回 12153——签到前用 `decodeJwtSub` 提前拦截并提示重新授权。
- **MiniMax 签名**：`x-signature` / `yy` 依赖请求参数的精确编码，`pyQuotePlus` 必须与 Python `quote_plus` 一致（非 ASCII 按 UTF-8 字节转义）；`unix` 参数须与签名时间戳相同。
- **HTML 解析**：XB 用 Workers 内置 `HTMLRewriter`（无 DOM 树），靠 `inDiv` / `inFirstP` / `curA` 标记跟踪嵌套。目标站点是明文 `http://`，列表页抓取失败时返回空列表。
- **XB 去重时机**：去重集合在钉钉推送**成功后**写入，推送失败则不写入、返回 `FAIL`，下一轮重新抓取并重试；无新线报或 AI 筛选后无内容时无需推送，直接写入。`dry` 模式不写入。AI 两次调用都失败时不筛选，按原列表推送。KV 写入失败只记日志。
- **免费版限额**：单次调用 50 个子请求（KV 读写也计入），XB 的 `MAX_DETAILS` 据此限制详情页抓取数；单次 10ms CPU（等待网络不计）；账号最多 5 个 Cron Trigger（本项目占 1 个）；KV 每天 100,000 次读取、1,000 次写入（UTC 0 点重置，超出后该类操作报错）。
- **KV 用量**：每天读取约 1,600 次（调度每分钟读 1 次任务配置，占 1,440）；写入不超过约 100 次（XB 每次运行写 1 次结果，有新线报时再写 1 次去重集合；聚合签到约 3 次）。KV 读取失败时调度回退默认配置，写入失败只记日志。同一分钟有多个任务到点时共用一次调用的子请求额度。
- **面板调度**：`runDue` 以 `event.scheduledTime`（而非当前时间）匹配 cron；任务异常转为 `ERROR` 结果并照常保存，不影响同一分钟的其他任务。cron 计算统一用北京时间（`lib/cron.ts`）。
