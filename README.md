# Thinkless

Thinkless is a local TypeScript + Ink TUI that wraps Claude Code plan mode and Codex execution into a simpler chat-first workflow.

The V1 path is intentionally thin:

- Chat is the initial intake and output surface.
- `GOAL.md` is a human-readable markdown goal built from the conversation.
- Claude Code plan mode produces `ASSUMPTIONS.md`, `PLAN.md`, and, when useful, `.opt/checks.sh` / `.opt/measure.sh`.
- Once `PLAN.md` exists, Thinkless feeds `GOAL.md + PLAN.md` directly to Codex.
- The supervisor handles TUI state, events, token usage, checkpoints, git rollback points, and hot reload.

Thinkless does not parse natural-language requirements into task-specific schemas. If the user says "700 token/s" or asks to build an app, that raw requirement goes into `GOAL.md` once Chat decides it needs planner/executor. A bounded SSH/code-reading request can stay in Chat; a longer remote deployment, debug, benchmark, or optimization loop becomes planner/executor work.

Chat agents run with enough native CLI permission to complete bounded direct work themselves: Claude Chat is not forced into plan-only mode, and Codex Chat uses a network-capable sandbox. Chat still must not commit, push, deploy, run destructive commands, or start long benchmark/debug loops itself.

## Safety

Real mode uses Claude Code plan mode with `--dangerously-skip-permissions` for planning and `codex exec --dangerously-bypass-approvals-and-sandbox` for execution. A disposable VM or container is safest. Direct use on a primary machine is supported when the target repo is under git and the Thinkless checkout is versioned.

The `--target` path must be the git top-level for the target workspace. If the target does not exist, is empty, or only contains Thinkless-owned `.thinkless/` or legacy `.wici/` plus `.opt/` scaffolding, Thinkless initializes a local git repo before planning; existing non-git directories with user files are rejected.

WiCi does not pass CLI budget caps to Claude or Codex. The default `max_cost_usd` is `0` and default `max_iters` is `0`; together they disable WiCi's own cost and iteration hard stops for real runs. Use explicit `--max-iters`, `deadline`, or manual stop control only when you want a bounded run.

## Commands

Core V1 checks:

```bash
npm install
npm run verify:v1-core
npm run verify:v1-slice
npm run verify:direct-no-scripts
npm run verify:direct-recovery
npm run verify:direct-preempt
npm run verify:direct-plan-continuation
npm run verify:self-interrogation
npm run verify:continuation-verdict
npm run verify:existing-goal
npm run verify:v1-requirements
npm run verify:tui-structure
npm run verify:tui-chat-intake
npm run verify:resume-selector
npm run verify:tui-resume-selector-pty
npm run verify:tui-resume-selector-built
npm run verify:tui-resume-legacy-candidate
npm run verify:tui-resume-cross-target
npm run verify:resume-rerunnable
npm run verify:tui-chat-pty
npm run verify:tui-real-fake-chat
npm run verify:tui-planner-clarification-pty
npm run verify:tui-hotreload-pty
npm run verify:demo-tui
npm run verify:tui-live
npm run verify:planner-clarification
npm run verify:hotreload
npm run verify:hotreload-resume
npm run verify:app-server-hotreload
npm run verify:durability
npm run verify:goal-doc
npm run verify:tool-commands
npm run verify:real-mode
npm run verify:executor-contract
npm run verify:codex-run-usage
npm run verify:goal-metric
npm run verify:goal-interrogation
npm run verify:curriculum
npm run verify:rollback
npm run verify:setup-state
npm run verify:install-bootstrap
npm run verify:install-clean-env
npm run verify:ssh-evidence
npm run verify:canary-evidence
npm run verify:release-tag
npm run verify:no-secrets
npm run verify:docs-sync
```

Individual and extended verifier scripts remain available:

```bash
npm run typecheck
npm run build
npm run smoke
npm run verify:audio-dictation
npm run verify:bin
npm run verify:direct-plan-continuation
npm run verify:durability
npm run verify:existing-goal
npm run verify:hotreload
npm run verify:inbox-backpressure
npm run verify:safety-prompts
npm run verify:state-paths
npm run verify:runtime-fallback
npm run verify:startup-self-update
npm run verify:rollback
npm run verify:outbox
npm run verify:tool-version
npm run verify:audio-dictation
npm run verify:codex-run-usage
npm run verify:clarify
npm run verify:claude-probe
npm run verify:goal-doc
npm run verify:tag-gate
npm run verify:ssh-evidence
npm run verify:canary-evidence
npm run verify:release-tag
npm run verify:no-secrets
npm run verify:install-bootstrap
npm run verify:install-clean-env
npm run verify:limit-artifact
npm run verify:runtime-fallback
npm run verify:startup-self-update
npm run verify:state-paths
```

Legacy optimizer compatibility checks are intentionally outside the fresh V1 gate. They keep the old benchmark/baseline path buildable for existing fixtures, but they are not requirements for starting Codex from a new Chat goal:

```bash
npm run verify:legacy-optimizer
npm run verify:manual-lock
npm run verify:benchmark-manifest
npm run verify:acceptance-spec
npm run verify:mann-whitney
npm run verify:heldout
npm run verify:scorer-selftest
npm run verify:prescreen
npm run verify:metric-labels
npm run verify:commit-idempotency
npm run verify:tamper
npm run verify:stuck
npm run verify:ask-stop
npm run verify:stop-policy
npm run verify:resume-iteration
npm run verify:branch-archive
npm run verify:branch-outcome
npm run verify:lessons
npm run verify:skills
npm run verify:context-condensation
```

Open or resume the local demo target in the Chat-first TUI:

```bash
npm run dev
```

After installing the `thinkless` binary, start a fresh Chat-first TUI workspace with:

```bash
thinkless
```

Bare `thinkless` attaches to the current git repository by default. Typing the first concrete goal creates `GOAL.md`, `PLAN.md`, `.opt/`, and `.thinkless/` in that repository; outside git, Thinkless falls back to a new isolated workspace under `~/thinkless-workspaces`. Existing `.wici/` runs are still discovered for compatibility, and `thinkless resume` can migrate an isolated legacy run back into the matching real repository as `.thinkless/` state.

To continue an existing run, use `thinkless resume` or type `/resume` in the TUI Chat input to open the selectable resume page.

Use `npx tsx src/cli.tsx demo --fresh` when you intentionally want to reset the demo target.

Run headlessly over a target:

```bash
npx tsx src/cli.tsx run --target /path/to/target --goal "Build the requested app and verify it runs locally"
```

Check tool availability:

```bash
npx tsx src/cli.tsx doctor
npx tsx src/cli.tsx doctor --update
npx tsx src/cli.tsx doctor --deep
```

`doctor --update` runs the Codex and Claude updaters, then reports health. `doctor --deep` performs a Claude print-mode auth probe. On supervisor start, Thinkless automatically checks for Codex/Claude updates at run boundaries when `tools.auto_update` is true, then records the versions in the checkpoint, and pending updates are not a WiCi supervisor start gate. Real mode only requires the CLIs to be reachable and healthy enough to run.

Use `--mode stub`, `--mode auto`, or `--mode real` on `run` / `tui`.

## Chat-First Flow

In an interactive TUI with no existing run and no `--goal`, the top Chat History / Goal/Plan / Execution workspace starts empty and can be switched with the left/right arrows, while the Chat input stays fixed at the bottom. The first natural-language Chat message is ordinary conversation first: the Chat agent may answer questions, inspect local or remote code, run bounded non-destructive discovery commands, or make small self-contained edits without starting a run. When the user asks for a plan, or the Chat agent decides the work is large, long-running, risky, or concrete enough for planner/executor, it emits an update; Thinkless creates `GOAL.md`, records `goal_source: "tui_chat"`, and starts Claude Code plan mode. If Claude needs a clarification before materializing `PLAN.md`, or later while updating `PLAN.md` after a hot-reload Chat message, Thinkless surfaces that as a Chat question and routes the next ordinary Chat message back as the answer. That answer wakes the stopped supervisor and resumes the same Claude planner session.

The active workspace shows its current runtime selection. Press `Ctrl+R` to open the selector, use left/right to choose `agent` or `effort`, use up/down to cycle values, then press Enter or Escape to close it. The bottom Chat input is paused while the selector is open. `agent` is always one of `claude` or `codex`; model is fixed by that agent: `claude` uses `claude-opus-4-8`, and `codex` uses `gpt-5.5`. Chat remains Claude-first and falls back to Codex medium when Claude is unavailable. PLAN defaults to Codex xhigh.

Terminal text selection/copy is the default pointer mode in the Chat, PLAN, and EXECUTION panes. Terminal mouse protocols cannot reliably provide native drag selection and app-level touchpad scrolling at the same time, so Thinkless exposes two explicit modes: `mouse=select` for normal terminal selection, and `mouse=scroll` for TUI mouse-wheel/touchpad scrolling. Press `Ctrl+O` in the TUI to toggle modes, or start in scroll mode with `--mouse-reporting`.

Typed commands remain available for custom values that are not in the selector presets:

```text
/agent chat claude
/effort execution high
/dictate
/dictate submit
```

Valid panes are `chat`, `plan`/`planner`, and `execution`/`exec`/`executor`. Claude effort options are `high`, `xhigh`, `max`, and `ultracode`. Codex effort options are `fast`, `medium`, `high`, and `xhigh`. Claude-backed panes receive `--model claude-opus-4-8` and the selected `--effort`; Codex-backed panes receive `--model gpt-5.5`, and Codex effort is passed through config as `model_reasoning_effort`.

`/dictate` runs the local command configured in `WICI_DICTATION_COMMAND`, normalizes its stdout as transcript text, and inserts it into the bottom Chat input. `/dictate submit` sends that transcript immediately. The command can be any local speech-to-text bridge, such as a macOS Shortcut wrapper, Whisper CLI, or organization-approved transcription tool; Thinkless does not store speech credentials in config.

Planner output is markdown artifacts, not a second goal schema:

- `## GOAL.md` is optional and can carry planner-updated human-readable goal context.
- `## ASSUMPTIONS.md` records the planner's self-interrogation: approaches considered, assumptions adopted with evidence or planned discovery, and open risks.
- `## PLAN.md` is required.
- `## .opt/checks.sh` is optional.
- `## .opt/measure.sh` is optional.
- `## QUESTION` is used only when essential information is missing and cannot be resolved from evidence or a Codex discovery step.

The absence of `.opt` scripts is a valid fresh V1 path. Thinkless must still hand `GOAL.md + PLAN.md` directly to Codex; scripts are planner artifacts for tasks that need reusable commands, not a supervisor-controlled execution prerequisite.

Planner mode can run through Codex or Claude. Codex is the default planner backend with xhigh effort; if a Claude-backed planner is selected and Claude is unavailable, Thinkless falls back to Codex xhigh. Thinkless does not pass a custom tool allowlist or denylist; planning-time web research or remote discovery can be used when the planner needs context for `PLAN.md`. The planner should brainstorm 2-3 approaches, self-grill its assumptions, persist the result in `ASSUMPTIONS.md`, and ask the user only for information that is essential and unresolvable by evidence or discovery. The deployment, benchmark target, application build, or optimization result still belongs in Codex execution after `PLAN.md` is materialized.

Users should not need to add meta-instructions such as "search tutorials", "debug if one path fails", or "update PLAN.md/.opt and keep going" to the Chat goal. Those are planner/executor responsibilities. Planner should encode research and fallback strategy in `PLAN.md` when the task needs it, and Codex should use native tools, logs, documentation, and environment inspection during execution.

When `PLAN.md` exists, the fresh V1 path starts Codex directly. It does not require `baseline.json`, `.opt/benchmark.json`, `acceptance.spec.json`, or pre-run measurements before execution. A stray or historical `baseline.json` does not switch V1 into an eval-gated loop; the legacy optimizer must be explicitly enabled with `WICI_LEGACY_OPTIMIZER=1`.

During real planning, the Execution pane tails `PLAN_USAGE` events from Claude's stream-json output and the planner stream is saved under `.thinkless/artifacts/planner-*.stdout.jsonl` for new runs. Real Codex execution defaults to `codex app-server` in `auto` mode when the CLI supports it, streams raw app-server JSON-RPC notifications into `.thinkless/codex-run.jsonl`, checkpoints the active workspace, turn phase, last event, and last activity time, and shows progress in the Chat status line. Existing `.wici/` runs keep using their legacy directory. If app-server is unavailable, stalls without progress, or a fake legacy CLI is on `PATH`, Thinkless falls back to a recoverable retry path; the legacy executor watchdog remains intentionally long for remote deploys, model downloads, builds, and benchmarks after Codex has started actionable work.

Thinkless does not treat a single executor failure as the whole goal failing. Direct V1 execution is intentionally long-horizon: command failures, failed validation, and executor timeouts are recorded as recoverable crash ledger rows, the active `PLAN.md` step is reset to pending, and the next Codex prompt receives the failure reason. Codex is allowed to inspect logs and remote state, update `PLAN.md`, repair planner-provided `.opt` scripts, choose a different deployment or validation strategy, and continue the same `GOAL.md` until the goal is actually satisfied or there is concrete repeated evidence that it cannot proceed.

When direct execution exhausts `PLAN.md`, Thinkless runs a continue-biased completion gate before asking the planner for another step. The gate reads `GOAL.md`, acceptance criteria, recent ledger rows, and `ASSUMPTIONS.md`; only an explicit `complete` verdict stops cleanly. Stub mode, tool errors, and ambiguous verdicts continue so the planner can deepen quality within the fixed user scope without inventing new scope.

Later Chat messages are drained through `.thinkless/inbox/` for new runs, or `.wici/inbox/` for legacy sessions. With the app-server backend, Thinkless updates `GOAL.md`, asks Claude plan mode for the smallest `PLAN.md` update, then sends `turn/steer` to the active Codex turn so execution continues without restarting. With the legacy `codex exec` fallback, Thinkless preempts at the next executor output or heartbeat, applies the same planner diff, and resumes through `codex exec resume --last`.

If the supervisor crashes during direct V1 execution, restart the same command. Thinkless uses `checkpoint.json` and `wici/best` to revert unconfirmed direct-path work, resets the active `PLAN.md` step for replay, and preserves `.thinkless/` or legacy `.wici/` event and ledger history.

## V1 Acceptance

V1 is the first usable vertical slice: a human can install WiCi, start the TUI from an empty run, chat a goal, watch planner usage, watch Codex progress, and inspect the generated markdown artifacts.

The current requirement-by-requirement audit is kept in `docs/v1-completion-audit.md`.

Run the automated V1 gate:

```bash
npm run verify:v1-slice
```

That command creates `fixture/v1-slice-target`, runs one stubbed direct supervisor iteration, and checks:

- `GOAL.md` and `PLAN.md` are materialized;
- optional planner scripts are persisted executable and runnable when present, while no-script plans still execute directly;
- fresh execution does not wait for baseline or evaluation gates;
- the executor prompt gives Codex `GOAL.md + PLAN.md` as one goal while keeping step IDs only as a thin receipt/progress focus;
- direct execution writes a thin `ledger.jsonl` receipt with token usage for observability;
- a git checkpoint and `wici/best` rollback tag are created;
- the TUI header displays the current rollback checkpoint, or `rollback pending` before one exists;
- direct executor failure is recoverable: the first failed attempt is recorded as `crash`, the next Codex invocation resumes with the failure context, and the same goal can continue;
- the non-fullscreen TUI can render the bottom Chat input plus the switchable Chat History / Goal/Plan / Execution workspace over the run state.

`npm run verify:direct-no-scripts` covers the complementary path: an existing markdown `PLAN.md` can execute directly without `.opt/checks.sh`, `.opt/measure.sh`, or `.opt/benchmark.json`.

`npm run verify:direct-recovery` covers long-goal recovery: a fake real-mode Codex fails the first invocation, WiCi records `EXECUTE_RECOVERABLE_FAILURE` without entering `FAILED`, then the second invocation uses `codex exec resume --last` and completes.

`npm run verify:direct-preempt` covers the legacy fallback path: a fake real-mode `codex exec` run is interrupted after pending Chat input appears, WiCi records `EXECUTE_PREEMPTED`, drains the inbox, applies a planner diff, then resumes Codex.

`npm run verify:direct-plan-continuation` covers exhausted-plan continuation: if `PLAN.md` has no pending steps, Thinkless asks the planner for another in-scope step instead of stopping merely because the markdown checklist is empty.

`npm run verify:self-interrogation` covers AI-led planning assumptions: the planner prompt requires 2-3 approaches, self-grilling, narrow `## QUESTION` use, and materializes `ASSUMPTIONS.md`.

`npm run verify:continuation-verdict` covers the direct completion gate: explicit `complete` stops, explicit `continue` continues, and ambiguous or stub verdicts fall back to continue.

`npm run verify:existing-goal` covers continuing a target that already has `GOAL.md` and `PLAN.md` without passing a new `--goal`.

`npm run verify:tui-live` starts the `tui` command itself with the supervisor enabled and verifies that the live execution stream reaches the TUI while the target run commits and stops cleanly.

`npm run verify:tui-chat-pty` starts the TUI in a real pseudo-terminal, types the first Chat message, submits it through the input line, and verifies that the run records `goal_source: "tui_chat"` before executing `GOAL.md + PLAN.md`.

`npm run verify:tui-real-fake-chat` runs the same Chat-first PTY path in `--mode real` with fake Claude/Codex CLIs on `PATH`, proving the TUI starts the real-mode planner/executor subprocess path and streams `EXECUTE_PROGRESS` without spending real tokens.

`npm run verify:tui-planner-clarification-pty` covers the next interactive path: Claude plan mode asks a clarification question, the user answers through the same Chat input, and WiCi resumes the planner session to materialize `PLAN.md`.

`npm run verify:tui-hotreload-pty` keeps the same TUI open through an execution safe point, types a follow-up Chat requirement, and verifies that WiCi drains the inbox, updates `GOAL.md` / `PLAN.md`, and starts the next Codex iteration after `PLAN_DIFF_APPLIED`.

`npm run verify:hotreload-resume` covers the legacy real-mode command shape after hot reload with fake CLIs: the first Codex call starts normally, and the next execution after `PLAN_DIFF_APPLIED` uses `codex exec resume --last` without the unsupported `-C` flag.

`npm run verify:app-server-hotreload` covers the preferred medium-term path: a fake `codex app-server` keeps an active turn open, WiCi drains Chat input, updates `GOAL.md` / `PLAN.md`, sends `turn/steer`, and completes without `EXECUTE_PREEMPTED`.

## Deployment

Install Thinkless from the public release artifact:

```bash
curl -fsSL https://github.com/wici-ai/thinkless/releases/latest/download/install.sh | bash
```

That one-line installer downloads `thinkless.tgz` from the latest public release and installs it globally with npm. The release contains the built package and installer assets. If you need a different release host, set `THINKLESS_RELEASE_BASE` or `THINKLESS_TARBALL_URL` before running the installer.

On startup, the `thinkless` CLI checks the latest GitHub release and self-updates when the release is newer than the local package version. Global installs update from the release `thinkless.tgz`; clean source checkouts fetch and detach to the release tag, then run `npm install` and `npm run build`. Dirty source checkouts are left alone, and network, GitHub, or update failures fail open so launch continues. Set `THINKLESS_SELF_UPDATE=0` to disable the startup check, `THINKLESS_SELF_UPDATE_VERBOSE=1` to print the decision, `THINKLESS_RELEASE_REPO=owner/repo` for a different release repository, or `THINKLESS_TARBALL_URL` for a custom tarball.

The included `Publish public install release` workflow is manually triggered. It builds `thinkless.tgz` from the selected source tag with `fetch-depth: 1`, then uploads `thinkless.tgz` and `install.sh` to this public repository's GitHub release using the workflow token.

Install from a source checkout:

```bash
git clone git@github.com:wici-ai/thinkless.git
cd thinkless
git checkout <verified-release-tag-or-commit>
npm install
npm run build
npm run verify:v1-core
```

## macOS Bootstrap

On macOS, `npm install` runs `scripts/postinstall.mjs` automatically. The hook checks the host commands Thinkless needs: `brew`, `git`, `node`, `npm`, `gh`, `codex`, and `claude`. Missing `brew`, `codex`, and `claude` are installed with the official macOS installers; missing `git`, GitHub CLI, or Node.js/npm are installed through Homebrew. A fresh Mac needs an admin account with usable `sudo` access before Homebrew installation can proceed. Thinkless does not run npm install scripts with `sudo`; use Homebrew Node.js or another user-writable npm global prefix. CI and non-macOS installs skip this bootstrap by default. To bypass host mutation on a Mac, run `THINKLESS_BOOTSTRAP=0 npm install`.

For a brand new Mac with no `npm` yet, run the bootstrap shell script first. From a checkout:

```bash
bash scripts/bootstrap-macos.sh
```

From a clean machine, use the public release installer instead:

```bash
curl -fsSL https://github.com/wici-ai/thinkless/releases/latest/download/install.sh | bash
```

That script waits for the Apple Command Line Tools installer when macOS prompts for it, verifies `sudo` access when system dependency installation is needed, installs Homebrew, Node.js/npm, git, GitHub CLI, Codex CLI, and Claude Code CLI, then installs Thinkless with npm lifecycle scripts enabled. It adds the discovered command directories for `node`, `npm`, `thinkless`, `codex`, `claude`, and `gh` to `~/.zprofile` and `~/.zshrc` when needed, verifies those commands from clean zsh login and interactive shells, then prints the exact `export PATH=...` and `export PATH=... && thinkless` commands to update the current terminal or launch Thinkless immediately.

After command verification, the public installer and `scripts/bootstrap-macos.sh` always print an auth onboarding status for Codex, GitHub CLI, and Claude. When a terminal is available, the installer prompts through `/dev/tty` so `curl | bash` can still run `codex login` or `codex`, `gh auth login`, and `claude` interactively. Set `THINKLESS_AUTH_ONBOARDING=0` to skip the prompts and finish auth later. If auth is skipped, declined, or unavailable in a non-interactive shell, the installer reports that auth is pending instead of claiming full setup is complete.

If you already have trusted local config files, pass them during install with a private bundle:

```bash
THINKLESS_CONFIG_BUNDLE=/path/to/private-thinkless-config npm install
```

Bundle files are copied to user-scoped locations only:

```text
.codex/config.toml       -> ~/.codex/config.toml
.codex/auth.json         -> ~/.codex/auth.json
.claude/settings.json    -> ~/.claude/settings.json
.claude/.credentials.json -> ~/.claude/.credentials.json
```

Existing user config is not overwritten unless `THINKLESS_BOOTSTRAP_FORCE=1` is set. `~/.codex/auth.json` and `~/.claude/.credentials.json` are credential files; keep them out of the repository, tickets, logs, and chat. `wici.config.json` remains Thinkless repo configuration only, not a place for provider secrets.

If you do not provide copied credentials, authenticate Codex, Claude, and GitHub CLI interactively:

```bash
codex
gh auth login
claude
codex --version
codex doctor
gh --version
gh auth status
claude --version
thinkless doctor --deep
```

Codex `doctor` reachability failures are recorded as diagnostics, not a hard real-mode start gate. Real mode still requires the Codex, Claude, and GitHub CLI commands to be present and version checks to succeed.

Set provider-specific environment variables in the shell or container runtime. Keep credentials out of the repository and out of committed config files.

Before a real run, pin the Thinkless version you are using:

```bash
git -C /path/to/thinkless status --short
git -C /path/to/thinkless rev-parse HEAD
```

The supervisor records the Thinkless package version, git commit, and dirty flag in `<target>/.wici/checkpoint.json` under `tool_versions.wici`. Codex/Claude/GitHub CLI changes are treated as recoverable external tool drift: Thinkless auto-updates Codex and Claude at run boundaries when `tools.auto_update` is true, and accepts/logs external CLI version changes if a resumed active checkpoint observes a new CLI version. Active runs still reject Thinkless package/git/mode drift; change Thinkless commits only between runs or roll back to the checkpointed commit.

Require real CLIs:

```bash
npx tsx src/cli.tsx run \
  --target /workspace/target-repo \
  --goal "Build the requested app and verify it runs locally" \
  --mode real
```

Use the TUI in real mode:

```bash
mkdir -p /workspace/target-repo
npx tsx src/cli.tsx tui \
  --target /workspace/target-repo \
  --mode real
```

For the release canary, start that TUI with an empty Chat History / Goal/Plan / Execution workspace, then paste the canary request into the bottom Chat input as the first message. Do not pass the canary as `--goal`; the release proof is the Chat-first path.

The three runtime panes can also be configured through environment variables:

```bash
WICI_PLANNER_EFFORT=high \
WICI_EXECUTOR_AGENT=codex \
WICI_EXECUTOR_EFFORT=fast \
npx tsx src/cli.tsx tui \
  --target /workspace/target-repo \
  --mode real
```

## Resume Or Re-Run

To continue an existing goal, use the explicit resume command without a new `--goal`. Thinkless reads the existing `GOAL.md`, `PLAN.md`, `.thinkless/checkpoint.json` or legacy `.wici/checkpoint.json`, Chat transcript/session/runtime files, planner and executor session metadata, `events.jsonl`, and `ledger.jsonl`, then resumes from the recorded state:

```bash
thinkless resume --target /workspace/target-repo --mode real
```

Without `--target`, `thinkless resume` first checks the current git repository for an existing Thinkless run. If the current repo has no state but a matching legacy isolated workspace exists under `~/thinkless-workspaces`, Thinkless migrates that run into the current repo as `.thinkless/` state, resets fixture-completed plans to a real-repo replan step, and resumes there. Otherwise it falls back to the latest run under `~/thinkless-workspaces`.

If you are already in the TUI, type `/resume` in the bottom Chat input to open an in-TUI selector. The selector lists the current target, numbered `.thinklessN` sessions, compatible legacy `.wici` runs, and recent Thinkless workspaces. Use up/down to choose a run, Enter to launch a runnable candidate, or Escape to cancel. Each row shows whether the candidate is runnable or blocked, the supervisor state, the selected session directory when relevant, and a short reason. A candidate is runnable only when Thinkless can restore the selected full context or intentionally rerun an interrupted planner/executor path from durable `GOAL.md`, `PLAN.md`, checkpoint, ledger, and session state. Blocked read-only states, such as chat-only history or a pending planner clarification without a stored planner session, are visible but cannot be launched as resume.

`npm run verify:resume-selector` covers catalog discovery and preflight labels. `npm run verify:tui-resume-selector-pty` covers the source PTY `/resume` selector flow. `npm run verify:tui-resume-selector-built` drives the packaged CLI entrypoint, proves up/down selection, Enter launch, Escape cancellation, and blocked-candidate refusal without `RESUME_CONTEXT_VALIDATED`, `SUPERVISOR_START`, or `EXECUTOR_RESUME_FALLBACK` side effects. `npm run verify:tui-resume-cross-target` covers selecting a historical workspace run while appending `RESUME_CONTEXT_VALIDATED` and `SUPERVISOR_START` only to the selected target/session and preserving Chat, planner, executor, checkpoint, GOAL, PLAN, ledger, and app-thread metadata. `npm run verify:resume-rerunnable` covers blocked planner and executor rerun/fallback events (`RESUME_CONTEXT_VALIDATED`, `RESUME_CONTEXT_BLOCKED`, and `EXECUTOR_RESUME_FALLBACK`). The core V1 aggregate, `npm run verify:v1-core`, includes the built selector and cross-target resume checks so packaged `/resume` acceptance stays in the release-facing gate.

Headless continuation remains available, but it is intentionally explicit about the target:

```bash
npx tsx src/cli.tsx run \
  --target /workspace/target-repo \
  --mode real
```

To rewind to a saved iteration snapshot before continuing, use `--resume-iteration`:

```bash
npx tsx src/cli.tsx run \
  --target /workspace/target-repo \
  --resume-iteration 1 \
  --mode real
```

Hot-reload Chat input is idempotent through `checkpoint.json` `drained_inbox[]`; restarting WiCi does not apply the same inbox message twice.

## Tag Gate

Every release tag must pass a real TUI canary, not a hand-run shell substitute. A representative V1 canary starts from an empty Chat History / Goal/Plan / Execution workspace and uses this first Chat message:

```text
听说diffusionGemma很快，在ssh -p 23276 root@116.127.115.18 -L 8080:localhost:8080试试，要求达到700 token/s以上
```

Keep that first Chat as the real user request only. Do not append WiCi behavior instructions such as "search tutorials", "debug failed paths", or "update PLAN.md/.opt and continue"; those requirements belong in the planner and executor prompts, not in canary input.

Passing evidence:

- Chat first input triggered Claude plan mode.
- `GOAL.md` and `PLAN.md` were generated.
- `PLAN_USAGE` events show planner token usage.
- `EXECUTE_PROGRESS` events show Codex activity.
- SSH, deployment, and measurement were attempted by Codex according to `PLAN.md`, not by the operator manually.
- The final output says whether the target was reached or what blocked it.
- Failed canaries record `failure_reason` and `next_required_action` so the release blocker is explicit.

Record each real canary under `docs/release-canaries/`. Before creating any release tag, run the release preflight:

```bash
npm run release:preflight
```

That single command runs the automated V1 core gate and then the real canary tag gate. To inspect only the latest canary evidence, run:

```bash
npm run verify:tag-gate
```

The tag gate validates both the markdown evidence and the referenced run artifacts, then exits non-zero until the latest canary evidence says `status: passed` and `tag_allowed: true`. When blocked, the report prints `release_action: blocked_do_not_tag_or_push`; any existing local release tags are not proof that the current worktree is releasable. A non-zero result is expected while the latest canary is still failed. The current diffusionGemma remote canary is recorded as failed because Codex reached SSH itself but the remote rejected available public keys; the next required action is to provide working SSH credentials or install an accepted public key, then rerun the same first Chat through the TUI.

Create a release tag only through the guarded command:

```bash
npm run release:tag -- 0.1.0
```

`release:tag` runs `release:preflight` first and only then creates an annotated local git tag. It never pushes. If the real canary gate is blocked, the command exits before `git tag`.

For a release tag, the canary version point must also match the current WiCi checkout: the evidence commit must equal current `HEAD`, the canary must have been recorded from a clean WiCi checkout, and the current checkout must be clean. Passed canaries must be recorded from `mode: real`, not stub fixtures, must have `run_checkpoint.goal_source: "tui_chat"`, and must also record a clean target git checkout after the run. Old passed canaries, dirty-worktree canaries, stub canaries, non-Chat-first canaries, and canaries that leave uncommitted target changes do not authorize tagging a newer or modified worktree.

The evidence bundle must be backed by committed artifact files. For a canary `docs/release-canaries/<name>.md`, put the bundle at `docs/release-canaries/<name>/evidence.json` and copy each generated artifact under `docs/release-canaries/<name>/artifacts/` using the same relative path, for example `artifacts/GOAL.md`, `artifacts/PLAN.md`, `artifacts/.wici/events.jsonl`, and `artifacts/.wici/codex-run.jsonl`. `npm run verify:tag-gate` checks the recorded sha256 and byte length for every artifact listed in `generated_artifacts`, and verifies copied planner `.sh` artifacts remain executable.

After a real TUI canary run, use the recorder to create the markdown evidence, `evidence.json`, copied artifacts, and hashes:

```bash
npm run release:record-canary -- \
  --name 2026-06-15-diffusiongemma-remote \
  --target fixture/real-canary-v1 \
  --status failed \
  --tag-allowed false \
  --first-chat "听说diffusionGemma很快，在ssh -p 23276 root@116.127.115.18 -L 8080:localhost:8080试试，要求达到700 token/s以上" \
  --started-from-empty-tui true \
  --operator-manual-execution false \
  --codex-attempted-ssh true \
  --target-value 700 \
  --unit token/s \
  --failure-reason "Codex reached SSH, but authentication failed." \
  --next-required-action "Provide working SSH credentials, then rerun the same Chat-first canary."
```

For a passed canary with `--target-value`, also provide `--observed-value <number>`. The recorder and tag gate require the observed value to reach the recorded target and use the same `--unit`.

For any passed canary, the recorder requires `--started-from-empty-tui true`, `--operator-manual-execution false`, and checkpoint evidence that the run started from the first Chat message (`goal_source: "tui_chat"`); evidence that skips the Chat-first path or uses manual SSH/deployment/measurement is rejected before tag-gate review.

## Rollback

If a direct-host real run goes wrong, stop the supervisor first. The target repo can be restored to the best recorded commit:

```bash
npx tsx src/cli.tsx rollback --target /workspace/target-repo
npx tsx src/cli.tsx rollback --target /workspace/target-repo --confirm
```

The first command is a non-destructive preview. The second command runs `git reset --hard` to `wici/best` when available, otherwise to the recorded best commit, then runs `git clean -fd` while preserving `.wici/`.

To restore the Thinkless orchestrator version that started the run:

```bash
WICI_COMMIT="$(jq -r .tool_versions.wici.git_commit .wici/checkpoint.json)"
git -C /path/to/thinkless checkout "$WICI_COMMIT"
```

## Legacy Optimizer Path

Some verifier scripts and supervisor modules still exercise the older benchmark/baseline optimizer path for compatibility. That path can use `baseline.json`, `.opt/benchmark.json`, `acceptance.spec.json`, locked scripts, and ledger comparisons only when the legacy optimizer is explicitly enabled with `WICI_LEGACY_OPTIMIZER=1` or `evaluation.legacy_optimizer: true`. It is not the fresh V1 default.
