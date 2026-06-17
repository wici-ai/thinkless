# Develop Plan - Chat-Driven Planning And Runtime Selection

This section records the next feature slice being implemented before the older handoff backlog below.

## Goals For This Slice

1. Treat the first Chat turn as ordinary conversation, not automatically as the initial goal.
   - A user may ask the Chat agent to read the current codebase, explain state, compare options, or ask clarifying questions before any planner run should start.
   - The Chat agent starts planning only by emitting an explicit update when the user asks for a plan or when the agent judges the requirement is concrete enough.
   - The TUI should then create the initial WiCi goal from that Chat-agent update and launch the planner.
   - Pure conversation such as self-introduction, status questions, or "read the repo first / do not plan yet" must remain Chat-only in degraded fallback paths when the Chat agent is unavailable.
   - Bounded read-only inspection, including user-provided SSH commands for code reading, should stay in Chat when it can be completed quickly.
   - Small self-contained local edits can stay in Chat; larger implementation/debug/deploy/benchmark loops should become planner/executor work.
   - When planning does start, the planner must receive the preceding Chat context, not only the final update text.

2. Let the user choose runtime settings for the three TUI workspaces.
   - Chat workspace: conversational agent and effort.
   - PLAN workspace: planner agent and effort.
   - EXECUTION workspace: executor agent and effort.
   - Agent choices are exactly `claude` and `codex`.
   - Model is not user-selectable: `claude` always maps to `opus4.8`, and `codex` always maps to `gpt-5.5`.
   - Effort choices depend on the selected agent: Claude/opus4.8 uses `high`, `xhigh`, `max`, `ultracode`; Codex/gpt-5.5 uses `fast`, `medium`, `high`, `xhigh`.
   - Defaults preserve the intended behavior: Chat/PLAN use `claude` + `high`, execution uses `codex` + `medium`.

## Design Decisions

- Remove the TUI's blank-run shortcut that sends the first text input straight to `runSupervisor(... goal ...)`.
- Keep slash commands as explicit control commands, but ordinary Chat input always goes through `runChatTurn`.
- Add a `writeUpdate` option to Chat turns:
  - existing runs write Chat-agent updates to the inbox, preserving hot reload behavior;
  - blank runs return the update to the TUI without writing an inbox item, so the TUI can launch the initial goal exactly once.
- Keep the Chat agent responsible for deciding when conversation has become actionable; avoid adding prompt-specific trigger hacks for one-off examples.
- Raise the Chat agent's UPDATE threshold at the source prompt. Do not add a local post-filter that suppresses real Chat-agent UPDATE decisions.
- Keep Chat context in the agent's own persisted session. Switching effort must not rebuild the conversation by replaying `.wici/chat.jsonl`.
- Store Chat session identifiers by agent so `claude` and `codex` Chat sessions do not overwrite each other.
- Run Chat agents in lightweight direct-work mode with Chat-level permissions: no forced Claude plan mode, Claude Chat skips tool permission prompts, and Codex Chat gets network-capable sandboxing so bounded SSH/code-reading requests are possible.
- Before launching the blank-run planner, build a bounded transcript from prior Chat turns plus the triggering turn, and store it in the initial `GOAL.md` constraints as `Chat context before planning`.
- Keep degraded/stub Chat deterministic:
  - questions and "read/inspect first" messages stay conversational;
  - clear build/fix/plan/execute requests emit a requirement update.
- Guard blank-run planner launch locally only for degraded/catch fallback paths; real Chat-agent updates are trusted as the agent's decision.
- Add runtime override types and merge them into `WiCiConfig` at run start.
- Add a visible TUI runtime selector for the active workspace:
  - `Ctrl+R` opens/closes the selector.
  - left/right chooses `agent` or `effort`.
  - up/down cycles preset values.
  - Enter/Escape closes the selector and resumes bottom Chat input.
- Keep typed Chat commands for the same runtime controls:
  - `/agent <chat|plan|execution> <claude|codex>`
  - `/effort <chat|plan|execution> <default|high|xhigh|max|ultracode|fast|medium>`
  - `/model ...` is accepted only as a no-op status response explaining that model is fixed by agent.
- Render the active workspace's current agent, fixed model, and effort in the top tabbed area at all times.
- Pass Chat settings into `runChatTurn`; pass PLAN/EXECUTION settings into `runSupervisor`.
- For Codex execution, map effort to the Codex config override `model_reasoning_effort` via `-c`.
- For Claude-backed panes, pass `--model opus4.8` and selected `--effort`.
- For Codex-backed panes, pass `--model gpt-5.5` and selected effort through Codex config.

## Acceptance Checks

- Fresh TUI with no Chat input still writes no goal, plan, checkpoint, or events.
- Fresh TUI Chat "please read the current repo first" does not start the supervisor in degraded/stub mode.
- Fresh TUI Chat "introduce yourself" stays conversational and does not start the supervisor.
- Fresh TUI Chat with a bounded code-reading SSH request stays Chat-first instead of automatically becoming a planner goal.
- Chat verifier proves this is handled by the Chat prompt/source threshold, not by a local UPDATE suppression filter.
- Fresh TUI Chat "plan/fix/build..." starts the planner from a Chat-agent update and records `goal_source: tui_chat`.
- Fresh TUI Chat that starts planner writes the recent Chat transcript into `GOAL.md` as context for the planner while keeping the requirement text equal to the Chat-agent update.
- Existing-run Chat updates still flow through inbox and planner diff.
- TUI structure verification proves the bottom input no longer has first-message goal bypass logic.
- Runtime agent/effort values are visible and selectable in the TUI; fixed models are derived from the selected agent and passed into Chat, Planner, and Executor command builders.
- Changing Chat effort keeps context by resuming the same Chat agent session rather than replaying the transcript.
- Existing typecheck and core TUI verifiers pass.

# Develop Plan - Handoff And Resume Improvements

This file records follow-up architecture work discussed during the TUI / Chat / planner / executor debugging session. The current product direction still follows `Simplified_PLAN.md`; this document is a backlog for improving handoff fidelity and runtime behavior.

## Current Behavior

- Chat input is persisted into WiCi inbox and drained by the supervisor.
- Active executor hot reload can use Codex app-server `turn/steer` when an app-server turn is still running.
- If the run is stopped, a new Chat requirement currently goes through planner diff first. Execution starts only if the planner produces a pending `PLAN.md` step.
- Planner diff uses a fresh `claude -p ...` process with `--resume <planner-session-id>`, plus explicit current `GOAL.md` and `PLAN.md` content in the prompt.
- Executor resume uses either:
  - app-server `thread/resume` / `turn/steer`, which preserves more thread context, or
  - `codex exec resume --last`, which preserves Codex session history but still starts a new process.
- `.wici/context.md` is a condensed public history, not a precise execution handoff state.

## Problems Observed

1. Stopped-run Chat execution is not a direct executor resume.
   - Example: user asks Chat to re-run one token-rate probe after `STOP`.
   - Current flow: Chat -> inbox -> planner diff -> maybe new pending step -> executor.
   - The execution pane can show no Codex output while planner diff is running, which looks broken.

2. "Hot reload" currently means different things in different states.
   - Active executor: real hot reload via `EXECUTE_STEERED`.
   - Stopped run: planner-mediated replan and later execution.
   - The UI should expose this distinction instead of implying both are equally hot.

3. Planner diff has context, but not true hot memory.
   - `claude --resume` helps, but the reliable context is still the explicit `GOAL.md` / `PLAN.md` prompt and files on disk.
   - For large plans, inlining the full plan causes latency and encourages broad rewrites.
   - Small steering deltas should not require the planner to reprocess the entire plan.

4. Executor resume is conservative and re-reads too much.
   - Resume prompt explicitly tells Codex to re-read `GOAL.md` and `PLAN.md`.
   - This avoids stale execution, but makes Codex appear to restart from scratch.
   - Current condensed context does not capture enough concrete execution state to let Codex continue narrowly.

5. Execution facts are not captured in a structured handoff artifact.
   - Important facts are spread across `events.jsonl`, ledger rows, Codex transcript, `.wici/artifacts/*`, `PLAN.md`, and ad hoc report files.
   - A resumed executor may need to inspect many files to reconstruct:
     - latest verified metric,
     - remote service state,
     - run-owned containers/processes,
     - which artifacts are authoritative,
     - which command/config was last successful,
     - what is safe to skip.

6. Remote process ownership is not explicit enough.
   - During debugging, `:8080` was sometimes not vLLM but an unrelated `python3 -m http.server`.
   - A foreign `fastllm` process appeared and had to be preserved.
   - Run-owned vLLM containers/processes should be identifiable and releasable without guessing.

7. UI handoff visibility is too weak.
   - During planner diff, the user may see no executor output and not know that the system is in `PLAN`.
   - The UI should show whether the system is:
     - answering Chat only,
     - applying planner diff,
     - steering active executor,
     - waiting for a new pending step,
     - executing,
     - stopped with no pending step.

## Target Architecture

### 1. Add A Structured Executor Handoff

Create `.wici/executor-state.json` and optionally `.wici/executor-state.md` after every `EXECUTE_DONE`, failed attempt, interruption, and remote cleanup.

Suggested fields:

```json
{
  "run_id": "...",
  "goal_version": 4,
  "iter": 2,
  "step_id": "S10",
  "status": "done",
  "last_successful_config": {
    "model": "nvidia/diffusiongemma-26B-A4B-it-NVFP4",
    "server_command_artifact": ".opt/start_server.sh",
    "port": 8080
  },
  "verified_facts": [
    "official bench committed throughput: 791.05 tok/s",
    "long request decode rate: 1597.5 tok/s",
    "quality sample: PASS"
  ],
  "remote_state": {
    "run_owned_services_released": true,
    "run_owned_containers": [],
    "run_owned_pids": [],
    "foreign_gpu_processes_seen": ["fastllm"]
  },
  "authoritative_artifacts": [
    ".wici/artifacts/diffusiongemma-report.md",
    ".wici/artifacts/diffusiongemma-nvfp4-longsentence.md"
  ],
  "next_recommended_action": null
}
```

Executor resume prompts should read this first and only inspect referenced artifacts unless there is an inconsistency.

### 2. Distinguish Active Steer From Stopped-Run Resume

Define explicit execution modes:

- `active_turn_steer`: app-server turn is running; apply `turn/steer`.
- `stopped_run_delta`: run is stopped, but Chat asks for a bounded execution delta.
- `planner_diff`: Chat changes the goal or plan semantics and planner must update `PLAN.md`.
- `chat_only`: user is asking for status/explanation, no execution mutation.

The UI and events should label these modes directly.

### 3. Add Direct Delta Execution After STOP

When a stopped run receives a bounded operational request such as "measure token rate again" or "rerun the last validation", WiCi should be able to create a small pending execution step without full planner diff.

Proposed behavior:

1. Read `.wici/executor-state.json`.
2. Classify Chat input as a bounded execution delta.
3. Append or reopen a pending step such as:

   ```markdown
   - [ ] S10b Re-run guarded long-request token-rate probe
   ```

4. Start executor immediately with:
   - current `GOAL.md`,
   - current `PLAN.md`,
   - executor handoff,
   - the new delta text,
   - strict instruction to avoid broad re-audit unless facts conflict.

Planner diff remains available for semantic changes, missing plan structure, or ambiguous requests.

### 4. Compact Planner Diff Context

Planner diff should avoid inlining full `PLAN.md` for small deltas.

Preferred prompt inputs:

- new requirement / steering delta,
- `GOAL.md` summary and active requirements,
- current pending/completed step index,
- relevant `PLAN.md` section excerpts,
- `.wici/executor-state.json` summary,
- paths to full files if deeper inspection is needed.

Acceptance target:

- small Chat delta should produce a minimal plan patch or direct execution decision without reprocessing the whole plan.

### 5. Make Executor Resume Narrower

Current resume prompt says to re-read `GOAL.md` and `PLAN.md`. Keep that safety instruction, but change the order:

1. Read `.wici/executor-state.json`.
2. Read the specific artifacts listed there.
3. Read only relevant `PLAN.md` sections.
4. Re-read full `GOAL.md` / `PLAN.md` only if the handoff is missing, stale, or contradictory.

This preserves correctness while reducing "start from scratch" behavior.

### 6. Track Remote Run Ownership

When Codex starts remote services, it should record run-owned resources in a durable file such as `.wici/remote-resources.json`.

Suggested fields:

```json
{
  "host": "root@111.237.107.89:57990",
  "resources": [
    {
      "kind": "docker",
      "name": "diffusiongemma-run-1781621629534",
      "ports": [8080],
      "started_at": "...",
      "released_at": "..."
    }
  ],
  "foreign_resources_seen": [
    {
      "kind": "process",
      "name": "fastllm",
      "action": "preserved"
    }
  ]
}
```

Cleanup should only target run-owned names/PIDs/containers unless the user explicitly asks otherwise.

### 7. Improve UI Observability

The TUI should show:

- current supervisor state (`PLAN`, `EXECUTE`, `STOP`, etc.),
- whether Chat input was classified as `chat_only`, `planner_diff`, `active_turn_steer`, or `stopped_run_delta`,
- last applied injection id,
- active planner/executor process summary,
- why execution output may be empty,
- whether a stopped run has pending executable work.

This prevents "I typed in Chat and nothing happened" confusion.

## Implementation Sketch

1. Add handoff writers.
   - Emit `.wici/executor-state.json` from `EXECUTE_DONE`, executor failure, interruption, and cleanup points.
   - Include compact markdown summary for human inspection.

2. Add Chat intent classification.
   - Keep this conservative.
   - Classify only obvious bounded reruns as `stopped_run_delta`.
   - Everything else remains planner diff or chat-only.

3. Add stopped-run delta execution path.
   - If run is `STOP` and Chat asks for a bounded execution delta, create/reopen a pending step and start executor.
   - Emit a clear event such as `STOPPED_RUN_DELTA_CREATED`.

4. Refine planner diff prompt.
   - Prefer summaries and relevant excerpts.
   - Keep full-file paths available.
   - Add tests proving small deltas do not require full plan rewrite.

5. Refine executor resume prompt.
   - Make `.wici/executor-state.json` the first handoff source.
   - Only fall back to full GOAL/PLAN scan when needed.

6. Add remote resource registry.
   - Record run-owned remote containers/processes/ports.
   - Update `.opt/gpu_release.sh` and related scripts to use names from the registry when possible.

7. Improve TUI state labels.
   - Surface planner diff progress separately from executor progress.
   - Show "waiting for planner diff" instead of leaving execution pane blank.

## Verification Ideas

- `verify:stopped-run-delta`: after `STOP`, send "rerun token-rate probe"; expect a pending delta step and `EXECUTE_START` without broad planner rewrite.
- `verify:executor-handoff`: ensure resume prompt includes executor-state first and references artifacts by path.
- `verify:planner-diff-compact`: small Chat steering should not inline the full `PLAN.md` into planner prompt.
- `verify:app-server-active-steer`: active app-server turn receives `turn/steer`, not `codex exec resume`.
- `verify:remote-resource-registry`: cleanup kills only run-owned vLLM resources and preserves foreign GPU processes.
- `verify:tui-state-labels`: UI shows planner diff / active steer / stopped delta states distinctly.

## Non-Goals

- Do not make WiCi infer domain-specific benchmark semantics in the supervisor.
- Do not replace `GOAL.md` and `PLAN.md` as source of truth.
- Do not make cleanup kill arbitrary remote GPU processes.
- Do not depend on model memory as the only state carrier; durable files remain authoritative.
