# Thinkless

Thinkless is a local terminal app for AI software work. It keeps the human in a simple chat loop while Claude Code plans and Codex executes against a real repository.

The idea is literal: think less at the keyboard, reason better in the system. You describe the outcome in normal language; Thinkless turns that intent into durable markdown artifacts, runs the implementation loop, and lets later messages steer the same goal instead of starting over.

## Install

```bash
curl -fsSL https://wici.ai/thinkless/install.sh | bash
thinkless
```

Then follow the Codex, Claude, and GitHub CLI auth prompts and verify the setup:

```bash
thinkless doctor --deep
```

## Why

AI coding often makes users do control work that should belong to the tool: polishing prompts, deciding every recovery command, remembering which path failed, and adding meta-instructions like "search the docs" or "debug if it breaks".

Thinkless separates the modes:

- Chat captures intent in normal language.
- `GOAL.md` preserves the human-readable target.
- `ASSUMPTIONS.md` records planner reasoning and risks.
- `PLAN.md` becomes the executable working plan.
- Codex executes, validates, recovers from failures, and continues.
- Follow-up chat updates the same run instead of rewriting the original prompt.

Submitted chat is treated like speech: after a turn is sent, you clarify by sending the next turn. The history stays auditable, and the plan improves from evidence rather than pretending the first prompt was perfect.

## Example

```text
You: Build a local dashboard for support triage and make sure it runs.
Thinkless: writes GOAL.md, ASSUMPTIONS.md, and PLAN.md, then Codex builds and validates it.

You: Also make the mobile view dense enough for triage.
Thinkless: updates the live goal and plan, then steers the active execution.
```

For bounded questions or small repo tasks, Chat can answer directly. Longer app builds, deployments, benchmark loops, and iterative debugging become planner/executor work.

## Usage

Start in the current git repository:

```bash
thinkless
```

Resume an existing run:

```bash
thinkless resume
```

If a saved session is missing `GOAL.md`, `PLAN.md`, or persisted planner/executor state, Thinkless opens the Chat transcript instead of blocking; the next concrete request can start a new planner/execution path from that restored conversation.

Run headlessly over a target:

```bash
npx tsx src/cli.tsx run \
  --target /path/to/repo \
  --goal "Build the requested app and verify it runs locally"
```

Useful TUI controls:

- `Ctrl+R` selects agent and effort for the active pane.
- `Ctrl+O` toggles terminal pointer mode between text selection and app scrolling.
- `/resume` opens the in-TUI resume selector.
- `/dictate` inserts text from the configured local dictation command.

## Safety

Real mode can run Claude Code and Codex with broad local permissions. Use a disposable VM/container for untrusted targets, or a clean git repository when running on a primary machine. Thinkless records checkpoints and rollback metadata, but it is still executing real tools against real files.

## Development

```bash
git clone git@github.com:wici-ai/thinkless.git
cd thinkless
npm install
npm run build
npm run verify:v1-core
```

For a faster local loop:

```bash
npm run typecheck
npm run verify:docs-sync
npm run dev
```

## Documentation

- [Install page](docs/index.md)
- [Full reference](docs/reference.md)
- [V1 completion audit](docs/v1-completion-audit.md)

## V1 Operational Notes

The TUI top Chat History / Goal/Plan / Execution workspace starts empty. A blank run does not invent a goal, metric, plan, baseline, or fake execution status before the first concrete Chat request.

The absence of `.opt` scripts is a valid fresh V1 path: no-script plans still execute directly from `PLAN.md`. Planner-provided scripts are optional validation artifacts, and no-script plans still execute directly when the plan itself carries the validation steps.

For real runs, the default `max_iters` is `0`; this is used to disable WiCi's own cost and iteration hard stops so the goal is governed by `GOAL.md`, `PLAN.md`, user steering, and tool/runtime limits. Thinkless automatically checks for Codex/Claude updates at run boundaries, but pending updates are not a WiCi supervisor start gate.

Planner clarification answers sent through Chat wake the stopped supervisor and resume the same Claude planner session. Chat answer resume wakes the stopped supervisor and resumes the same Claude planner session. Direct V1 crash recovery can revert unconfirmed direct-path work, resets the active `PLAN.md` step for replay, records recoverable crash ledger rows, and lets Codex inspect logs and remote state. For long-goal executor recovery, Codex is allowed to inspect logs and remote state, update `PLAN.md`, and continue the same `GOAL.md`.

## Resume Or Re-Run

Run `thinkless resume` to continue the current target without a new `--goal`. Inside the TUI, `/resume` opens the resume selector, `/pause` stops the active executor at a recoverable boundary, and `/replan` asks the planner to review bottlenecks, repair `GOAL.md`/`PLAN.md`, and choose the next concrete step. Use `--resume-iteration 1` when you need to rewind to an earlier direct execution iteration for recovery testing or controlled replay.

Hot reload can steer an active app-server turn through `turn/steer`; if that path is unavailable, Thinkless keeps Codex continuity through `codex exec resume --last`.

Release and resume verification commands:

```bash
npm run verify:resume-selector
npm run verify:tui-resume-selector-pty
npm run verify:tui-resume-selector-built
npm run verify:tui-resume-legacy-candidate
npm run verify:tui-resume-current-candidate
npm run verify:tui-resume-interrupted-blocked
npm run verify:tui-resume-interrupted-runnable
npm run verify:tui-resume-command-isolation
npm run verify:tui-resume-planner-context
npm run verify:tui-resume-empty-selector
npm run verify:tui-resume-many-candidates
npm run verify:tui-resume-stale-candidate
npm run verify:tui-resume-stale-agent-state
npm run verify:tui-resume-blocked-then-runnable
npm run verify:tui-resume-cross-target
npm run verify:resume-rerunnable
```

## Release Gate

Every release tag must pass a real TUI canary. Keep that first Chat as the real user request only, without meta instructions that tell the agent how to debug or research. A non-zero result is expected while the latest canary is still failed; the guarded tag command should block until canary evidence is clean.

## Contributing

Keep changes scoped, run the relevant verifier, and include the command output in the pull request. For release-facing changes, run:

```bash
npm run release:preflight
```

Do not commit provider credentials, copied auth files, private SSH keys, or release canary artifacts that contain secrets.
