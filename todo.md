# 剩余 TODO（2026-11-05 更新）

原「面板上线检查清单」中的部署、Secrets、密码设置、KV 绑定等步骤已全部完成，清单已清理。
当前状态：部署完成，定时调度正常（每分钟 Cron、KV 任务配置均工作正常）；面板通过**自定义域名**访问（域名等实例信息不写入本公开仓库，见本地 `.dev.vars` 注释）。

## 待办

- [ ] 浏览器验证登录：打开面板域名 → 跳转 `/login` → 错误密码提示「密码错误」→ 正确密码进入面板；刷新保持登录，退出后重新跳转。
- [ ] 真实运行验证（会产生真实签到/推送）：聚合签到「运行」→ 状态 `SUCCESS` / `ALREADY_TODAY` + 收到 server酱汇总；XB「试运行」→ 抽屉显示预览且「最后运行时间」不变。
- [ ] 观察一个完整定时周期：下一个 03/33 分 XB 运行（触发方式=定时）；次日 00:08 聚合签到运行；日志无 `读取任务配置失败` 告警。
- [ ] 旧项目收尾：新面板稳定运行一个完整周期后，删除旧 Worker、旧 KV 命名空间，断开旧 Git 集成。

## 已知事项（无需处理，记录备查）

- workers.dev 域名在本机有 DNS 污染，本地测试需走系统代理（wrangler 设 `HTTPS_PROXY` 环境变量）；自定义域名不受影响。Windows curl（schannel）对新证书报 `CRYPT_E_REVOCATION_OFFLINE` 时加 `--ssl-no-revoke`。
- wrangler 4.153 对带 `[assets]` 的 Worker 会静默跳过 `wrangler.toml` 的 `routes` 配置；Custom Domain 需在控制台或用 API `PUT /accounts/{acc}/workers/domains` 注册。若写 `routes`，它必须位于所有 `[表头]` 之前（否则被归入上一个表，部署时报 `Unexpected fields found in xxx field`）。
- wrangler 的 OAuth 登录无 Workers Observability 读权限，脚本查不了 Workers Logs（telemetry/query 返回 403），只能控制台看。
