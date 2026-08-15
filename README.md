# Pi → DSH Supervisor

这是一个**非官方、Windows-first** 的实验性 Pi bridge，用于验证：

- Pi 调用一个受控的 DSH headless 子进程；
- Pi 通过独立 loopback Web/API session 获取 DSH 结构化调试证据；
- 同一 workspace 的调用串行化；
- 每次调用使用独立 headless profile；
- 超时/取消时清理完整子进程树；
- 对无模型成本的 DSH 启动/配置 smoke 做有限重试；
- 将 Pi session 导出为 external-safe 的结构化审查证据。

它**不包含 DSH、凭据、用户 session、项目 prompt、私有路径或浏览器状态**，也不是 DeepSeek 官方项目。

## 重要边界

1. `dsh_call` 是一次性 fresh child 调用，不恢复 Web session。
2. `dsh_debug` 是一次性 fresh Web/API session；它不接管用户现有 Web DSH，只返回结构化事件、工具、turn 和 reasoning chunk 指纹。
3. `dsh_smoke` 只做版本/配置/协议前置检查，不默认调用模型。
3. smoke 失败可以重启一个新的、无用户任务的 child；普通写任务失败不自动重放，避免重复修改 workspace。
4. 不提供“重启当前 Web DSH”按钮；只允许管理本插件自己拥有的子进程。
5. 当前 profile/link 实现依赖 PowerShell 7 与 Windows junction；POSIX adapter 尚未承诺。
6. DSH developer preview 的 CLI/配置变化由 adapter 层隔离，不能把本项目当作稳定 API 保证。

## 本地运行

配置边界和已验证版本见 [`docs/configuration.md`](docs/configuration.md) 与 [`docs/compatibility.md`](docs/compatibility.md)。

```powershell
cd projects/agent-infra/prototypes/pi-dsh-supervisor
npm test
# also runs an isolated npm-pack extraction smoke
```

加载 Pi extension（开发态）：

```powershell
pi -e ./src/pi-dsh.ts
```

默认要求当前环境已配置 `DSH_HOME`，并且 `dsh` 在 PATH 中。也可以通过环境变量覆盖：

```powershell
$env:PI_DSH_COMMAND = "dsh"
$env:PI_DSH_TIMEOUT_MS = "600000"
# Optional read-only smoke command override:
$env:PI_DSH_HEALTH_COMMAND = "pwsh"
$env:PI_DSH_HEALTH_ARGS = '["-NoLogo","-NoProfile","-Command","& (Get-Command dsh).Source --version"]'
```

## 工具面

- `dsh_call`：执行一个 bounded headless task；workspace 必须是绝对路径。
- `dsh_debug`：启动隔离 Web/API session，可选择 preset/provider/model/reasoning，观察工具调用、错误、turn 结局和 reasoning chunk 的长度/指纹；可选保存不含原始文本的本机结构化摘要。
- `dsh_smoke`：执行无模型成本的 `dsh --version` 或用户提供的只读检查参数。

没有 `dsh_restart`：重启策略只存在于 smoke/启动失败的受控路径，避免隐式重放用户工作。`dsh_debug` 结束时只取消并清理它自己创建的 session/process/profile。

## 脱敏导出

`src/review-export.mjs` 来自 Agent Infra 的 review-export contract：

- 默认 `external` 只输出事件结构、工具名、字段形状、长度和错误分类；
- `internal` 仅供私有审查，不得发布；
- `repro` 必须人工筛选并带 `reviewRequired` 标记；
- 原文、命令、路径、UUID、时间戳、token、cookie、session 文件名和错误正文不进入 external trace。

运行测试：

```powershell
node --test test/review-export.test.mjs
```

## 发布边界

本仓库按 **supervisor-only** 发布：包含 Pi bridge、health probe、profile/进程树隔离、脱敏 exporter、测试和文档；不捆绑 DSH 本体、DSH profile、凭据、session 或本地 DSH 插件。

公开发布前已完成：

- 独立 npm-pack 解包测试；
- secret/path/session/log/browser 扫描；
- 真实 DSH `--version` 无模型 smoke；
- Pi/DSH/Node/PowerShell 兼容性记录。

公开审阅仍应重点检查：DSH developer-preview 版本变化、Windows 权限边界，以及自定义 health command 是否确实只读。
