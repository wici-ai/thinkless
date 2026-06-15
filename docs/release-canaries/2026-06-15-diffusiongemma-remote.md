# Release Canary: 2026-06-15-diffusiongemma-remote

status: failed
tag_allowed: false
target: fixture/real-canary-v1
evidence_bundle: docs/release-canaries/2026-06-15-diffusiongemma-remote/evidence.json
first_chat: 听说diffusionGemma很快，在ssh -p 23276 root@116.127.115.18 -L 8080:localhost:8080试试，要求达到700 token/s以上
failure_reason: Codex reached the SSH step, but the remote rejected available public keys. The 700 token/s measurement could not run.
next_required_action: Provide working SSH credentials or install an accepted public key for root@116.127.115.18:23276, then rerun the same first Chat through the TUI and replace this failed canary with a passed one before tagging.

## Evidence

- Started real local TUI from an empty Goal/Execution state.
- First Chat message triggered `GOAL.md` creation and Claude Code plan mode.
- Planner emitted `PLAN_USAGE` events.
- Codex execution emitted `EXECUTE_PROGRESS` with token usage.
- Codex attempted the SSH connection itself when the plan required SSH.
- No manual SSH, deployment, model setup, or measurement was performed outside WiCi.

## Result

The canary did not reach the requested target. The current release must not be tagged or pushed as verified.

Failure reason: Codex reached the SSH step, but the remote rejected available public keys. The 700 token/s measurement could not run.

Next required action: Provide working SSH credentials or install an accepted public key for root@116.127.115.18:23276, then rerun the same first Chat through the TUI and replace this failed canary with a passed one before tagging.

## Artifacts

Committed evidence bundle: `docs/release-canaries/2026-06-15-diffusiongemma-remote/evidence.json`

Committed artifact files: `docs/release-canaries/2026-06-15-diffusiongemma-remote/artifacts/`

- `GOAL.md`
- `PLAN.md`
- `.wici/events.jsonl`
- `ledger.jsonl`
- `.wici/codex-run.jsonl`
- `.wici/artifacts/planner-initial.stdout.jsonl`
- optional planner artifacts under `.opt/` when present
