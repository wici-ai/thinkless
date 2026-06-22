# WiCi V1 Completion Audit

Date: 2026-06-15
Scope: `Simplified_PLAN.md` V1 path.

This audit records what is currently proven, what is covered by automated checks, and why release tagging is still blocked.

## Product Boundary

| Requirement | Evidence | Status |
| --- | --- | --- |
| Local TUI: bottom Chat input plus a switchable Chat History / Goal/Plan / Execution workspace | `npm run verify:tui-structure`, `npm run verify:demo-tui`, `npm run verify:tui-live` | Covered |
| Chat is the first intake for a blank run, but first input is not automatically an initial goal | `npm run verify:tui-chat-intake` reports `blank_chat_routes_through_agent`, `degraded_inspection_does_not_start_planner`, and `degraded_plan_request_starts_planner` | Covered |
| Real pseudo-terminal Chat input can submit the first blank-run goal and start execution | `npm run verify:tui-chat-pty` report `pty_chat_first` and `goal_source: tui_chat` | Covered |
| Chat-first TUI can drive the real-mode planner/executor subprocess path without using stub execution | `npm run verify:tui-real-fake-chat` report `pty_chat_first_real_mode_fake_clis`, Codex planner invocation, and `EXECUTE_PROGRESS` evidence | Covered |
| TUI exposes per-workspace Chat / PLAN / EXECUTION agent and effort selection, with model fixed by agent | `npm run verify:tui-structure`; `npm run verify:tool-commands` | Covered |
| Real pseudo-terminal Chat input can answer planner clarification questions and resume the planner session | `npm run verify:tui-planner-clarification-pty` report `pty_planner_clarification`, `question_answered`, and `planner_session` | Covered |
| Chat pane restores current goal, user steering, and planner answers from the blackboard without repeating the initial goal in transcript history | `npm run verify:tui-structure`, `npm run verify:v1-requirements` | Covered |
| TUI does not directly write supervisor-owned GOAL/PLAN/checkpoint/ledger/event files; only ChatPane writes inbox injections | `npm run verify:tui-structure` report `chat_writes_only_inbox`, `goal_and_exec_read_only`, and static file-write API checks | Covered |
| Blank Chat History / Goal/Plan / Execution workspace does not create run files before Chat | `npm run verify:tui-chat-intake`, `npm run verify:demo-tui` | Covered |
| Initial goal provenance is not written retroactively on an existing run | `npm run verify:tui-chat-intake` report `goal_source_not_retroactive` | Covered |
| A historical `baseline.json` alone does not block fresh Chat-first intake | `npm run verify:tui-chat-intake` report `historical_baseline_does_not_block_chat`; `npm run verify:v1-requirements` | Covered |
| Supervisor is a blackboard/orchestration layer, not a semantic task engine | `npm run verify:v1-requirements`, `npm run verify:goal-metric`, `npm run verify:curriculum` | Covered |
| No task categories, hardcoded avenues, or supervisor metric parser | `npm run verify:goal-metric`, `npm run verify:curriculum`, `npm run verify:v1-requirements` | Covered |
| Internal planner-selected metric placeholder is not presented as a user target | `npm run verify:tui-structure`, `npm run verify:goal-interrogation`, `npm run verify:v1-requirements` | Covered |
| Default real runs have no WiCi cost or iteration hard cap | `npm run verify:tool-commands` report `default_iteration_budget_unbounded`; `npm run verify:v1-requirements`; `wici.config.json` | Covered |
| macOS installs bootstrap host dependencies, including GitHub CLI, and supports a one-line public release installer without committing secrets | `npm run verify:install-bootstrap`; README macOS Bootstrap section; `scripts/install.sh` | Covered |

## Planner

| Requirement | Evidence | Status |
| --- | --- | --- |
| Claude Code plan mode is the planner | `npm run verify:tool-commands` | Covered |
| Planner uses native tool availability; no WiCi allowlist/denylist | `npm run verify:tool-commands` | Covered |
| Planner prompt permits native planning-time web research and remote discovery while leaving execution outcomes to Codex | `npm run verify:tool-commands`, `npm run verify:v1-requirements` | Covered |
| Planner output is markdown artifacts, not JSON-as-plan | `npm run verify:tool-commands`, `npm run verify:v1-requirements` | Covered |
| Planner self-interrogates 2-3 approaches, records `ASSUMPTIONS.md`, and asks `## QUESTION` only for essential unresolvable unknowns | `npm run verify:self-interrogation` report `assumptions_materialized` and `question_gate_narrowed` | Covered |
| Planner diff treats user steering as an assumption override and maintains `ASSUMPTIONS.md` when assumptions change | `npm run verify:self-interrogation` report `planner_diff_maintains_assumptions` | Covered |
| Planner `PLAN.md` prose is not parsed into a supervisor benchmark schema | `npm run verify:tool-commands` report `no_markdown_benchmark_inference`, `npm run verify:v1-requirements` | Covered |
| Fresh V1 planner prompt does not force `.opt/measure.sh` to emit a WiCi metric schema | `npm run verify:v1-requirements` | Covered |
| `PLAN.md` exists before Codex starts | `npm run verify:v1-slice`, `npm run verify:planner-clarification` | Covered |
| Planner clarification routes through Chat and resumes the same Claude session | `npm run verify:planner-clarification`, `npm run verify:tui-structure` | Covered |
| Planner clarification during hot-reload PLAN diff routes through Chat and resumes the same Claude session | `npm run verify:planner-clarification` report `plan_diff_question` and `plan_diff_resumed_session` | Covered |
| Initial planner token usage is visible as `PLAN_USAGE` | `npm run verify:tool-commands` report `initial_plan_usage_streamed`; `npm run verify:tag-gate` evidence bundle; `npm run verify:v1-requirements` | Covered |
| Hot-reload planner diff token usage is visible as `PLAN_USAGE` | `npm run verify:tool-commands`, `npm run verify:v1-requirements` | Covered |
| Planner/executor token usage is visible in the Execution pane | `npm run verify:tui-structure`, `npm run verify:v1-requirements` | Covered |
| Planner transcript is saved for real canaries | `npm run verify:tag-gate`, evidence bundle `.wici/artifacts/planner-initial.stdout.jsonl` | Covered |

## Executor

| Requirement | Evidence | Status |
| --- | --- | --- |
| Codex receives current `GOAL.md` and `PLAN.md` | `npm run verify:executor-contract`, `npm run verify:v1-requirements` | Covered |
| Codex receives `GOAL.md + PLAN.md` as one goal; step IDs are only thin receipt/progress focus | `npm run verify:v1-slice`, `npm run verify:executor-contract`, `npm run verify:v1-requirements` | Covered |
| Codex execution reaches the live TUI stream | `npm run verify:tui-live` reports `goal_source: tui_goal_option` for the automation shortcut; `npm run verify:executor-contract`; `npm run verify:tag-gate` evidence bundle | Covered |
| `PLAN.md` can execute without planner-generated `.opt` scripts | `npm run verify:direct-no-scripts`; README states no-script plans still execute directly | Covered |
| Planner-generated scripts are persisted executable and runnable when present | `npm run verify:v1-slice` asserts `.opt/checks.sh` and `.opt/measure.sh` are executable, then runs both | Covered |
| Optional planner scripts and historical `baseline.json` files are not a supervisor baseline gate in fresh V1 | `npm run verify:v1-requirements`, `npm run verify:docs-sync`, `Simplified_PLAN.md`; no `.opt` scripts are required to start Codex | Covered |
| Legacy optimizer behavior remains isolated from fresh V1 and is checked through an explicit aggregate | `npm run verify:legacy-optimizer`; README legacy optimizer section | Covered |
| Codex transcript is saved for real canaries | `npm run verify:tag-gate`, evidence bundle `.wici/codex-run.jsonl` | Covered |
| Codex token usage is captured | `npm run verify:codex-run-usage`, `npm run verify:executor-contract`, `npm run verify:app-server-hotreload` | Covered |
| Chat, planner, and executor agent/effort can be selected while models stay fixed to claude-opus-4-8 or gpt-5.5 | `npm run verify:tool-commands` | Covered |
| `codex exec resume` avoids unsupported `-C` | `npm run verify:executor-contract`, `npm run verify:tool-commands` | Covered |
| Existing `GOAL.md` / `PLAN.md` can continue without passing a new `--goal` | `npm run verify:existing-goal` report `continued_without_new_goal` and `reused_goal_run_id` | Covered |
| Exhausted direct plans pass through a continue-biased completion gate before planner continuation | `npm run verify:direct-plan-continuation`; `npm run verify:continuation-verdict` reports `explicit_complete_stops`, `explicit_continue_continues`, and `ambiguous_falls_back_to_continue` | Covered |
| Executor failures and timeouts are recoverable long-goal events, not immediate whole-goal blockers | `npm run verify:direct-recovery` report `recoverable_failure`, `ledger_rows: 2`, and `resumed_executor`; code emits `EXECUTE_RECOVERABLE_FAILURE` and continues with `codex exec resume --last` | Covered |
| Codex may diagnose failures, update `PLAN.md` / `.opt`, and continue the same goal | `npm run verify:direct-recovery` asserts the recovery prompt includes previous failure context and authorizes PLAN updates; `npm run verify:executor-contract` covers resume command shape | Covered |

## Hot Reload And Durability

| Requirement | Evidence | Status |
| --- | --- | --- |
| Later Chat input updates the goal without restarting the TUI | `npm run verify:hotreload`, `npm run verify:tui-chat-intake` | Covered |
| Preferred hot reload steers an active Codex app-server turn without restarting execution | `npm run verify:app-server-hotreload` reports `app_server_steer`, records `EXECUTE_STEERED`, and verifies app-server received `turn/steer` | Covered |
| Legacy `codex exec` fallback can preempt an active direct Codex run at the next executor output/heartbeat | `npm run verify:direct-preempt` report `preempted_active_executor`, `EXECUTE_PREEMPTED`, and resumed executor evidence | Covered |
| Real pseudo-terminal follow-up Chat input hot-reloads GOAL/PLAN before the next Codex iteration | `npm run verify:tui-hotreload-pty` report `pty_hot_reload`, `goal_version: 2`, and `ledger_rows: 2` | Covered |
| Hot reload preserves Codex execution continuity instead of starting a fresh executor context | `npm run verify:app-server-hotreload` covers active-turn steering; `npm run verify:hotreload-resume` and `npm run verify:executor-contract` cover legacy resume fallback | Covered |
| Hot-reload steering is persisted into `GOAL.md`, not only passed as a transient prompt note | `npm run verify:hotreload` report `goal_doc_contains_steering`; `npm run verify:v1-requirements` | Covered |
| Safe-point inbox draining is idempotent through `drained_inbox[]` | `npm run verify:hotreload` | Covered |
| `checkpoint.json`, `events.jsonl`, and `ledger.jsonl` support direct V1 crash recovery and resume | `npm run verify:v1-slice`, `npm run verify:direct-recovery`, `npm run verify:durability` report `direct_recovered`, `npm run verify:setup-state` | Covered |
| `/resume` in the TUI opens a selectable recovery page instead of blindly continuing the displayed run | `npm run verify:tui-resume-selector-pty` types `/resume` in a real PTY, shows runnable/blocked candidates, selects `.thinkless2`, and verifies new supervisor events in that selected session. `npm run verify:tui-resume-selector-built` repeats the selector flow through the built CLI entrypoint, verifies full-context preflight metadata, proves up/down movement, Enter launch, Escape cancellation, and refuses blocked candidates without `RESUME_CONTEXT_VALIDATED`, `SUPERVISOR_START`, or `EXECUTOR_RESUME_FALLBACK` side effects. `npm run verify:tui-resume-current-candidate` opens `/resume` against a runnable current `.thinkless` session plus decoy and proves selector display alone does not append preflight or launch events. `npm run verify:tui-resume-interrupted-blocked` proves packaged selector Enter refuses checkpointed-but-unrecoverable interrupted planner/executor candidates without launching or mutating runnable decoys. | Covered |
| Resume candidates preserve full run context and distinguish runnable from read-only blocked states | `npm run verify:resume-selector` covers current, numbered `.thinklessN`, legacy `.wici`, chat/runtime presence, GOAL/PLAN/checkpoint/ledger/events, and planner/executor session metadata. `npm run verify:tui-resume-current-candidate` explicitly selects the current `.thinkless` candidate and verifies `RESUME_CONTEXT_VALIDATED` plus `SUPERVISOR_START` append only to that selected current session while Chat transcript/runtime selection, GOAL.md, PLAN.md, ledger, checkpoint, planner session, executor session, and executor app thread metadata are preserved. `npm run verify:tui-resume-legacy-candidate` drives the built CLI selector through runnable and blocked legacy `.wici` candidates, proving accepted legacy candidates emit `RESUME_CONTEXT_VALIDATED` and `SUPERVISOR_START` only in the selected legacy event log while blocked legacy candidates do not launch or mutate runnable decoys. `npm run verify:tui-resume-cross-target` selects a historical workspace run and verifies `RESUME_CONTEXT_VALIDATED` plus `SUPERVISOR_START` are appended only to the selected target/session while Chat transcript/runtime selection, GOAL.md, PLAN.md, ledger, checkpoint, planner session, executor session, and executor app thread metadata are preserved. | Covered |
| Interrupted planner/executor resume is preflighted before launch | `npm run verify:resume-rerunnable` covers `RESUME_CONTEXT_BLOCKED`, `RESUME_CONTEXT_VALIDATED`, and `EXECUTOR_RESUME_FALLBACK` so blocked planner states and executor rerun fallback are visible. `npm run verify:tui-resume-interrupted-blocked` covers the built TUI selector negative path for a pending planner clarification without a persisted planner session and an executor interruption without replayable state. | Covered |
| Packaged `/resume` acceptance is included in the V1 aggregate gate | `npm run verify:v1-core` includes `verify:tui-resume-selector-built`, `verify:tui-resume-legacy-candidate`, `verify:tui-resume-current-candidate`, and `verify:tui-resume-cross-target` alongside the source selector and runnable-preflight resume checks | Covered |
| Existing goals can be continued or rewound from documented commands | README Resume Or Re-Run section; `npm run verify:durability`, `npm run verify:resume-iteration`, `npm run verify:docs-sync` | Covered |
| Git checkpoint and rollback path exists | `npm run verify:rollback`, README rollback section | Covered |
| TUI exposes the current rollback/version point instead of hiding it in logs | `npm run verify:tui-structure` checks Header `rollbackSummary` renders `rollback pending` before a checkpoint and a short rollback commit when available | Covered |

## Release Gate

| Requirement | Evidence | Status |
| --- | --- | --- |
| README documents clean checkout, build, core verification, and Chat-first real-mode canary launch | `npm run verify:docs-sync`, README Deployment section | Covered |
| Release preflight binds automated V1 core verification to the real canary tag gate | `npm run release:preflight` script is `npm run verify:v1-core && npm run verify:tag-gate`; `npm run verify:v1-requirements`, `npm run verify:docs-sync` | Covered |
| Release tags are created only through a guarded command that runs preflight first and never pushes | `npm run release:tag -- <version>` script; `src/release/tag.ts`; `npm run verify:release-tag`, `npm run verify:v1-requirements`, `npm run verify:docs-sync` | Covered |
| Every release tag requires a real TUI canary | `npm run verify:tag-gate`, README Tag Gate section | Covered |
| Passed release canaries must be recorded from real tool mode, not stub fixtures | `npm run verify:tag-gate` report `canary_tool_mode`; `npm run verify:canary-evidence` reports `recorder_rejects_stub_mode_passed_canary` and `tag_gate_rejects_stub_mode_passed_canary` | Covered |
| Passed release canaries must prove the run started from first Chat, not CLI `--goal` | `npm run verify:tag-gate` report `canary_goal_source`; `npm run verify:canary-evidence` reports `recorder_rejects_non_tui_passed_canary` and `tag_gate_rejects_non_tui_passed_canary` | Covered |
| Failed tag gate explicitly says not to tag or push | `npm run verify:tag-gate` report `release_action: blocked_do_not_tag_or_push` | Covered |
| Release tag evidence must match the current clean WiCi checkout | `npm run verify:tag-gate` report `release_version`; README Tag Gate section | Covered |
| Passed release canaries must leave the target checkout clean | `npm run verify:tag-gate` report `canary_target_git_dirty`; `npm run verify:canary-evidence` reports `target_clean_recorded`, `recorder_rejects_dirty_target_passed_canary`, and `tag_gate_rejects_passed_dirty_target` | Covered |
| Release tag evidence must include committed artifact files matching recorded hashes | `npm run verify:tag-gate` report `artifact_files_verified`; README Tag Gate section | Covered |
| Release tag evidence must preserve executable planner shell artifacts | `npm run verify:tag-gate` report `optional_planner_scripts_executable`; `npm run verify:canary-evidence` | Covered |
| Release tag evidence must include explicit operator/Codex attestation fields, not just markdown prose | `npm run verify:tag-gate` report `codex_ssh_attempt_attested`; `npm run verify:canary-evidence` | Covered |
| Release tag evidence must prove Codex attempted SSH from the copied Codex transcript, not only from attestation fields | `npm run verify:tag-gate` report `codex_transcript_has_ssh_attempt` | Covered |
| Shared SSH transcript evidence requires the Codex SSH attempt to match the expected canary target | `npm run verify:ssh-evidence` | Covered |
| Release tag gate supports non-SSH canary shapes instead of forcing the current remote throughput task | `npm run verify:canary-evidence` report `tag_gate_handles_non_ssh_canary` | Covered |
| Release recorder rejects `--codex-attempted-ssh true` unless the source Codex transcript contains SSH evidence | `npm run verify:canary-evidence` report `recorder_rejects_unsupported_ssh_attestation` | Covered |
| Release recorder rejects SSH attestation when the transcript SSH target does not match the canary target | `npm run verify:canary-evidence` report `recorder_rejects_wrong_ssh_target` | Covered |
| Release recorder rejects contradictory status evidence before writing canary files | `npm run verify:canary-evidence` report `cli_rejects_contradictory_status` | Covered |
| Release recorder rejects passed evidence that was not Chat-first from an empty TUI or used operator manual execution | `npm run verify:canary-evidence` report `cli_rejects_invalid_passed_attestation` | Covered |
| Release recorder rejects invalid target metadata before writing canary files | `npm run verify:canary-evidence` report `cli_rejects_invalid_target_metadata` | Covered |
| Passed release canaries must include observed value evidence that reaches the target | `npm run verify:canary-evidence` report `cli_rejects_invalid_passed_observed_value`; `npm run verify:tag-gate` report `target_value`, `observed_value`, and `passed_observed_target` | Covered |
| Release recorder rejects source artifacts containing provider tokens or private keys before copying evidence | `npm run verify:canary-evidence` report `recorder_rejects_source_secrets` | Covered |
| Release artifacts and repo files do not contain committed provider tokens or private keys | `npm run verify:no-secrets`; `npm run verify:tag-gate` report `secret_scan_ok` | Covered |
| Release canary evidence can be recorded without hand-writing artifact hashes | `npm run verify:canary-evidence`, `npm run release:record-canary` | Covered |
| Current failed diffusionGemma canary carries operator Chat-first attestation and Codex SSH/deploy/measure transcript evidence, but predates checkpoint `goal_source` provenance | `docs/release-canaries/2026-06-15-diffusiongemma-remote.md`, evidence bundle | Covered |
| Failed canary records explicit blocker and next action | `npm run verify:tag-gate`, evidence bundle `result.failure_reason` and `result.next_required_action` | Covered |
| Current canary reaches 700 token/s | `npm run verify:tag-gate` | Blocked |

Current blocker: the latest recorded release canary has verified artifacts, hashes, executable planner shell artifacts, transcript references, token usage, rollback/version fields, explicit operator Chat-first attestation, and explicit Codex SSH attestation, but it is still `status: failed` and `tag_allowed: false` because Codex reached the SSH step and the remote rejected available public keys with `Permission denied (publickey)`. A later unrecorded retry reached remote execution on `root@116.127.115.18:23276`, but Codex spent the run trying to build vLLM from source and never launched the model server or produced a 700 token/s measurement. The historical failed canary predates checkpoint `goal_source` provenance and was recorded from a dirty WiCi checkout, so it cannot authorize a release. Next required action: rerun the same first Chat through the TUI from a clean WiCi checkout with the long-goal recovery behavior enabled, let Codex continue through deployment and measurement, then replace the failed canary with a passed one so `npm run verify:tag-gate` reports `canary_goal_source: tui_chat`, `status: passed`, and observed throughput meeting the recorded target. Do not tag or push a release until a new real TUI canary passes and `npm run verify:tag-gate` exits zero.

## Last Verified Commands

These checks were run successfully on 2026-06-15:

```bash
npm run typecheck
npm run verify:tool-commands
npm run verify:hotreload
npm run verify:hotreload-resume
npm run verify:tui-chat-intake
npm run verify:tui-resume-selector-built
npm run verify:tui-resume-cross-target
npm run verify:tui-real-fake-chat
npm run verify:demo-tui
npm run verify:tui-live
npm run verify:durability
npm run verify:resume-iteration
npm run verify:goal-doc
npm run verify:direct-no-scripts
npm run verify:direct-recovery
npm run verify:direct-plan-continuation
npm run verify:self-interrogation
npm run verify:continuation-verdict
npm run verify:existing-goal
npm run verify:v1-requirements
npm run verify:docs-sync
npm run verify:canary-evidence
npm run verify:release-tag
npm run verify:no-secrets
npm run verify:v1-core
npm run verify:legacy-optimizer
```

This check was run and intentionally failed because the latest real canary is failed:

```bash
npm run verify:tag-gate
```
