# WiCi V1 Simplified Plan

## 产品边界

WiCi V1 是一个本地 TUI，用来把 Claude Code 的 plan mode 和 Codex 的执行能力接到一起。它不是新的 agent engine，不重新发明任务分类、权限系统、目标解析器或 benchmark 框架。

这个简化版保留 `PLAN.md` 的骨干需求：

- 三栏 TUI：Chat、热 Goal/Plan、事实执行流。
- Supervisor 单写黑板：TUI 只写 inbox、读事件和文件。
- Claude plan mode 做规划和澄清。
- Codex 执行 `PLAN.md`。
- 运行中 Chat 可以热更新 goal；中期架构下优先对活跃 Codex app-server turn 做 `turn/steer`，旧 `codex exec` 路径保留 safe-point preempt/resume fallback。
- `checkpoint.json`、`drained_inbox[]`、`events.jsonl`、`ledger.jsonl` 保证可恢复、可观察、不会重复应用输入。
- git checkpoint/commit/tag/rollback 是版本管理和可回退的骨架。
- tag 前必须跑真实 TUI canary。

核心原则：

- 用户从 Chat 输入自然语言目标。
- Claude plan mode 负责追问、理解目标、生成 `GOAL.md`、`PLAN.md`，并在任务确实需要时生成可选脚本/验证方法。
- Codex 负责按 `PLAN.md` 执行，包括查网、SSH、部署、调试、测量和迭代。
- 查教程、查文档、debug、换策略、更新 `PLAN.md` / `.opt` 是 planner/executor 的职责，不应该要求用户把这些 meta 指令写进 Chat。
- WiCi 只负责编排、显示、持久化、版本管理和回退，不替 planner/executor 做任务语义判断。

## V1 用户流程

1. 启动本地 TUI。
2. 初始状态下右侧 Goal/Execution 区域为空，Chat 是唯一入口。
3. 用户在 Chat 输入第一句需求，例如：

   ```text
   听说diffusionGemma很快，在ssh -p 23276 root@116.127.115.18 -L 8080:localhost:8080试试，要求达到700 token/s以上
   ```

4. WiCi 把原始对话写入面向人的 `GOAL.md`，不把 `700 token/s`、SSH 命令、应用类型等解析成 WiCi 自己的专用 JSON 语义。
5. 信息足够时，WiCi 启动 Claude Code plan mode；信息不足时，Claude 的澄清问题回到 Chat，用户直接在 Chat 回复。
6. Claude plan mode 生成或更新：
   - `GOAL.md`
   - `PLAN.md`
   - 如任务需要，生成 `.opt/checks.sh`、`.opt/measure.sh` 或其他 planner 认为合适的可选验证脚本
7. 一旦有 `PLAN.md`，WiCi 把 `GOAL.md` + `PLAN.md` 作为 goal 输入交给 Codex 执行。
8. Codex 自己完成 PLAN 里的执行工作。远端部署、SSH、模型选择、web search、benchmark、应用开发、测试修复都由 Codex 在执行阶段处理。
9. 运行过程中，用户继续在 Chat 输入的自然语言会进入 hot reload：
   - 普通消息追加/调整 `GOAL.md`。
   - Supervisor 在 executor iteration 之间的 safe point drain inbox。
   - goal version bump，写回 `GOAL.md` 和 `.wici/goal.json`。
   - Claude planner resume 生成最小 PLAN diff。
   - app-server 路径向当前 Codex turn 发送 `turn/steer`，让执行继续；旧 `codex exec` fallback 在 safe point / heartbeat preempt 后通过 resume 携带新的 requirement/steer。
10. TUI 持续展示：
   - Chat 问答和用户 steering
   - 当前 `GOAL.md` / `PLAN.md`
   - planner token usage
   - executor streaming progress / token usage
   - git 版本点和可回退状态

## Planner 命令边界

Planner 就是运行 Claude Code plan mode：

```bash
claude -p "<chat/goal context>" \
  --output-format stream-json \
  --verbose \
  --effort default \
  --permission-mode plan \
  --dangerously-skip-permissions \
  --append-system-prompt "$(cat prompts/planner.md)"
```

要求：

- 保留 Claude Code 原生能力，包括 plan mode 下允许的 web search、文件读取、SSH 相关规划等。
- WiCi 不维护自定义工具类别，不做额外 allowlist/denylist。
- plan mode 的产物必须是泛化的 markdown plan 和 planner 选择的验证方式，而不是 WiCi 内置的任务模板。
- 不使用 plan schema 生成第二套结构化 PLAN；schema 只允许用于 Codex 最终薄回执。
- 如果 planner 需要问问题，只问必要问题，问题通过 Chat 回到用户。

## Executor 命令边界

Executor 就是 Codex。中期正确架构优先使用 Codex app-server，因为它提供 thread/turn 生命周期和 `turn/steer`，能在执行中接收 hot reload；`codex exec` 继续作为兼容 fallback：

```bash
codex app-server --listen stdio://
```

WiCi client 通过 JSONL JSON-RPC：

- `initialize` + `initialized`
- `thread/start` 或 `thread/resume`
- `turn/start`
- `turn/steer` 追加运行中的用户/goal/plan 更新
- stream notifications 写入 `.wici/codex-run.jsonl`

旧 fallback 命令仍是：

```bash
codex exec \
  --dangerously-bypass-approvals-and-sandbox \
  --json \
  -C <target_or_workspace> \
  "<GOAL.md + PLAN.md>"
```

要求：

- Codex 按 `PLAN.md` 工作，不需要 WiCi 为不同任务写专门流程。
- app-server 是 real/auto 的优先 backend；如果 CLI 不支持 app-server、fake CLI 未实现该协议，或显式选择 legacy backend，则回退到 `codex exec`。
- 如果任务要上远端机器，就由 Codex 执行 SSH、部署和验证。
- 如果任务是开发一个应用，就由 Codex 创建/修改应用、运行测试、启动服务并验证。
- 如果任务是性能目标，如何测、测什么、何时算通过，都由 planner 写进 `PLAN.md`；需要复用命令时才生成脚本。

## Supervisor 能做什么

Supervisor 只做机械编排：

- 启动 planner。
- 启动 executor。
- 在 safe point drain Chat inbox，更新 `GOAL.md`，触发 planner diff。
- 把 stdout/stderr/json event 流写入 `.wici/`。
- 在 TUI 中展示 progress、token usage、状态和错误。
- 保存 `GOAL.md`、`PLAN.md`、planner/executor transcript。
- 保留 planner 产出的脚本；是否运行以及如何运行由 PLAN/Codex 驱动，不能成为 fresh V1 的 baseline 前置门槛。
- 没有 `.opt` 脚本也必须直接把 `GOAL.md + PLAN.md` 交给 Codex；脚本永远不是 fresh V1 启动执行的前置条件。
- 历史 `baseline.json` 不能让 V1 自动切回脚本 gate；旧 optimizer 必须显式打开。
- 记录 git checkpoint、tag、rollback 信息。
- 在 executor 卡住、退出或验证失败时，把事实交回 Codex 或 Claude 继续处理。
- goal 默认应该跑得足够长；单次命令失败、远端安装卡住、验证失败或一次 executor 超时，都不能轻易把整个 goal 标记为 blocked/FAILED。
- executor 失败后，Supervisor 记录事实到 `events.jsonl` / `ledger.jsonl` / `checkpoint.json`，然后在下一轮把失败原因交回 Codex，让 Codex 自己诊断日志和环境、更新 `PLAN.md` / `.opt`、换策略并继续迭代。
- 只有用户明确停止、硬性 backstop 触发，或经过多轮仍有同一个不可恢复外部阻塞且无法继续推进时，才可以停止；“第一条执行路径不通”不是停止条件。

Supervisor 不能做什么：

- 不能把用户句子解析成 WiCi 内置 metric，例如把“700 token/s以上”解析成固定 schema。
- 不能默认任务是 latency、p99、benchmark 优化或性能问题。
- 不能维护 hardcoded avenue/category。
- 不能为 diffusionGemma、某台 SSH 机器或某类 benchmark 写特判。
- 不能绕过 TUI/PLAN.md 手工执行 SSH、部署、探测模型或测量。
- 不能把 executor 的一次失败、一次 silent build、一次脚本错误直接当作整个用户目标失败；必须给 Codex 继续分析和修正计划的机会。
- 不能要求用户在 Chat 里追加“网上有教程、自己查资料、失败继续 debug”这类系统行为说明；这些默认属于 planner/executor 能力边界。
- 不能在完整真实通路验证前 tag 或 push。

## GOAL/PLAN 格式

`GOAL.md` 是面向人的 markdown，不是任务专用 JSON。

它应该包含：

- 原始用户需求。
- Chat 中追加的澄清和 steering。
- 当前 planner 对目标的理解。
- planner 认为必要的验收方式。

`PLAN.md` 是可执行计划，也用 markdown。

它应该包含：

- 稳定步骤 ID，并使用 WiCi 可识别的可执行步骤行，例如 `- [ ] S1 ...` 或 `### S1 — ...`。
- 每步要 Codex 做什么。
- 每步如何验证。
- 如果需要远端、服务、模型或 benchmark，写清楚由 Codex 如何准备和运行。
- 如果需要脚本，脚本由 planner 生成，WiCi 只负责落盘和展示；是否运行、何时运行、如何解释结果由 `PLAN.md` 驱动，交给 Codex 执行阶段处理。没有脚本时 `PLAN.md` 仍然是完整可执行输入。

## V1 必须完成的功能

- 本地三栏 TUI：Chat、Goal/Plan、Execution。
- 初始右侧两栏为空，Chat 第一条消息驱动 planner。
- 运行中 Chat 消息热更新 goal，不需要重启 TUI 或 executor session。
- Hot reload 必须保证 idempotency：同一个 inbox 输入不能在 resume 后重复应用。
- Claude planner 支持 clarification，通过 Chat 问答继续。
- planner token usage 可见。
- Codex executor streaming progress 可见。
- executor token usage 可见。
- executor 失败/超时是可恢复事件：ledger 记录 crash，下一轮 Codex resume 获得失败上下文，可以 debug、更新 `PLAN.md`、修 `.opt`、继续同一个 goal。
- `GOAL.md` / `PLAN.md` 持久化。
- planner 生成的脚本如果存在，必须持久化并可运行。
- git checkpoint 和 rollback 文档清楚。
- tag 前必须跑完整真实通路验证。

## V1 真实通路验证

每次 tag 前必须用 TUI 真实跑一遍泛化 canary，不能用手工 shell 替代 agent 执行。

当前 canary 的第一句 Chat：

```text
听说diffusionGemma很快，在ssh -p 23276 root@116.127.115.18 -L 8080:localhost:8080试试，要求达到700 token/s以上
```

这句必须只包含用户真实需求。不要把“自己查资料”“失败后继续 debug”“更新 PLAN.md/.opt”之类 meta 指令塞进 canary Chat；这些行为应由 planner prompt、executor prompt 和 `PLAN.md` 默认承载。

通过证据：

- TUI 从空 Goal/Execution 开始。
- Chat 第一条消息触发 planner。
- 生成 `GOAL.md` 和 `PLAN.md`。
- 如需要脚本，脚本由 planner 生成。
- 事件流里有 `PLAN_USAGE`。
- 事件流里有 Codex `EXECUTE_PROGRESS`。
- SSH、部署、测量由 Codex 根据 `PLAN.md` 执行，不由操作者手工完成。
- 最终输出说明是否达到 `700 token/s以上`，以及失败时下一步该怎么继续。
- tag 前保存本次 transcript、版本点和 rollback 信息。

## 非目标

- 不做专门的 latency 工具。
- 不做专门的性能优化平台。
- 不做 benchmark schema 产品。
- 不做任务类别系统。
- 不做 supervisor semantic parser。
- 不做 diffusionGemma 特化。
