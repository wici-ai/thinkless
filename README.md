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

## Contributing

Keep changes scoped, run the relevant verifier, and include the command output in the pull request. For release-facing changes, run:

```bash
npm run release:preflight
```

Do not commit provider credentials, copied auth files, private SSH keys, or release canary artifacts that contain secrets.
