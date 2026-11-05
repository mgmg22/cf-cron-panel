# 面板上线 TODO

按顺序执行，每一步完成后勾选。本清单覆盖「把代码传到新的 GitHub 仓库，并重新部署到 Cloudflare」的场景：**全部使用新建的 KV**，旧项目的 Cron 触发器已删除。面板接口在设置 `ADMIN_PASSWORD` 之前一律返回 503（默认关闭），所以先部署、后设密码是安全的。

## 0. 部署前自检（本机）

- [ ] `npm install`
- [ ] `npm run typecheck` 通过
- [ ] `npm test` 全部通过
- [ ] `npm run dev` 后浏览器打开 <http://localhost:8787>（本地免登录），**目视检查面板**（这一步还没人看过）：
  - [ ] 「定时任务」表格正常渲染（聚合签到、XB 线报两行）；左侧菜单可在「定时任务 / 凭据状态」间切换
  - [ ] 手机宽度（开发者工具 375px）下菜单收起、点左上角按钮展开，表格变为卡片；左下角切换「主题：自动/浅色/深色」后文字对比度正常
  - [ ] 点定时规则旁的铅笔图标：弹窗里出现「接下来运行：…」预览；输入非法表达式时显示红色错误且「保存」不可点；「恢复默认」可用
  - [ ] 点「保存」后表格刷新，「下次运行时间」随之变化
  - [ ] 「更多 → 禁用」后状态显示「已禁用」，再「启用」恢复
  - [ ] 点「运行」会先弹确认框；运行期间状态显示「运行中」且「运行」不可点；完成后右上角有提示
  - [ ] XB「更多 → 试运行」：右侧抽屉显示试运行结果，刷新后「最近结果」和「最后运行时间」**不变**；「日志」抽屉显示最近一次真实结果
- [ ] 本地模拟定时触发：`curl "http://localhost:8787/cdn-cgi/local/scheduled"`，到点任务会在终端日志里输出（默认 cron 不到点时无输出属正常）
- [ ] （可选）本地验证登录页：`npx wrangler dev --var ADMIN_PASSWORD:test123`，再用 `curl -H "Host: panel.example" ...` 模拟非本地域名；或直接在上线后验证（第 4 步）

## 1. 部署前准备

- [ ] **KV 无需手动创建**：`wrangler.toml` 的 KV 绑定不写 `id`，首次部署时 Wrangler 自动创建命名空间（名称以 Worker 名为前缀）并绑定；部署后在控制台 Storage & Databases → KV 和 Worker 的 Bindings 里确认（见 2.1）
- [ ] 新 KV 为空带来的后果，部署前知晓：
  - `xb_seen` 为空，首轮 XB 会把当前列表里符合条件的线报推送一遍（每轮最多抓 30 条详情，之后恢复正常去重）；
  - 没有续期后的滚动凭据：Secrets 里的 token / refresh_token 必须是**最新有效**的。旧 KV 里轮换过的 refresh_token 已不可用，所以要重新导出一遍（见 2.2）
- [ ] 确认 `wrangler.toml`：
  - [ ] `name = "cf-cron-panel"`（Worker 名；改名 = 全新的 Worker）
  - [ ] `crons` 只有 `["* * * * *"]`
  - [ ] `[assets]` 为 `directory = "./public"`、`binding = "ASSETS"`、`run_worker_first = ["/api/*"]`
  - [ ] `[[kv_namespaces]]` 只有 `binding = "CHECKIN_STATE"`，没有 `id`
- [ ] **推送到新 GitHub 仓库** <https://github.com/mgmg22/cf-cron-panel>：确认 `.wrangler/`、`.dev.vars`、`node_modules/` 没有被提交；确认仓库是私有的，或已知晓 Worker 名会公开

## 2. 部署 Worker

### 2.1 部署

> 使用 Cloudflare Git 集成时，push 到 `main` 即自动部署；Build command 留空，Deploy command 用默认 `npx wrangler deploy`。

- [ ] 二选一：
  - Git 集成：控制台 Workers & Pages → 连接到 `mgmg22/cf-cron-panel` 的 `main` 分支（Build command 留空，Deploy command 用默认 `npx wrangler deploy`）
  - 手动：`npx wrangler login`，然后 `npx wrangler deploy`
- [ ] 控制台 → Settings → Triggers：**Cron 只有 `* * * * *` 一条**
- [ ] 控制台 → Settings → Bindings：能看到 `CHECKIN_STATE`（KV，由首次部署自动创建的命名空间）和 `ASSETS`；Storage & Databases → KV 里能看到对应命名空间

### 2.2 设置 Secrets

- [ ] 在装有桌面端且已登录的电脑上重新导出并推送登录态（Worker 名按实际填写）：
  ```bash
  node scripts/export-env.mjs --push --worker <Worker 名>
  ```
  WorkBuddy 的令牌需要 `--login-workbuddy` 浏览器授权获取（脚本读不到加密的 accessToken）
- [ ] 脚本读不到的变量，在命令前带上环境变量一起推送，或在控制台逐项设置：`WB_ACCESS_TOKEN` / `WB_REFRESH_TOKEN`、`WB2_*`（可选）、`NOTIFY_PUSH_KEY`、`API_KEY`、`API_URL`、`XB_BOT_TOKEN`、`XB_BOT_TOKEN_SECRET`（可选）
- [ ] `ADMIN_PASSWORD` 在第 4 步设置
- [ ] 记下 Worker 访问域名：`https://<worker名>.<账号子域>.workers.dev`（或自定义域名）

### 2.3 旧项目收尾

- [ ] 新 Worker 稳定运行一个完整周期（至少包含一次 XB 的 03/33 分，以及次日 00:08 的聚合签到）并确认结果正常后，删除旧 Worker、旧 KV 命名空间，断开旧 Git 集成

## 3. 验证「面板默认关闭」（密码未设置时）

- [ ] 命令行验证接口不可用（应返回 503，而不是数据）：
  ```bash
  curl -i https://<域名>/api/tasks
  ```
- [ ] 浏览器打开 `https://<域名>/login`：页面显示「服务端未配置 ADMIN_PASSWORD，面板已禁用」，登录按钮不可点

## 4. 设置密码并验证登录

- [ ] 生成一个足够长的随机密码（16 位以上），保存到你的密码管理器（**不要写进仓库**）。登录没有失败次数限制，密码强度就是唯一防线
- [ ] 写入 Secret：
  ```bash
  npx wrangler secret put ADMIN_PASSWORD
  ```
  或控制台 Settings → Variables and Secrets 添加（类型 Secret）。Secret 即时生效；若不生效再执行一次 `npx wrangler deploy`
- [ ] 无痕窗口打开 Worker 域名：应跳转到 `/login`
- [ ] 输入**错误密码**：提示「密码错误」
- [ ] 输入正确密码：进入面板，左下角出现「退出登录」按钮
- [ ] 刷新页面仍保持登录；点「退出登录」后回到登录页，再访问首页会再次跳转
- [ ] 未登录直接请求接口应为 401，**不能返回任务数据**：
  ```bash
  curl -i https://<域名>/api/tasks
  ```
- [ ] 浏览器开发者工具 → Application → Cookies：`auth` 为 `HttpOnly`、`Secure`、`SameSite=Strict`
- [ ] （可选）改一次 `ADMIN_PASSWORD`：已登录的浏览器应被要求重新登录（旧 Cookie 失效），验证后用新密码登录

## 5. 功能验证

### 5.1 先做不会产生副作用的操作

- [ ] 面板顶部**没有** KV 未绑定的黄色提示条（若出现，检查第 2 步的 KV 绑定）
- [ ] 左侧菜单「凭据状态」页：每项的「已配置 / 未配置」与实际一致，「未配置时」一列说明了影响；缺少必要凭据时「定时任务」页顶部有黄色提示
- [ ] 把 XB 线报的 cron 改成 `0 0 1 1 *`（几乎不触发）并保存：刷新页面后仍是新值 → 证明 KV 读写正常；之后**改回** `3,33 8-23 * * *`
- [ ] XB「更多 → 试运行」：抽屉里显示线报 markdown 预览，「最后运行时间」不变

### 5.2 真实运行（会产生真实签到/推送，确认后再做）

- [ ] 聚合签到点「运行」：
  - [ ] 「最近一次结果」更新，状态为 `SUCCESS` / `ALREADY_TODAY`
  - [ ] 收到一条 server酱汇总通知
  - [ ] 若某个子任务显示「未配置凭据」，对照「凭据状态」页补齐对应 Secret
- [ ] XB 线报点「运行」（非试运行）：
  - [ ] 钉钉收到推送，或结果为「暂无线报」
  - [ ] 若提示钉钉推送失败（`FAIL`），检查 `XB_BOT_TOKEN` / `XB_BOT_TOKEN_SECRET`；失败时不会写去重，下一轮会重试

### 5.3 定时触发（观察一个完整周期）

- [ ] 控制台 → Logs（或 `npx wrangler tail`）：每分钟有一次 scheduled 调用，**到点才有任务日志**
- [ ] 下一个 03 / 33 分后：XB 运行，面板「最近一次结果」的触发方式显示「定时」
- [ ] 次日 00:08 之后：聚合签到定时运行，收到汇总通知
- [ ] 同一分钟同一任务没有重复运行
- [ ] 日志里没有持续的 `[scheduler] 读取任务配置失败` 告警

## 6. 额度与风险检查

- [ ] 控制台 → Workers → Metrics：每天请求约 1440 次（每分钟 cron）+ 面板访问，远低于免费版 100,000 次/天
- [ ] KV 写入每天约 100 次以内（免费版 1000 次/天），无异常飙升
- [ ] 聚合签到运行日志里没有 `Too many subrequests`（免费版单次 50 个子请求）；若出现，需要拆分任务或升级付费版
- [ ] 没有 CPU 超限错误（免费版 10ms CPU，等待网络不计）
- [ ] （可选）给该域名加一条 WAF 速率限制规则或 Cloudflare Access，补上登录失败次数限制

## 7. 应急操作

- [ ] **只想让面板停用**：删除 `ADMIN_PASSWORD`，接口立即返回 503；定时任务不受影响
- [ ] **怀疑登录态泄露**：修改 `ADMIN_PASSWORD`，所有已登录的浏览器立即失效
- [ ] **只想让某个任务停止**：在面板里禁用，或把 KV 里 `cfg:tasks` 对应任务的 `enabled` 改为 `false`
- [ ] **KV 里的任务配置损坏**：在控制台 KV 删除 `cfg:tasks` 键，调度会回退到默认 cron

## 8. 收尾

- [ ] 确认 `README.md` 的「定时与面板」「面板登录」两节与实际配置一致
- [ ] 删除本文件，或保留作为换账号/重新部署时的检查清单

## 已知限制（上线前知晓即可）

- 登录**没有失败次数限制**，会话**没有服务端过期时间**（Cookie 浏览器端保存 30 天；改密码即全部失效）
- 只保留每个任务**最近一次**运行结果，没有历史记录
- 没有实时日志，不能中途停止正在运行的任务
- 手动运行与定时运行之间没有互斥锁
- cron 最小精度 1 分钟，不支持秒级，统一按北京时间
- 面板不编辑凭据，只显示是否已配置；改凭据仍用 `node scripts/export-env.mjs --push` 或控制台
- 同一分钟多个任务到点时共用一次调用的子请求额度（默认 cron 不会重叠）
