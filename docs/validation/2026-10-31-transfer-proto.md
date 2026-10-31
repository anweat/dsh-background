# 2026-10-31 原型验证：前台工具转入后台 / 打断（分支 `proto/transfer`）

范围：只做宿主侧，没有客户端 UI。设计稿 `docs/background-tools-interaction-design.md` §4 第 1 步。

结论：在 `@deepseek-ai/dsh@0.2.1-rc.5` 的真实 agent loop 上，转入后台和打断都按设计工作。用户插话后约 30 ms，模型就带着插话内容发起了下一次请求（对照：不转入时要等工具跑完，晚了 5 秒）；转入后工具的真实结果经 job 和完成通知回到模型；R1 的访问器绕过在 rc.5 和 0.2.0-rc.2 上都有效。风险：绕过依赖宿主内部实现（R1），并且 R3（同一 turn 点停止会杀掉已转入后台的工具）无法在插件侧解决。建议见末尾。

执行者是开发者侧代理，不是独立验证者。只写亲眼看到的结果。

## 做了什么

- `src/transfer.ts`：一个 `tools/execute` 包装（`foregroundControl: true` 才安装），按 agent 跟踪每个前台调用（callId、工具、开始时间、参数摘要），让工具本体与 `transfer` / `interrupt` 两个触发器赛跑。
  - 排除 `background_run`、`job_*`、`denyTools`、`nativeBackgroundTools`。
  - **转入后台**：先把 `exec.signal` 改成访问器属性（R1 绕过），再 `ctx.jobs.start({kind:'tool', owner, toolCall, ...})` 登记 job，job 的 `done` 等本体结束后用 `outcomeOf` 映射；包装层立刻返回 `isError` 占位（`code: MOVED_TO_BACKGROUND`）。
  - **打断**：包装层把 `exec.signal` 换成 `AbortSignal.any([原 signal, 自己的 controller.signal])`，打断就是 abort 自己的 controller，只有本体收到取消。本体不理会取消时，`interruptGraceMs`（默认 3 秒）后放行调用。结果是 `ABORTED`，文字 `Interrupted by the user: ...`。
- 触发：程序接口 `ctx.backgroundTransfer`（`list` / `transfer` / `interrupt` / `applyPolicy` / `status`）；配置 `onUserMessageWhileToolRuns`、`toolPolicies`、`waitOnlyTools`（默认 `write`、`edit`、`ask_user_question`、`exit_plan_mode`、`plugin_manager`、`working_directory` 退回 `wait`）、`autoBackgroundAfterMs`、`toolAutoBackgroundMs`、`interruptGraceMs`、`allowUnverifiedHost`。
- 用户消息判定（R5）：监听 `agent/inbox/inserted`，只当 `message.source.kind === 'user'` 且该消息在 `agent.inbox.nextStep` 里才触发。`UserMessage.source` 是 `MessageSourceMap` 的和类型：用户输入是 `{kind:'user', rpcId, ...}`，完成通知是 `{kind:'tool-jobs', form:'notice'}`，其他插件各有自己的 kind；steering（`agent.steer`）进 `next-step`，跟进（`agent.followup`）进 `next-turn`。事件 payload 不带 target，所以用 `agent.inbox.nextStep` 反查（事件在写入收件箱之后发出，反查有效）。
- 版本门禁：读 `@deepseek-ai/dsh-tools/package.json` 的版本，不在 `VERIFIED_TOOLS_VERSIONS`（`0.2.0-rc.2`、`0.2.1-rc.2` 到 `rc.5`）里则转入后台关闭，除非 `allowUnverifiedHost`；版本读不到视为通过。再加两道功能检测：`exec.signal` 不能变成访问器时 `transfer` 拒绝，调用留在前台；转入后 `next()` 仍然 reject（绕过失效）时 job 记为 `failed`，`detail` 写明宿主拒绝了交接。

## 方法

单元测试用宿主真实的 `ToolRuntime` 和 `SystemPrompt`（`ctx.jobs` 是假的），共 54 项（原 33 + 新 21），`pnpm run verify` 通过，覆盖：转入后真实结果到达 job、`tools/result` 只触发一次且是占位、无 unhandled rejection、kill、打断、忽略取消的本体、排除清单、jobs 缺失或达上限、访问器失败的降级、版本门禁、各触发器与策略、并行、自动转入、R3。

真实宿主：`dsh@0.2.1-rc.5`（npm 官方源）、全新 `DSH_HOME`、headless profile，`headless-runner` 关闭，`llm-deepseek` 打开但指向本机回环上的**脚本化假端点**（`DEEPSEEK_BASE_URL=http://127.0.0.1:18771/v1`，key 是字面量 `mock-key`；`probe/transfer/mock-llm.mjs`，按 Messages 协议回放事先写好的“调用工具”和“文字”回复）。这不是真实模型会话，没有联网、没有真实凭据；但用的是**真实的 agent loop**：探针 `agent.followup()` 发第一条用户消息，工具运行期间 `agent.steer()` 发 steering 消息，`agent.cancel({kind:'user'})` 模拟点停止。因此能直接观察到“下一次模型请求什么时候发出、带什么内容”。时间是相对探针模块加载的毫秒数，日志在 `logs/transfer/`。

## 实验结果

### (i) 转入后台：包装层立即放行，step 继续，模型立刻带着插话继续（`tr-a.json`）

工具 `tr_slow`（6000 ms）。第 5219 ms 用户 steering 消息进入 `next-step` 收件箱：

```
5219  inbox/inserted  source {kind:user,rpcId}, inNextStep=true
5223  tools/result    MOVED_TO_BACKGROUND "Not a failure, do not retry: tr_slow was moved to the background as job tool-37e3a21c1c7b426a at the user's request; a completion notice arrives when it finishes, read the result with job_output."
5249  第 2 次模型请求（mock 端收到）
```

- 第 2 次模型请求的最后一条 user 消息 = `tool_result`（`is_error: true`，内容就是上面的占位）加文字块 `steering: user message while the tool runs`。**插话后 30 ms 发出**，其中 4 ms 是包装层放行。
- 对照（`tr-w.json`，策略 `wait`，其余相同）：工具在 10507 ms 结束，第 2 次请求在 10553 ms，内容是真实结果 `tr_slow W finished after 6000ms` 加同一条 steering 文字。也就是说转入后台提前了约 5.3 秒。
- 第 1 个 turn 在 5253 ms 以 `completed` 结束，不是被取消。

“step 继续、loop 立刻发下一次请求”是**直接观察到**的（假端点的请求时间戳），不是推断。

### (ii-a) 转入后台：真实结果和完成通知（`tr-a.json`）

```
10214 工具本体结束 outcome=finished
10216 job/settled  status=completed cause=producer
10217 inbox/inserted source={kind:tool-jobs,form:notice} inNextStep=false   (turn 已结束，空闲会话 → follow-up 唤醒)
10218 turn/start {turn:2}
10242 第 3 次模型请求，最后一条 user 消息: "background job tool-37e3a21c1c7b426a (tool: tr_slow: {"ms":6000,"tag":"T"}) finished [status: completed]. Read its output with job_output."
job_output → "tr_slow T finished after 6000ms\n[status: completed]"
```

真实结果到达 job（R1 绕过有效）。`tools/result` 对这个调用只触发一次（占位），`tool/result` 会话事件一次，`job/registered` 一次、`job/settled` 一次；探针进程里没有 unhandled rejection。完成通知唤醒空闲会话也在这个真实 loop 上看到了。

### (ii-b) 打断：本体被取消，结果 `ABORTED`，turn 不取消（`tr-b.json`）

```
5346  steer (policy=interrupt)
5348  工具本体 signal aborted → 抛 "aborted by signal"
5350  tools/result code=ABORTED "Interrupted by the user: tr_slow was cancelled at the user's request before it finished. It did not complete; run it again only if the user asks."
5376  第 2 次模型请求，最后一条 user 消息 = tool_result(is_error true, 上面的文字) + "steering: user message while the tool runs"
5379  turn/end {kind: completed}
```

插话后 30 ms 发出第 2 次请求；整个 turn 以 `completed` 结束，没有 job 登记。

### (iii) R3：同一 turn 里点停止会杀掉已转入后台的工具（`tr-c.json`，已确认）

转入后第 2 个 step 用慢速文字回复保持 turn 还开着，6866 ms `agent.cancel({kind:'user'})`：

```
6867  工具本体 signal aborted（它已经在后台 job 里了）
6871  job/settled  status=killed  detail="stopped together with the turn (user stop)"
6873  turn/end {kind: aborted, reason: {kind: user}}
job_output → "(no new output)\n[status: killed, stopped together with the turn (user stop)]"
```

宿主始终把调用方 signal 融合进本体，包装层换 signal 也绕不开（phase 2 的 E3、E4 已证明）。插件能做的只是把 job 记为 `killed` 并写清原因（最初它被记成 `failed`，已改）。turn 正常结束（`tr-a`）不会杀。**这一条不是原型能解决的**，只有宿主提供 detach 接口才能解。

### (iv) 并行：一步里两个慢工具（`tr-p.json`）

脚本化回复在同一个 step 里发了两个 tool call（`tr_slow` 9000 ms、`tr_slow2` 4000 ms，都 `isConcurrencySafe`，配置：全局 `background`、`toolPolicies: {tr_slow2: wait}`）：

```
4333  两个本体同时开始
5351  steer
5355  tr_slow → MOVED_TO_BACKGROUND
8334  tr_slow2 → 真实结果 "tr_slow2 B finished after 4000ms" (isError false)   ← 另一个继续在前台跑
8361  第 2 次模型请求: tool_result(A 占位, is_error true) + tool_result(B 真实, is_error false) + steering 文字
13334 A 的 job 完成；job_output → "tr_slow A finished after 9000ms\n[status: completed]"；通知唤醒第 3 次请求
```

逐个转入、其余不受影响。注意：step 要等所有前台调用返回才结束，所以这里第 2 次请求在 B 结束时才发出。想让 step 立刻结束，两个都要转入或打断。

### (v) 触发判定：用户 steering 触发，完成通知不触发（`tr-n.json`）

先转入 A（3000 ms），第 2 个 step 起 B（`tr_slow2` 7000 ms，同样是 `background` 策略）。A 的 job 在 B 运行期间完成：

```
7373  job/settled (A)
7375  inbox/inserted source={kind:tool-jobs,form:notice} inNextStep=true   ← 繁忙 owner，通知注入下一步
11931 B 的真实结果 "tr_slow2 B finished after 7000ms" (isError false)      ← 没有被转入后台
11973 第 3 次模型请求: tool_result(B 真实) + 通知文字
```

通知进的正是 `next-step` 收件箱，若只看 target 会误触发；按 `source.kind === 'user'` 过滤后没有触发。其余判定（`next-turn` 的用户消息、`system-prompt` 来源）由单元测试覆盖。

### 自动转入（`tr-u.json`，`autoBackgroundAfterMs: 1500`）

工具开始后 1.5 秒自动转入：`tools/result` 为 `MOVED_TO_BACKGROUND`，占位文字 `... because it ran longer than 2 seconds; ...`（当时按整秒取整，已改为一位小数），第 2 次请求 6138 ms 发出（工具 4618 ms 开始），工具结束后完成通知唤醒第 3 次请求，`job_output` 为真实结果。

### 程序接口，rc.5 和 0.2.0-rc.2（`tr-d.json`、`tr-d-rc2.json`）

三个并发直接调用（`ctx.tools.execute`，无 loop）：`list` 返回三项 `running`；`transfer('d1')` → `{ok:true, jobId}`，`interrupt('d3')` → `{ok:true}`；d1 得到占位，d2 正常 `tr_slow2 D2 finished after 1200ms`，d3 得到 `ABORTED` 且它的 turn signal 没被中止；d1 的 job 完成，`job_output` = `tr_slow D1 finished after 2500ms`。`status()`：rc.5 → `{enabled:true, hostVersion:'0.2.1-rc.5'}`，0.2.0-rc.2 → `{enabled:true, hostVersion:'0.2.0-rc.2'}`。两个版本结果一致（rc.2 的 id 是 `tool-1`）。

### 其他发现

- **转入后的调用失去 `timeoutMs`**（`tr-d.json`）：声明了 `timeoutMs: 2000` 的工具，前台时 2003 ms 被超时策略中止（`Error: tool call timed out after 2000ms`）；转入后台后它跑完了 4500 ms（`outcome: finished`）。原因是超时策略的包装在我们提前返回时就收尾了。后台 job 没有超时，这个行为也许正合适，但要知道。
- **默认的“忙时回车”是排队（`queue`），不是 steering**：`ui-conversation` 的 `busyEnter` 默认 `queue`，用户消息走 `agent.followup`，进 `next-turn` 收件箱，按设计**不会**触发策略。只有 Ctrl/Cmd+Enter、把设置改成 `steer`、或在队列 dock 里点“steer”（它先 `inbox.remove` 再 `agent.steer`，会再次触发 `inserted`）才会。这直接影响“插话策略”的可用性：不改设置的用户永远等不到触发。dock 按钮不受影响。

## 证明了什么，没证明什么

已证明（rc.5，真实 loop + 脚本化端点；程序接口另在 0.2.0-rc.2 上验证）：

1. 转入后台和打断都能让 step 立即继续，下一次模型请求在约 30 ms 内带着 steering 内容发出（对照等待要晚 5 秒以上）。
2. R1 绕过有效，真实结果能进 job，通知唤醒空闲会话，没有重复上报或 unhandled rejection。
3. 打断只取消工具，turn 以 `completed` 结束。
4. R3 成立且已知边界：同一 turn 里点停止会杀；turn 正常结束后不会。
5. 并行调用逐个处理；完成通知和 `next-turn` 消息不会误触发。

没证明：

- 没有真实模型和真实客户端（界面怎么渲染 `MOVED_TO_BACKGROUND` 的错误形占位、steering 消息在界面里的呈现、queue 与 steer 的实际使用习惯）。
- 转入后工具的真实结果不经过 post-execute 策略和 `tools/result` 观察者（那里只看到占位）：依赖这两处的功能（输出截断、文件状态跟踪、`finalizeContent`）对后台结果不生效。只确认了“不会重复触发”，没有逐个策略核对。
- 带审批的工具转入后台：审批发生在 pre-execute，早于转入，不受影响；审批等待期间的调用还没进入 `tools/execute`，所以此时不被跟踪、也不能转入或打断（没有测，按源码判断）。
- turn 结束后的停止、子 agent 里的调用、PTC 模式、HMR 热卸载的真实路径、Windows 均未测。
- 只在 0.2.1-rc.5 做了完整 loop 实验；0.2.0-rc.2 只验证了程序接口；rc.2 到 rc.4 靠源码对照（`packages/core/tools/src/index.ts` 在 `dsh-v0.2.1-rc.2` 到 `rc.5` 之间无任何差异）。

## 残余风险

1. 依赖宿主内部实现（R1）。宿主任何调整 `dispatchToolBody` 的 `finally`、冻结时机或 exec 对象形态的改动都可能让绕过失效。已有三道降级（版本门禁、访问器失败时拒绝转入、`next()` reject 时 job 记 `failed`），但“失效”的代价是用户已被告知“转入后台”而结果拿不到。
2. R3 不可解（见上）。
3. 后台结果绕过 post-execute 策略（见上）。
4. 占位只能是错误形态（R2）：模型靠文字“这不是失败，不要重试”，界面上显示为失败。
5. 默认 queue 导致插话策略几乎触发不了（见上）。
6. 模型行为：看到占位后可能误读（我们的占位文字要靠真实模型验证），也可能马上 `job_output wait`，把省下的时间又等回去。

## 建议

- **dock 按钮和设置：有条件的 go**。宿主侧机制成立，值得在其上做 dock 按钮（程序接口已就绪，RPC 只要调 `transfer` / `interrupt`）和会话级开关。条件：
  1. 先接受 R1/R3 是原型级限制，`foregroundControl` 保持默认关闭，在设置里标“实验性”；
  2. 先做 dock 按钮，再做插话策略；插话策略要同时处理 queue 默认值的问题（例如把策略也挂在队列项上，或在设置卡片里引导用户把忙时回车改成 steer）；
  3. 在真实模型会话里验证占位文字（模型是否照做、是否重试）。
- **同时向上游提 issue：是**。三个依赖点（`next()` 在冻结后 reject、调用方 signal 永远融合、占位只能是错误）都需要宿主提供官方的 detach 接口才能去掉绕过，且后台结果的 post-execute 处理只有宿主能做对。草稿在 [../upstream-issue-detach-api.md](../upstream-issue-detach-api.md)，未发布。
