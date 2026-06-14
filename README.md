# WiCi

WiCi is a TypeScript + Ink three-pane TUI that supervises long-running coding optimization loops over a separate target repository.

The supervisor drives:

- planner: `claude -p` in real mode;
- executor: `codex exec` in real mode;
- acceptance gate: frozen `acceptance.spec.json` derived from `goal.json` before planning;
- eval gate: locked `.opt/checks.sh` before optional `.opt/prescreen.sh`, full `.opt/measure.sh`, and optional hidden `.opt/validate.sh`;
- git gate: commit confirmed improvements and revert rejected attempts;
- hot goal reload: TUI chat writes `.wici/inbox/inj-*.json`, drained between iterations;
- run memory: condensed context in `.wici/context.md` plus periodic goal checks in `.wici/goal-interrogations.jsonl`;
- skill library: accepted patches are stored under `.wici/skills/` and retrieved into later prompts by `.wici/skills.json`;
- automatic curriculum: stuck replans append focused sub-goals to `.wici/curriculum.jsonl`;
- diversity archive: accepted stepping stones are archived in `.wici/archive.json`, and stuck replans may branch from archived commits;
- limit artifact: `wici-limit-artifact.md` is committed when hard limits or `max_iters` stop the run.

## Safety

Real mode uses `codex exec --dangerously-bypass-approvals-and-sandbox` and `claude --dangerously-skip-permissions`. The supported deployment is a disposable container or VM with only the target repo mounted.

## Commands

```bash
npm install
npm run typecheck
npm run build
npm run smoke
npm run verify:durability
npm run verify:commit-idempotency
npm run verify:hotreload
npm run verify:inbox-backpressure
npm run verify:tamper
npm run verify:stuck
npm run verify:real-mode
npm run verify:outbox
npm run verify:tool-version
npm run verify:ask-stop
npm run verify:tool-commands
npm run verify:codex-run-usage
npm run verify:clarify
npm run verify:claude-probe
npm run verify:manual-lock
npm run verify:benchmark-manifest
npm run verify:metaproductivity
npm run verify:heldout
npm run verify:scorer-selftest
npm run verify:prescreen
npm run verify:lessons
npm run verify:curriculum
```

Open the TUI over the fixture target:

```bash
npm run sample
npm run dev
```

Run headlessly over a target:

```bash
npx tsx src/cli.tsx run --target /path/to/target --goal "Reduce p99 latency while preserving correctness"
```

Check tool availability or update between runs:

```bash
npx tsx src/cli.tsx doctor
npx tsx src/cli.tsx doctor --deep
npx tsx src/cli.tsx doctor --update
```

`doctor --deep` performs a Claude print-mode auth probe. Real runs use the same deep check and refuse to start if Claude is not logged in or if a pending Codex update is detected for a long run.

Use `--mode stub`, `--mode auto`, or `--mode real` on `run`/`tui`.

WiCi freezes machine-checkable `goal.json.acceptance_criteria` into `acceptance.spec.json` before planning. If the criteria are missing or incomplete, the supervisor writes an `acceptance-spec` clarification question to `outbox/` and stops before materializing `PLAN.md`.

Use `--resume-iteration N` on `run`/`tui` to load `.wici/checkpoints/iter-N.json`, reset the target to that snapshot commit, restore pinned run memory, and truncate `ledger.jsonl`/`events.jsonl` back to the snapshot sequence. `--max-iters` remains a total cap, so `--resume-iteration 3 --max-iters 5` runs at most iterations 4 and 5.

Use `--lock-mode manual` to stop after `PLAN.md`, `.opt/benchmark.json`, and `.opt/*.sh` are generated. Review them, then answer the `lock-eval` question in the TUI with `/answer lock-eval approved`; the next run initializes and pins `baseline.json`.
