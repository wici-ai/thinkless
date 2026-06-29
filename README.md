# Thinkless

Thinkless is a local terminal app for AI software work. You describe the outcome in chat; Thinkless writes durable `GOAL.md`, `ASSUMPTIONS.md`, and `PLAN.md` artifacts, lets Claude Code plan, and lets Codex execute against a real repository.

## Install

```bash
curl -fsSL https://wici.ai/thinkless/install.sh | bash
thinkless
```

On Windows:

```powershell
irm https://wici.ai/thinkless/install.ps1 | iex
thinkless
```

Then follow the Codex, Claude, and GitHub CLI auth prompts and verify the setup:

```bash
thinkless doctor --deep
```

## Why

- Chat captures intent in normal language.
- `GOAL.md` preserves the human-readable target.
- `ASSUMPTIONS.md` records planner reasoning and risks.
- `PLAN.md` becomes the executable working plan.
- Codex executes, validates, recovers from failures, and continues.
- Follow-up chat updates the same run instead of rewriting the original prompt.

Submitted chat is append-only: clarify next turn, keep the history auditable, and let the plan improve from evidence.

## Usage

Start in the current git repository:

```bash
thinkless
```

Resume an existing run:

```bash
thinkless resume
```

If a saved session is missing `GOAL.md`, `PLAN.md`, or persisted planner/executor state, Thinkless opens the Chat transcript instead of blocking.

Run headlessly over a target:

```bash
npx tsx src/cli.tsx run \
  --target /path/to/repo \
  --goal "Build the requested app and verify it runs locally"
```

TUI controls:

- `Ctrl+R` selects agent and effort for the active pane.
- `Ctrl+O` toggles terminal pointer mode between text selection and app scrolling.
- `/resume` opens the in-TUI resume selector.
- `/dictate` inserts text from the configured local dictation command.

## Safety

Real mode runs Claude Code and Codex with broad local permissions. Use a disposable VM/container for untrusted targets, or a clean git repository on a primary machine.

## Development

```bash
git clone git@github.com:wici-ai/thinkless.git
cd thinkless
npm install
npm run build
npm run verify:v1-core
```

## macOS Bootstrap

The public release installers are:

```bash
curl -fsSL https://github.com/wici-ai/thinkless/releases/latest/download/install.sh | bash
```

```powershell
irm https://github.com/wici-ai/thinkless/releases/latest/download/install.ps1 | iex
```

On macOS, `npm install` runs `scripts/postinstall.mjs` as a postinstall bootstrap; use `THINKLESS_BOOTSTRAP=0 npm install` to opt out. For a fresh Mac with no `npm` yet, run `scripts/bootstrap-macos.sh` from a source checkout.

On Windows, `install.ps1` uses `winget` for Node.js LTS, Git, and GitHub CLI, installs Codex and Claude through npm, adds npm global commands to user PATH, and prints auth setup commands. Set `THINKLESS_WINDOWS_INSTALL_DEPS=0` to skip dependency installation.

The bootstrap waits for Apple Command Line Tools, installs missing host commands, may update `~/.zprofile` and `~/.zshrc`, and exposes `node`, `npm`, `thinkless`, `codex`, `claude`, and `gh` from clean zsh login and interactive shells. It prints `export PATH=... && thinkless` for the current terminal.

Auth onboarding uses `/dev/tty`, prints an auth onboarding status, can start `codex login` and `gh auth login`, and can report that auth is pending. Use it to authenticate Codex, Claude, and GitHub CLI; set `THINKLESS_AUTH_ONBOARDING=0` to skip prompts. For isolated installs, `THINKLESS_CONFIG_BUNDLE` can copy `~/.codex/config.toml`, `~/.codex/auth.json`, `~/.claude/settings.json`, and `~/.claude/.credentials.json`; keep them out of the repository. Real-mode health expects Codex, Claude, and GitHub CLI commands.

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

The top Chat History / Goal/Plan / Execution workspace starts empty. A blank run does not invent a goal, metric, plan, baseline, or fake execution status before the first concrete Chat request.

The absence of `.opt` scripts is a valid fresh V1 path: no-script plans still execute directly from `PLAN.md`; planner scripts are optional validation artifacts.

For real runs, the default `max_iters` is `0`; this is used to disable WiCi's own cost and iteration hard stops. Thinkless automatically checks for Codex/Claude updates at run boundaries, but pending updates are not a WiCi supervisor start gate.

Planner clarification answers sent through Chat wake the stopped supervisor and resume the same Claude planner session; Chat answer resume wakes the stopped supervisor and resumes the same Claude planner session. Direct V1 crash recovery can revert unconfirmed direct-path work, resets the active `PLAN.md` step for replay, and records recoverable crash ledger rows; Codex is allowed to inspect logs and remote state, update `PLAN.md`, and continue the same `GOAL.md`.

## Resume Or Re-Run

Run `thinkless resume` to continue the current target without a new `--goal`. Inside the TUI, `/resume` opens the resume selector, `/pause` stops the active executor at a recoverable boundary, and `/replan` asks the planner to review bottlenecks, repair `GOAL.md`/`PLAN.md`, and choose the next concrete step. Use `--resume-iteration 1` when you need to rewind to an earlier direct execution iteration for recovery testing or controlled replay.

Hot reload steers active app-server turns through `turn/steer`; otherwise Thinkless keeps continuity through `codex exec resume --last`.

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

Every release tag must pass the automated V1 core preflight. Use `npm run release:tag -- <version>` so Thinkless runs `npm run release:preflight` before creating an annotated local tag. The guarded tag command never pushes commits or tags.

## Contributing

Keep changes scoped, run the relevant verifier, and include the command output in the pull request. For release-facing changes, run:

```bash
npm run release:preflight
```

Do not commit provider credentials, copied auth files, private SSH keys, or generated artifacts that contain secrets.
