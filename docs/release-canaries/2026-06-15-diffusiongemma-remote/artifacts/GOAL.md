# GOAL

Version: v1
Run: run-1781461224354

## Requirements
- [active] R1: 听说diffusionGemma很快，在ssh -p 23276 root@116.127.115.18 -L 8080:localhost:8080试试，要求达到700 token/s以上

## Validation (planner-chosen)
- metric: generation throughput
- unit: token/s
- direction: maximize
- target: 700
- method: Benchmark the diffusion-Gemma inference server over the forwarded port (localhost:8080) using `.opt/measure.sh`; requirement R1 is met when reported `value >= 700` token/s.
- note: "diffusionGemma" is treated as a diffusion-based LLM in the Gemma family (e.g. a Gemma-derived diffusion / dLLM checkpoint). The exact checkpoint and runtime are discovered on the remote host in PLAN.md step S2 rather than hard-coded, since the headline appeal of diffusion LLMs is high single-stream decode speed.

## Constraints
- Keep GOAL.md and PLAN.md as the source of truth.
- Commit confirmed progress and keep rollback available.
- No git push, no production credentials, no destructive removal outside the workspace.

## Notes
- This markdown goal is the user-facing contract for the run.
- WiCi keeps .wici/goal.json only as internal derived state for durable execution.
- Deployment, SSH, model discovery, benchmark setup, and validation belong in PLAN.md and optional .opt scripts, then Codex executes them inside the loop.
