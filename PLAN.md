# WiCi — Autonomous Long-Horizon Coding TUI Orchestrator

> Current V1 note: this file preserves the original long-horizon optimizer design notes.
> The active fresh V1 contract is in `Simplified_PLAN.md` and `README.md`: Chat writes
> `GOAL.md`, Claude Code plan mode writes markdown `PLAN.md` plus optional artifacts,
> and Codex executes `GOAL.md + PLAN.md` directly. Baseline/checks/measure gating in
> this historical document belongs only to the explicit legacy optimizer path and must
> not block fresh V1 execution. Do not use lower sections of this historical file to
> infer that `.opt` scripts, `baseline.json`, or pre-run measurements are required in
> the fresh V1 path.

## Context

**Problem this solves.** Engineers at the user's company are reluctant to hand goals to AI: they over-invest in understanding architecture and repeatedly confirm before letting the AI act. The thesis: given a *clear requirement*, you should let AI **plan rigorously, start running the goal immediately, then keep steering via Q&A while it runs** — the goal is a live, hot-editable state, not a one-shot prompt.

**What we're building.** A TypeScript + Ink **three-pane TUI** that orchestrates two existing agent CLIs as subprocesses (we do **not** build an agent engine):

- **Planner = Claude Code** (`claude -p`, high-effort) — turns the intake into a *rigorous* plan (experiments, validation, environment setup, no shortcuts) and designs the benchmark.
- **Executor = Codex** (`codex exec`, max autonomy) — executes the plan, iterates, discovers optimization points.
- **Supervisor loop** — runs long-horizon (≈12h class), never stops on the model's whim; stops only when further optimization isn't *worth it* (diminishing-returns / cost-benefit), or a hard budget backstop trips.
- **Commit gate** — every *confirmed* positive improvement is git-committed; regressions auto-revert.
- The **chat pane** hot-injects new requirements mid-run → re-plan + steer the running executor without a restart.
- Tools **self-update** (codex/claude) between runs.

**Greenfield.** `/Users/saprk/code/WiCi-code` is empty. Local installs verified: `claude 2.1.162`, `codex-cli 0.139.0` (standalone install, built-in updater), `node v26`, `git 2.50`.

**User decisions locked:**
1. **Termination = diminishing-returns / cost-benefit**, not a hard 12h/budget cap. Keep optimizing while gains are worth the cost; stop when marginal improvement-per-cost is low. Cost caps are disabled by default during real-mode tuning.
2. **Eval scripts (`measure.sh`/`checks.sh`) are planner-designed, then user-locked** (reviewed once, `chmod -w` + SHA-256 pinned; agent can't edit thereafter).
3. **Max autonomy where it writes:** Codex executes with `codex exec --dangerously-bypass-approvals-and-sandbox`; the planner is Claude Code in `--permission-mode plan`. → **Isolation is recommended, but direct-host real mode on the primary machine is allowed** when the target repo is git-backed, WiCi records its own git commit in `checkpoint.json`, and rollback commands are documented (see Safety).
4. **Three-pane TUI from day one:** `chat` + `热goal` (live editable goal/plan) + `事实执行` (execution stream) — full vertical slice, not headless-first.

---

## 1. Architecture

```
┌──────────────────────────── INK TUI (one process) ─────────────────────────────┐
│  ┌───────────────┐   ┌───────────────────────┐   ┌──────────────────────────┐   │
│  │ CHAT          │   │ 热 GOAL               │   │ 事实执行 (EXECUTION)      │   │
│  │ intake + Q&A  │   │ GOAL.md + PLAN.md      │   │ tail events.jsonl         │   │
│  │ writes inbox/ │   │ live, diff-highlighted │   │ <Static> log + spinner    │   │
│  │ tails outbox/ │   │ version vN, metric bar │   │ + metric header           │   │
│  └───────┬───────┘   └───────────▲───────────┘   └────────────▲─────────────┘   │
└──────────┼───────────────────────┼────────────────────────────┼────────────────┘
           │ inbox/inj-*.json       │ (read-only watch)          │ (read-only tail)
           ▼ (atomic temp+rename)   │                            │
   ┌───────┴────────────────────────┴────────────────────────────┴──────────────┐
   │            SUPERVISOR  (single writer, holds flock on .wici/.lock)           │
   │  OBSERVE → STOP? → PLAN → EXECUTE → MEASURE → EVALUATE → {COMMIT|REVERT}     │
   │                         → REFLECT → (loop)                                   │
   └──┬──────────────┬───────────────┬───────────────┬───────────────┬───────────┘
   ┌──▼───┐    ┌─────▼─────┐   ┌─────▼──────┐   ┌─────▼──────┐   ┌────▼──────────┐
   │PLANNER│   │ EXECUTOR  │   │ EVALUATE   │   │ GIT GATE   │   │ STOP POLICY   │
   │claude │   │codex exec │   │measure.sh +│   │commit/tag  │   │diminishing-   │
   │ -p    │   │ [resume]  │   │checks.sh + │   │revert/reset│   │returns + LLM  │
   │       │   │           │   │stats gate  │   │            │   │worth-it verdict│
   └───────┘   └───────────┘   └────────────┘   └────────────┘   └───────────────┘
```

**Single-writer blackboard.** The Supervisor is the only mutator of control files and holds a `flock` singleton. The TUI is a **producer-only** (drops `inbox/*.json` via temp+rename) and **read-only tailer** (watches `events.jsonl`, `GOAL.md`, `PLAN.md`, `ledger.jsonl`). No lock contention with the running executor → crash-independent UI.

**Two distinct locations:**
- **Tool repo** = `/Users/saprk/code/WiCi-code` (the WiCi TUI/supervisor source).
- **Target workspace** = the codebase being optimized (passed per-run via `codex -C <target>`). Git commits happen **there**. Plan + eval scripts are committed in the target (`PLAN.md`, `.opt/`); ephemeral run state lives in `target/.wici/` (gitignored).

---

## 2. Tool-driving (exact commands)

### Planner — `claude -p --permission-mode plan`, structured artifacts, then user-locked

The planner is Claude Code running in **plan mode**. It reads `GOAL.md` and the target deeply, then returns structured planning artifacts. The supervisor materializes `PLAN.md` + `.opt/measure.sh` + `.opt/checks.sh` so they can be verified and locked:

```bash
claude -p "ULTRAPLAN for goal: $(cat GOAL.md)" \
  --output-format json \
  --json-schema schemas/plan.schema.json \
  --effort max \
  --permission-mode plan \
  --disallowedTools 'Bash(git push *)' 'Bash(rm -rf *)' \
  --append-system-prompt "$(cat prompts/planner.md)"
# capture: jq -r '.session_id' -> .wici/sessions.json ; jq '.structured_output' -> verify -> materialize/lock
```

`prompts/planner.md` rubric (the "no corner-cutting" enforcement): rigorous plan with **stable step IDs** (S1,S2,…); each step lists experiments, a validation command, and environment setup; **design `measure.sh`** (warmup-discard, ≥N reps, emit `METRIC p50=.. p95=.. p99=.. unit=<goal metric unit> n=..`; `p99` is WiCi's current primary scalar slot and goal direction controls minimize/maximize acceptance) and **`checks.sh`** (tests/typecheck/lint, separate timeout); Codex is the only writer at execution time.

**Plan diff on a new requirement** (resume same session, minimal surgical diff):

```bash
claude -p "New requirement: <text>. Current PLAN.md attached. Return MINIMAL diff, preserve step IDs." \
  --resume "$PLANNER_SID" --output-format json --json-schema schemas/plan-diff.schema.json \
  --permission-mode plan \
  --append-system-prompt "Emit {add:[{after,id,text}],modify:[{id,text}],obsolete:[ids]}. Don't rewrite completed steps."
```

- Run planner from a **fixed cwd** (the target) so cwd-scoped `--resume` is unambiguous.
- `--effort max` only on the **initial** plan and full re-plans; diffs run at default effort (cost/latency).
- After the initial plan: supervisor materializes `PLAN.md` + `.opt/*`, surfaces them in the GOAL pane for the **user lock** (review → `chmod -w` → record `eval_sha256` in `baseline.json`).

### Executor — `codex exec`, max autonomy, resume per iteration

Every iteration is a fresh resumed child → **hot-steering = just change the next prompt** (no restart, repo context retained in the codex session):

```bash
# First iteration of a step:
codex exec \
  --dangerously-bypass-approvals-and-sandbox \
  --json \
  --output-last-message .wici/artifacts/iter-N.txt \
  --output-schema schemas/iter-result.schema.json \
  -C <target_repo> --skip-git-repo-check \
  "Execute plan step S2 from PLAN.md. Write result JSON to .wici/artifacts/iter-N.json: {step_done,tests_pass,notes}." \
  | tee -a .wici/codex-run.jsonl

# Subsequent / steered iterations:
codex exec resume --last \
  --dangerously-bypass-approvals-and-sandbox --json \
  -C <target_repo> \
  "Continue with step S3. NOTE new requirement: <steer text>. Write result JSON to .wici/artifacts/iter-N.json."
```

- `--dangerously-bypass-approvals-and-sandbox` = the "yolo" requested (no `--yolo` flag exists in 0.139.0). Never blocks on approvals.
- **`resume --last` from the fixed per-run cwd** sidesteps the known gap that `codex exec --json` doesn't print a usable session id (openai/codex#3817). Do not harvest `~/.codex/sessions/` under rapid iteration.
- **Resume structured-output contract:** `codex exec resume --help` advertises `--json`/`--output-schema`/`--output-last-message` locally, and WiCi still instructs the executor to write `.wici/artifacts/iter-N.json` itself. The supervisor reads that file as the source of truth and parses `.wici/codex-run.jsonl` events (`turn.completed{usage}`, `turn.failed`, `error`, `item.completed`) for progress/cost; treat top-level `error`/`turn.failed` as stop/retry.
- Keep MCP servers `required=false` so a transient MCP failure never aborts the unattended run.

---

## 3. Supervisor state machine

```
INTAKE → PLAN → EXECUTE → MEASURE → EVALUATE → {COMMIT | REVERT} → REFLECT → (STOP? gate) → EXECUTE
                                                                              ↘ STOP / FAILED
```

`EVALUATE` edges, **strict priority order**:
1. `inbox/` non-empty → **REPLAN** (a new requirement always wins; see §7).
2. `checks.sh` failed / crash → **REVERT**.
3. `measure.sh` improved past the noise gate (§6) → **COMMIT**.
4. retryable & under budget → **EXECUTE** (same step).
5. stuck/loop or retries exhausted → **REPLAN**.
6. hard budget backstop exhausted → **FAILED**.

### Termination = diminishing-returns / cost-benefit (the user's decision)

Replace the naive "stop when `p99<=target`" with a **value-stop policy** (`supervisor/stop.ts`). The loop keeps going while optimization is *worth it*:

- Track per-commit `improvement_delta` and `cost_since_last_commit` (tokens/$ + wall-time) in the ledger.
- Compute `marginal_value = improvement_delta / cost_since_last_commit`; maintain an EWMA.
- Enter **STOP-CANDIDATE** when: (target met **or** no accepted improvement in last `N` iters) **and** EWMA(marginal_value) `< τ` over the last `K` commits.
- On STOP-CANDIDATE, run a cheap **LLM "worth-it?" verdict**: `claude -p` is given the ledger improvement curve + cumulative cost, returns `{continue|stop, reason}`. This encodes "和高质量对比性价比不高就停."
- Resolve: `stop` → **STOP** (surface verdict + curve in chat). Configurable: auto-stop, or *pause-and-ask* in the chat pane.
- **Hard backstops** (`max_iters`, optional `max_cost_usd`, `deadline`) remain and force **FAILED/STOP** regardless. `max_cost_usd=0` disables the cost hard stop and is the current default while real-mode behavior is being tuned.

Anti-thrash escape hatches: `5` consecutive reverts → forced `git reset --hard <best>`; global stall → REPLAN (bandit over optimization avenues / "try a different angle").

---

## 4. State & data model

Run dir: `target/.wici/` (gitignored) + committed `target/PLAN.md`, `target/.opt/`, `target/baseline.json`.

- **`GOAL.md`** — steerable, user-facing goal contract, formatted like a durable markdown artifact rather than a task-specific schema. The supervisor also keeps `.wici/goal.json` as internal derived state for compatibility with acceptance, stop, and checkpoint logic; `version` bumps on every applied injection.
- **`PLAN.md`** — markdown checklist, stable IDs, machine-readable trailer: `- [>] S2 Add pooling <!-- status:active iter:5 attempts:1 -->`. Markers `[ ]` pending `[>]` active `[x]` done `[!]` blocked.
- **`baseline.json`** — best-ever anchor (rollback target) + `eval_sha256` of the locked scripts. Committed.
- **`ledger.jsonl`** — append-only, one experiment/line: `id,ts,commit,hypothesis,p50,p95,p99,delta_pct,confidence,ci_low,ci_high,p_value,cost,guards,status(keep|reject|revert),reflection,parent_id`. System of record for stop-policy, stall detection, resume.
- **`events.jsonl`** — append-only UI event log (the EXECUTION pane tails this).
- **`checkpoint.json`** — atomic after every COMMIT/REPLAN: `supervisor_state,next_step,iter,goal_version,plan_hash,ledger_seq,events_seq,sessions{planner,executor},drained_inbox[]`. `drained_inbox[]` guarantees a requirement is never double-applied on resume. On resume: truncate append-logs back to checkpoint seqs.
- **`inbox/inj-*.json`** — TUI injection: `{id,ts,kind,text,priority,applied}`, `kind ∈ {add_requirement,drop_requirement,steer,abort}`.
- **`outbox/*.json`** — supervisor → chat (planner clarifying questions, stop-verdict prompts). Enables two-way intake.

Helpers: `shared/atomic.ts` (temp+rename writes), `shared/paths.ts`, `shared/types.ts`. Schemas in `schemas/` (`plan`, `plan-diff`, `iter-result`).

---

## 5. Three-pane Ink TUI

**Stack:** `ink`, `react`, `execa`, `@inkjs/ui`, `ink-spinner`, `ink-text-input`, `fullscreen-ink`, `chokidar` (file watch). Reference Ink structure: Gemini CLI / Claude Code (Codex's own UI is Rust/Ratatui — not a reference).

```tsx
// src/tui/App.tsx
<Box flexDirection="column" height={stdout.rows}>
  <Header/>                                  {/* state, metric vs target, cost, elapsed */}
  <Box flexGrow={1}>
    <Box width="28%" borderStyle="round"><ChatPane/></Box>     {/* intake + Q&A */}
    <Box width="34%" borderStyle="round"><GoalPane/></Box>     {/* 热 goal: GOAL.md + PLAN.md, diff-highlighted, vN */}
    <Box flexGrow={1} borderStyle="round"><ExecPane/></Box>    {/* 事实执行: events.jsonl tail */}
  </Box>
</Box>
```

- **Anti-flicker (the #1 Ink pitfall):** exactly **one `<Static>`** in the whole tree (finished log lines, stable `key`); only the live tail + spinner + status + input re-render. Never mutate an already-Static item.
- **Streaming:** ExecPane **tails `events.jsonl`** via chokidar (decoupled from the codex subprocess; survives supervisor crashes). Coalesce updates on ~16–50ms to avoid frame thrash.
- **Focus / non-blocking:** each pane gates `useInput` on its own `useFocus`. `Tab`/`Shift+Tab` cycle; `Esc` jumps to Chat. This is what keeps Chat responsive while EXECUTION streams.
- **Hot-reload path:** `ChatPane.onSubmit` → `atomicWrite(inbox/inj-NNNN.json)` → returns immediately. **TUI never touches `GOAL.md`/`PLAN.md`/`checkpoint.json`.** GoalPane re-renders when the supervisor updates `GOAL.md` / rewrites `PLAN.md` (diff highlight on change).
- **Fullscreen** via `withFullScreen(<App/>)`. Caveat: alt-screen kills native scrollback → implement an in-pane scroll viewport for ExecPane history.

---

## 6. Eval → commit-on-improvement gate

Two-stage, **correctness first, then performance** — a faster-but-broken candidate is never committed.

1. **`.opt/checks.sh`** (correctness backpressure): tests + typecheck + lint, separate ~300s timeout, excluded from the timed metric. Fail → REVERT.
2. **`.opt/measure.sh`** (the metric, tamper-proof): warmup-discard `K`, run workload `M`×, emit `METRIC p50=.. p95=.. p99=.. unit=<goal metric unit> n=.. warmup_discarded=..`; for non-latency goals, `p99` still carries the primary scalar that WiCi gates on, while `GOAL.md` supplies the unit and direction.

**Noise handling for a p99 goal** — accept iff **all**: (a) point delta beats `noise_threshold` (≥1% rel); (b) significance: paired **bootstrap CI of the delta excludes 0** (≥1000 resamples) **or** Mann-Whitney `p<0.05`; (c) **no guard regresses** (`error_rate`, `throughput_rps`, and `p50/p95` don't blow up — don't fix the tail by wrecking the body). ≥5 independent reps. Never gate on p100.

**Commit/revert (git as ledger):**
```bash
# confirmed improvement — self-describing commit + tag, ledger+baseline in the SAME commit:
git -C <target> add -A && git -C <target> commit -m "perf: pool db conns | p99 612->499ms (-18.6%, p=0.002) | guards ok"
git -C <target> tag "perf/p99-499ms-$(git -C <target> rev-parse --short HEAD)"
# regression / checks_failed / crash — keep-best:
git -C <target> reset --hard <best_commit_from_baseline.json>   # committed-then-rejected
git -C <target> restore --staged --worktree . && git -C <target> clean -fd   # uncommitted attempt
```

**Tamper-proofing (anti reward-hacking over 12h):** `measure.sh`/`checks.sh`/test files `chmod -w` + **SHA-256 pinned in `baseline.json.eval_sha256`**, verified at the top of every iteration (abort on mismatch). Restrict the executor's edit surface (forbid `.opt/`). Keep a **held-out validation workload** the optimizer never sees, to catch eval saturation.

---

## 7. Hot goal-reload mechanism

**Safe point = strictly between executor iterations (top of EVALUATE)** — never mid-`codex exec`.

1. Top of EVALUATE: list `inbox/*.json` minus `checkpoint.drained_inbox`.
2. Oldest-first: **atomically claim** (rename → `inbox/done/`), append `INJECTION_DRAINED` event.
3. Mutate internal goal state per `kind`, **bump `version`**, atomic write `GOAL.md` plus `.wici/goal.json`.
4. Record drained IDs in `checkpoint.drained_inbox` (idempotency).
5. Force EVALUATE → **REPLAN** (edge priority #1). Planner `--resume` emits a minimal plan diff; apply surgically to `PLAN.md` (in-flight/completed steps untouched unless obsoleted). The new requirement becomes the **next executor prompt** via `codex exec resume --last` → steered without a restart.

**Backpressure:** cap injections drained per safe point; **coalesce** same-theme `add_requirement`/`steer` so a chat flood can't starve progress. `priority:urgent` drops an `inbox/URGENT` sentinel → supervisor shortens the current step's retry budget to reach the safe point sooner. `kind:abort` (gated behind URGENT) stops the run.

---

## 8. Self-update

- **Codex (standalone install here):** use the **built-in updater** (`codex update`), **not** `npm i -g @openai/codex` (would create a divergent second binary). Gate on a version check; `codex doctor` to confirm health. **Pin before unattended runs:** record `codex --version` in `checkpoint.json`; refuse to start a long run if an update is pending; schedule updates **only between runs**.
- **Claude Code:** pre-flight `claude` reachability; pin the model **alias** (`opus` + `--fallback-model sonnet`) not a hardcoded ID that may retire; update via the standard updater between runs.
- **Never** let the optimization loop trigger a tool update mid-iteration (would invalidate behavior determinism + `eval_sha256` assumptions).

---

## 9. Safety (because autonomy is maxed)

`codex exec --dangerously-bypass-approvals-and-sandbox` removes the execution sandbox, while the planner remains in Claude Code plan mode. Compensate:
- **Recommend a disposable container/VM** (or a dedicated machine) with only the target repo mounted. **Current deployment decision:** direct-host real mode on the primary machine is acceptable when the target repo is git-backed, the WiCi checkout is pinned/recorded, and rollback commands are documented.
- Keep **reversibility** as the backbone: every change is git-committed or revertible (`thinkless rollback --target <repo> --confirm`, internally `reset --hard <best>` + `clean -fd` preserving `.wici/`); no irreversible ops.
- Record WiCi's own package version, git commit, and dirty flag in `checkpoint.json` so the orchestrator can be rolled back along with the target repo.
- **Forbidden-action list** in the planner/executor system prompts (no `git push`, no `rm -rf` outside workspace, no prod credentials); `--disallowedTools 'Bash(git push *)'` on the planner.
- Eval scripts + tests stay `chmod -w` + SHA-pinned regardless of autonomy.
- Indirect prompt-injection via `inbox`/ingested content: validate injection `kind` against an allowlist; `abort` requires the URGENT sentinel.

---

## 10. Build roadmap (first deliverable = the 3-pane vertical slice)

Internally sequenced to de-risk, but **M1 delivers the working three-pane TUI driving a real loop**.

- **M0 — Engine skeleton (headless).** `supervisor/` loop on a sample target with a known-slow function: planner writes `PLAN.md`+`.opt/*` → `codex exec` runs a step → `measure.sh` `METRIC` line → naive `>baseline` gate → commit/reset. Proves both CLIs drive headlessly with the chosen flags, JSON/result-file capture works, git gate fires.
- **M1 — Three-pane TUI over the engine (the first ask).** Wire `App.tsx` + Chat/Goal/Exec panes; ExecPane tails `events.jsonl` (single-`<Static>`), GoalPane watches `GOAL.md`+`PLAN.md`, Chat writes `inbox/`. Proves flicker-free streaming + responsive Chat during a live run + live goal view.
- **M2 — Real eval gate + ledger + tamper-proofing.** `baseline.json`+`ledger.jsonl`, ≥5 reps, bootstrap-CI/Mann-Whitney gate, guard metrics, correctness-then-perf order, `eval_sha256` lock + the **user-lock review flow** in GoalPane. Proves monotonic progress, no noise commits.
- **M3 — Durable supervisor + diminishing-returns stop.** Full state machine, `checkpoint.json`, append-log truncation, `codex exec resume --last`, the **value-stop policy + LLM worth-it verdict**, hard backstops, anti-thrash. `kill -9` mid-run → clean resume, no double-work. Proves 12h-class durability + the cost-benefit termination.
- **M4 — Hot goal-reload.** Chat `onSubmit` → inbox → drain at EVALUATE → goal `version` bump → planner `--resume` minimal diff → executor next-prompt steer; `drained_inbox[]` idempotency, coalescing/cap, URGENT/abort. Proves mid-run re-plan + steer without killing the session.
- **M5 — Full intake + self-update + diversity.** Two-way clarifying intake (`outbox/`), `--effort max` ultraplan, Reflexion-style reflections + a skill/lesson library fed back into prompts, bandit avenue selection, `codex update`/`claude` self-update gated between runs.

---

## 11. Critical files to create

- Tool entry/UI: `src/cli.tsx`, `src/tui/{App,Header,ChatPane,GoalPane,ExecPane}.tsx`, `src/tui/useRunState.ts`.
- Supervisor: `src/supervisor/{index,states,planner,executor,evaluate,ledger,gitgate,inbox,stop,checkpoint,events}.ts`.
- Shared: `src/shared/{atomic,paths,types}.ts`.
- Schemas: `schemas/{plan,plan-diff,iter-result}.schema.json`.
- Prompts: `prompts/{planner,planner-diff,stop-verdict}.md`.
- Config: `wici.config.json` (planner/executor models, default budgets, stop `τ/K/N`, autonomy flags, container hint), `package.json`, `tsconfig.json`.
- Per-target (generated/committed): `<target>/PLAN.md`, `<target>/.opt/{measure.sh,checks.sh}`, `<target>/baseline.json`, `<target>/.wici/**` (gitignored).

---

## 12. Verification (end-to-end)

1. **M0 smoke:** point at a fixture target repo with a deliberately slow function (e.g. an O(n²) hot path); goal `metric=p99 target=<X>`. Run the headless supervisor once; confirm `PLAN.md`+`.opt/*` materialize, `codex exec` edits code, `measure.sh` emits a `METRIC` line, and a `perf:` commit or `reset --hard` happens. Inspect `git -C <target> log`.
2. **M1 UI:** `npm run dev` → three panes render; type in Chat while Exec streams (no flicker, input stays responsive); GoalPane shows the plan and updates when the supervisor rewrites it.
3. **Eval integrity (M2):** edit `measure.sh` after lock → next iteration aborts on `eval_sha256` mismatch. Feed a no-op change → gate rejects (no commit). Feed a real speedup → exactly one `perf:` commit with the metric delta in the message; `ledger.jsonl` gets a `keep` row.
4. **Durability (M3):** `kill -9` the supervisor mid-iteration, restart → resumes from `checkpoint.json` with no double-commit; `drained_inbox[]` respected. Verify the loop continues past target and **stops on diminishing-returns** (watch the stop-verdict in chat), not at the 12h cap.
5. **Hot-reload (M4):** mid-run, type a new requirement in Chat → internal goal version bumps, `GOAL.md` updates, GoalPane shows the plan diff, and the very next `codex exec resume` prompt carries the steer — all without a process restart.
6. **Self-update (M5):** with a pending `codex` update, confirm the supervisor refuses to start a long run and updates only between runs (`codex update` → version bump recorded in checkpoint).

### Release tag gate: real interactive generalization canary

Every release tag (`0.x.y`, `v*`, or any tag meant for a human to try) must be created **only after** a real interactive WiCi run proves the end-to-end path on a task that was not custom-built for the current implementation. If the canary is not complete, the tag is not cut. If a tag was already cut before this evidence exists, treat that tag as unverified and cut the next patch only after the evidence is attached.

**Generalization canary shape.** Use the local TUI as the only operator surface. Start with empty Goal/Execution panes, type one natural-language Chat message, and let WiCi produce `GOAL.md`, run Claude plan mode, materialize `PLAN.md`/`.opt/*`, and drive Codex execution. The operator may answer Chat questions, but must not manually SSH, manually inspect models, manually write benchmark scripts, or manually perform deployment steps outside WiCi. Deployment, discovery, benchmarking, and remediation must be planned and executed by the agents through the target artifacts.

**Task pool, not one golden fixture.** For each tag, choose one canary from a rotating pool and record the chosen seed/task in the release notes or tag evidence:

- **Remote throughput task:** "听说 diffusionGemma 很强，在 `<ssh command>` 上试试，要求达到 `700 token/s` 以上." The SSH command may include a port forward such as `ssh -p 23276 root@116.127.115.18 -L 8080:localhost:8080`, but WiCi must decide how to discover/install/run/measure the model.
- **Unknown repo performance task:** point WiCi at a fresh, non-fixture local repository with a working test suite and ask for a measurable speedup without naming the hot path.
- **Service latency task:** point WiCi at a small service repo and ask for p95/p99 latency under a realistic load tool, with the planner selecting the benchmark.
- **Correctness-preserving CLI throughput task:** point WiCi at a CLI/data-processing repo and ask for a throughput target on a workload the planner must define and lock.

The selected task must differ from the immediately previous release's canary by domain or target, and must not be implemented as a bespoke verifier that knows the expected solution. Fixture/stub verifiers are still required, but they do not satisfy the release tag gate.

**Pass evidence required before tagging.**

- A terminal transcript or saved run log showing the interactive TUI was started and the first Chat message was the canary goal.
- Generated `GOAL.md`, `PLAN.md`, `.opt/benchmark.json`, `.opt/checks.sh`, `.opt/measure.sh`, and `baseline.json` from that run.
- `events.jsonl` evidence for `PLAN_START`, `PLAN_DONE`, execution, evaluation, and either a committed improvement or a documented stop/failure reason.
- `ledger.jsonl` with the measured metric, unit, samples/repetitions, and pass/fail against the task target.
- For remote tasks, proof that connection/deployment/benchmarking was performed by the executor's plan/scripts, not by an out-of-band manual shell.
- A clean target git status or a recorded rollback command showing how to return to the best accepted state.

**Release rule.** Run the usual automated gates first (`npm run verify:v1-slice`, `npm run verify:tui-chat-intake`, `npm run verify:demo-tui`, `npm run verify:bin`, `npm run verify:docs-sync`, `npm run typecheck`, plus any touched-area verifier). Then run the real interactive generalization canary. Only after both are complete may a tag be created and pushed.

---

## 13. Prior art & deltas (open-source learnings)

A 2025–2026 sweep of open-source agents, mined for **goal accuracy** and **long-horizon execution**. WiCi's core (metric-gated commits, accept-only-if-improved, REVERT-on-regress, done-gated-on-a-verifiable-metric, safe-point injection, checkpoint+ledger) sits squarely on the AlphaEvolve→DGM *self-improving agent* lineage and is **validated** by it. The items below are concrete mechanisms to **steal**, plus one genuine tension to resolve.

### Reference repos (verified)

| Project | URL | Steal |
|---|---|---|
| ShinkaEvolve (Sakana, ICLR'26) | https://github.com/SakanaAI/ShinkaEvolve | **public/private (model-invisible) metric split**; multi-run + hard `correct:bool` gate; "budget is TOTAL not additional" resume contract |
| Darwin Gödel Machine | https://github.com/jennyzzt/dgm | keep-if-improved + **branchable archive of stepping stones**; ablation: pure hill-climbing **plateaus** |
| Huxley-Gödel Machine | https://github.com/metauto-ai/HGM | **metaproductivity ranking + Thompson sampling** over the archive to pick the next branch |
| OpenEvolve (AlphaEvolve reimpl.) | https://github.com/algorithmicsuperintelligence/openevolve | **cascade evaluation** (cheap screen → expensive reps); `EVOLVE-BLOCK` editable-surface fences; metrics **dict** with guards |
| A-Evolve | https://github.com/A-EVO-Lab/a-evolve | validate-on-holdout → **git-tag `evo-N` on accept → git-rollback on regress** (nearest cousin to WiCi's git gate) |
| Magentic-One | https://github.com/microsoft/autogen | **dual ledger** (Task + Progress) + stall-counter → self-reflect → revise plan |
| LangGraph | https://github.com/langchain-ai/langgraph | durable checkpointer + **pending-writes idempotency**; `interrupt()`/resume at deterministic boundaries |
| OpenHands | https://github.com/All-Hands-AI/OpenHands | `send_message()`→next-`step()` drain (= hot-reload); `pause()` between steps; **`keep_first` condensation** (goal immortal) |
| mini-swe-agent / SWE-agent | https://github.com/SWE-agent/mini-swe-agent · https://github.com/SWE-agent/SWE-agent | exceptions-as-control-flow; `wall_time_limit`/`cost_limit`; **auto-submit best artifact on limit-hit** |
| Voyager | https://github.com/MineDojo/Voyager | **executable skill library** (embedding-retrieved) + automatic curriculum (→ M5) |
| Spec Kit | https://github.com/github/spec-kit | **frozen, machine-checkable acceptance criteria** + forced clarify/ambiguity pass |
| Reflexion | https://github.com/noahshinn/reflexion | **reflection-as-memory** triggered only by an external verifier |
| SWE-bench Verified | https://github.com/SWE-bench/SWE-bench | done = hidden FAIL_TO_PASS passes **and** PASS_TO_PASS stays green |
| METR task-standard / time-horizon | https://github.com/METR/task-standard · https://github.com/METR/eval-analysis-public | **unit-tested `score()`**; reliability over long chains is the real bottleneck |
| goal-drift-evals | https://github.com/RaunoArike/goal-drift-evals | drift rises with context length → **interrogate goal vs behavior** periodically |

### Goal-accuracy deltas
- **[§6, M2] Metric-surface split** (ShinkaEvolve): the held-out validation score is computed by the supervisor and **never enters any planner/executor prompt**. `chmod -w` + SHA-pin stops *tampering*; invisibility stops *gaming*. Treat lockfiles as a complement, not the whole defense.
- **[§6, M0] Scorer self-test** (METR): at startup, run a known-good and a known-bad patch through `measure.sh`/`checks.sh` and assert the verdicts before any iteration.
- **[§6, M2] Cascade pre-screen** (OpenEvolve): one cheap rep / profiler sniff kills obvious non-improvements **before** the full ≥5-reps + bootstrap-CI/Mann-Whitney battery — major compute saver on a 12h run.
- **[§4, M5] `GOAL.md` → frozen acceptance-criteria spec** (Spec Kit): machine-checkable criteria + an upfront clarify pass; the loop re-reads this artifact each iteration, not the rolling chat.
- **[§3 REFLECT, M3] Reflection-as-memory** (Reflexion): only on a *measured* REVERT, Claude writes a compact lesson fed into the next REPLAN prompt — never on Codex's self-claim.
- **[§3, M3] Periodic goal-interrogation** (goal-drift-evals): restate-and-check behavior vs `GOAL.md` on long runs; keep the goal pinned in condensation `keep_first`.

### Long-horizon deltas
- **[§3, M3] Diversity archive of stepping stones** (DGM / A-Evolve): keep accepted (+ a few rejected-but-interesting) commits tagged `perf/<metric>-<sha>`; REPLAN may **branch from any archived commit**, not only `reset --hard` to best.
- **[§3, M3 — highest-value/novel] Metaproductivity branching** (HGM): track lineage (`parent_id`) in the ledger; pick the next REPLAN branch by **descendants' downstream success**, chosen via **Thompson sampling** over avenues — not by the entry's own score.
- **[§4, M3] Idempotent durable checkpoint** (LangGraph / DBOS): pending-writes semantics via `ledger_seq`/`events_seq` truncation + a **commit idempotency key** so a `kill -9` mid-EVALUATE never double-commits.
- **[§4, M3] Lock resume contracts** (ShinkaEvolve / CodeEvolve): budget caps are **total-not-additional**; resume supports load-latest / load-iteration-N.
- **[§5/§7, M3] Context condensation with pinned goal** (OpenHands / Cline): summarize ledger/history before context overflows, goal in `keep_first`; big artifacts stay referenced by path (claim-check — already in plan).
- **[§3 budget, M3] Auto-commit best artifact on any limit-hit** (SWE-agent): never exit a long run empty-handed.
- **[M5] Executable skill library** (Voyager / LangMem): store working diffs/patches retrieved by embedding + a background dedup/consolidation pass; automatic curriculum = REPLAN generating the next sub-goal when an avenue saturates.

### The one tension to resolve
**Strict "accept-only-if-improved" is greedy and plateaus.** The population frameworks (OpenEvolve, ShinkaEvolve, CodeEvolve) deliberately avoid a hard accept-if-improved gate (MAP-Elites best-per-niche instead); DGM's ablation shows pure hill-climbing stalls. WiCi's hard git-gate is *correct for committing to a real repo*, **but must be paired with the diversity archive + metaproductivity branching above**, or long runs get stuck in local optima. This is the single place the prior art pushes back on the current design.

### Genuinely novel (no direct OSS prior art → highest design risk, validate hardest)
- **Two-CLI planner(Claude) + executor(Codex) split** — closest analog is Aider's architect/editor model-split (one tool); no one orchestrates two frontier coding CLIs as separate roles.
- **Hot-goal-reload via a durable file blackboard** drained at a safe point with idempotency keys — in-process message-queue steering exists (OpenHands/goose/Temporal Signals), but the file-based transport is unproven.
- **Diminishing-returns LLM "worth-it?" verdict as the *primary* stop** — every surveyed project uses a hard cap or a simple plateau detector; WiCi's EWMA(marginal_value) + cost-benefit verdict is more sophisticated but has no battle-tested reference.

---

## Open items (small, non-blocking)

- **Codex resume structured-output canary:** local CLI support is verified by `npm run verify:tool-commands`, and the executor's non-stub contract is covered without invoking real Codex by `npm run verify:executor-contract`: it exercises first-run/resume args, the executor-written `.wici/artifacts/iter-N.json` fallback, `--output-last-message`, steering prompt propagation, and transcript usage parsing. Next hardening is an optional real-mode canary against a disposable local fixture.
- **Benchmark tool per goal** is planner's choice inside `measure.sh` (hyperfine for whole-command, k6/wrk for service p99, pytest-benchmark/criterion in-process) — selected during planning, locked on review.
- **Stop thresholds** `τ/K/N` start as `wici.config.json` defaults; tune after M3.
- **Chat intake UX:** the two-way file path is implemented through `outbox/` and `/answer`, covered by `npm run verify:outbox`, `npm run verify:clarify`, `npm run verify:manual-lock`, and `npm run verify:ask-stop`. Remaining work is richer prompt grouping and operator ergonomics, not the transport.
