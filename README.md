# @anweat/dsh-background

给 DeepSeek Harness（DSH）加一个工具 `background_run`：把**任意一次工具调用**放到后台跑，像 Claude Code 的 `run_in_background` 一样。工具一返回，模型的这一轮就不再被它卡住，用户可以随时插话；工具结束后，宿主自动把完成通知送回会话。

它自己只做一件事：把目标工具的调用登记成宿主的后台 job。job 的登记表（`ctx.jobs`）、`job_output` / `job_list` / `job_kill` 三个工具和完成通知都是宿主自带的，这里不重复造。

状态：本地开发版，未发布、未推送。已在 `@deepseek-ai/dsh@0.2.1-rc.5` 上做过无模型的真实宿主验证，见 [docs/validation/2026-10-31-rc5.md](docs/validation/2026-10-31-rc5.md)。**还没有跑过真实模型会话**（尤其是完成通知唤醒空闲会话的那一轮）。

## 安装

```bash
dsh plugin --profile <name> add @anweat/dsh-background
```

宿主需要已经加载 `dsh-jobs-local` 和 `dsh-tool-jobs`（桌面端 base bundle 已带）。没有它们时，`background_run` 会拒绝调用并说明缺哪个组件。

## 用法

```json
{"tool": "web_fetch", "arguments": {"url": "https://example.com/big-report"}, "description": "Fetch the big report"}
```

| 参数 | 说明 |
|---|---|
| `tool` | 目标工具名，必须是该 agent 工具列表里的名字 |
| `arguments` | 按目标工具自己的 schema 填，可省略 |
| `description` | 一行说明，必填；出现在 `job_list` 和完成通知里 |

立即返回给模型：

> `<tool>` started in the background as job `<id>` (`<description>`). A completion notice arrives when it finishes; read the result with job_output, stop it with job_kill. Do not wait or poll unless you need the result now.

之后：

- 工具结束时宿主发完成通知：`background job <id> (tool: <tool>: <description>) finished [status: completed]. Read its output with job_output.` 通知本身**不带结果**，结果用 `job_output` 读（只给一次）。会话忙时通知注入下一步，会话空闲时由宿主开一个 follow-up turn 唤醒（`dsh-tool-jobs` 的 `completionDelivery` / `maxConsecutiveWakes` 控制）。
- `job_output` 加 `wait: true` 才会阻塞等；`job_list` 列出 job；`job_kill` 停掉。
- job 的 `kind` 是 `tool`，id 形如 `tool-<16位十六进制>`。

结果映射：

| 嵌套调用结果 | job 状态 |
|---|---|
| 成功 | `completed`，结果是嵌套结果里的文本（多个文本块用换行连接，图片写成 `[image]`），超过 `maxResultChars` 截断并注明 |
| 返回错误（含被审批拒绝、参数错误） | `failed`，`detail` 是错误第一行，结果是完整错误文本 |
| 被 `job_kill`、所属会话销毁、插件卸载中止 | `killed` |

### 前置拒绝

下面这些在登记 job 之前就被拒绝（`INVALID_ARGS`，不产生 job id）：

- 没有调用方 agent，或宿主没有 `jobs` 服务（报缺失的组件）。
- 目标工具对该 agent 不可见（名字不在它的工具列表里）。
- 目标是 `background_run` 自身，或 `job_output` / `job_list` / `job_kill`。
- 目标在 `denyTools` 里。
- 目标自带后台模式：在 `nativeBackgroundTools` 里，或它的参数里本来就有 `run_in_background`。拒绝时提示改用它自己的路径。
- 目标的 `arguments` 不符合它自己的参数 schema（报错里带目标工具名，模型可以直接改）。
- 这个 agent 已有 `maxConcurrentJobs` 个后台工具 job 在跑（每个 agent 单独计数）。

## 审批在后台怎么表现

嵌套调用走完整的工具管线（pre-execute 含 ask 审批、guard、`tools/execute`、post-execute），和前台调用一样。

- 会弹审批的工具，在后台跑时**照样弹**，审批在 `background_run` 被调用的那一刻（回合还开着）发起。用户晚点回答也行：真实宿主验证里，回合结束后才回答的审批照常放行，工具照常执行（审计事件 `approval/decided` 会写在 `turn/end` 之后，见验证文档）。
- 没有审批通道的环境（headless 一次性任务）里，`ask` 得不到回答会被拒绝：嵌套调用失败，job 记为 `failed`，`detail` 带拒绝原因，模型读 `job_output` 就能看到。
- `background_run` 本身不触发审批；要不要问，取决于你给**目标工具**配的策略。想让某个工具不能在后台运行，把它放进 `denyTools`。

## 并发提醒

后台工具和前台工具、以及多个后台工具**真的同时运行**，宿主不会替它们排队。不要把会写同一个文件、同一个目录或同一份状态的工具放进后台（编辑、写入、同目录的 shell 命令之类）。需要用户回答的工具（`ask_user_question` 等）也不要放后台：问题发出去时没有人在看这一轮。随包 skill 里写了这些，`denyTools` 可以让部署方自己收紧。

## 配置

可以在设置卡片里改，或在 `cordis.yml` / profile patch 里写 `background` 这一行的 `config`。都有默认值，不配也能用。

| 字段 | 默认 | 说明 |
|---|---|---|
| `toolName` | `background_run` | 注册的工具名 |
| `maxResultChars` | `20000` | 存进 job 的结果文本上限（字符），超出截断并注明 |
| `outputLimitBytes` | 不设 | 这些 job 的每条完成通知 / `job_output` 读取的 UTF-8 字节上限；不设则不限 |
| `maxConcurrentJobs` | `4` | 每个 agent 同时存活的后台工具 job 数。宿主的 jobs-local 另有自己的每 owner 上限，两者取小 |
| `denyTools` | `[]` | 永远不能放后台的工具名 |
| `nativeBackgroundTools` | `bash, pwsh, workflow, subagent, terminal_open` | 自带后台的工具，被拒绝并指向它们自己的路径 |

`nativeBackgroundTools` 的默认值按 rc.5 源码核对过：`bash` / `pwsh` / `workflow` 有 `run_in_background`；`subagent` 立即返回子 agent id 并由运行时通知；`terminal_open` 是 PTY job。注意 `dsh-tool-bash-persistent` 提供的 `bash` 没有 `run_in_background`，用它的部署可以把 `bash` 从这个列表里去掉，让 `background_run` 接手。

## 已知限制

- **不会在回合结束或用户点“停止”时被杀**：嵌套调用用插件自己的 `AbortController`，与当前回合的 signal 脱钩。代价是它不会随回合停止：想停就 `job_kill`。会话销毁（owner 销毁）和插件卸载（HMR、禁用）会中止仍在跑的 job，进程退出当然也会丢掉。
- **结果是文本**：图片、文件块只留占位。嵌套调用是插件内部发起的，不是模型的一次独立工具调用，所以它不会有自己的工具卡片；聊天里能看到的是 `background_run` 这次调用，后续看 `job_list` / `job_output`（客户端怎么展示没有实测）。
- **PTC 模式不支持**（按源码判断，未实测）：`ToolRuntime` 设为 `ptc` 时，模型只能调 `run_code`，插件发起的嵌套调用没有 transport 的 parent 令牌，会被当作未知工具拒绝。
- **完成通知不带结果**，要再调一次 `job_output`。
- **没有“自动转后台”**（前台工具超时后自动转入后台）。第二阶段实验的结论是 rc.5 上做不成，原因见 [docs/validation/2026-10-31-rc5.md](docs/validation/2026-10-31-rc5.md) 第 3 节：用户点停止会把转入后台的工作一起杀掉；包装层只能返回满足目标工具输出 schema 的占位值（或一个错误）；被抛下的 `next()` 在工具结束时因宿主冻结了 exec 而 reject，真正的结果拿不到。所以没有实现，也没有开关。
- 用 `skills` 服务注册随包 skill、用 `systemPrompt` 加一小段提示；这两个服务不存在时插件照常工作，只是少了指导文字。

## 兼容的宿主版本

peer 范围：`>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.2 <0.2.2-0`。

- 0.2.1-rc.5：真实宿主验证（无模型），完整探针通过。
- 0.2.0-rc.2：真实宿主验证（无模型），同一套探针通过。差别：job id 是 `tool-1` 这种计数形式，宿主不写 `job/registered` / `job/settled` 会话记录（`toolCall` 字段被注册表忽略）。
- 0.2.1-rc.2 ~ rc.4：没有单独实测，按源码对照 jobs / tools 接口与 rc.5 相同。

## 开发

```bash
npx -y pnpm@11.7.0 install
npx -y pnpm@11.7.0 run verify   # typecheck + build + test
```

单元测试用宿主真实的 `ToolRuntime` 和 `SystemPrompt`，只把 `ctx.jobs` 换成一个最小的假注册表。测试在 `test/`，`test/isolate-home.mjs` 把 `DSH_HOME` 指到临时目录。

真实宿主验证用的探针插件和脚本在 [docs/validation/probe/](docs/validation/probe/)，记录在 [docs/validation/2026-10-31-rc5.md](docs/validation/2026-10-31-rc5.md)。

## 许可

MIT
