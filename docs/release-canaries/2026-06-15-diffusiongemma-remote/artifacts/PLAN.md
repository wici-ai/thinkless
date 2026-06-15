# PLAN — diffusionGemma throughput ≥ 700 token/s

Goal: On the remote GPU host reached via
`ssh -p 23276 root@116.127.115.18 -L 8080:localhost:8080`,
bring up a diffusion-Gemma LLM inference server and reach **≥ 700 token/s**
generation throughput, validated through the forwarded local port `:8080`.

Codex executes this plan directly. There is no external pre-execution gate;
all discovery, setup, measurement, and tuning are ordinary steps below.

## Environment / assumptions
- SSH key-based auth to `root@116.127.115.18:23276` is already configured
  (the user supplied the connect command). If only password auth is available,
  set it up non-interactively (e.g. `sshpass` or an added key) as part of S1;
  do not block the loop on a human.
- Remote host is assumed to be a Linux GPU box with NVIDIA drivers. Actual GPU,
  CUDA, Python, and any running service are discovered in S1–S2, not assumed.
- All benchmarking runs from the operator/Codex host against `localhost:8080`,
  which is the SSH `-L 8080:localhost:8080` forward of the remote server port.
- Shared SSH base used throughout (export once per shell):
  `export SSH_OPTS="-p 23276 -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"`
  `export RHOST="root@116.127.115.18"`

## Steps

### S1 — Establish SSH connectivity and discover the host <!-- status:active iter:2 -->
- Action: Confirm SSH works and capture the environment:
  `ssh $SSH_OPTS $RHOST 'set -x; uname -a; nvidia-smi; nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv; python3 --version; pip3 --version; which git; ss -ltnp | grep -E ":8080|:8000" || true; df -h / ; free -g'`
  Save output to `./artifacts/s1_host.txt`.
- Setup/prereqs: `SSH_OPTS`, `RHOST` exported; `artifacts/` created.
- Validation: `ssh $SSH_OPTS $RHOST 'echo OK'` prints `OK`; `nvidia-smi` shows ≥1 GPU.
- Failure signal / rollback: SSH timeout or no GPU → stop and report; no state changed (read-only).

### S2 — Discover diffusion-Gemma model and runtime
- Action: Detect whether a server is already serving on remote `:8080`
  (`ssh $SSH_OPTS $RHOST 'curl -sf localhost:8080/v1/models || curl -sf localhost:8080/health || ss -ltnp'`).
  Locate or identify a diffusion-Gemma checkpoint:
  search local caches first
  (`ssh $SSH_OPTS $RHOST 'ls -d ~/.cache/huggingface/hub/* /root/models/* 2>/dev/null; huggingface-cli scan-cache 2>/dev/null || true'`),
  then candidate diffusion-LLM / Gemma-diffusion repos and serving frameworks
  available on the box (transformers-based diffusion generation, or a vendor
  dLLM server). Record the chosen checkpoint id, framework, and launch command
  in `./artifacts/s2_model.md`.
- Setup/prereqs: S1 complete.
- Validation: `artifacts/s2_model.md` names a concrete checkpoint + runtime, OR
  `curl -sf localhost:8080/v1/models` (remote) already returns a model.
- Failure signal / rollback: no diffusion-Gemma checkpoint locatable and none
  downloadable → record the gap in `s2_model.md` and proceed to S3 with the
  best available diffusion LLM; note the substitution in the final report.

### S3 — Stand up the inference server on remote :8080
- Action: If no server is already serving on `:8080`, install runtime deps into
  an isolated venv and launch an OpenAI-compatible (or framework-native) server
  bound to `127.0.0.1:8080` on the remote, started detached
  (e.g. `nohup ... > ~/wici_server.log 2>&1 & echo $! > ~/wici_server.pid`).
  Capture the exact launch command into `./artifacts/s3_launch.sh`.
- Setup/prereqs: S2 model + runtime chosen; sufficient GPU memory (from S1).
- Validation: `ssh $SSH_OPTS $RHOST 'curl -sf localhost:8080/v1/models'` lists the
  model and a 1-token generation succeeds.
- Failure signal / rollback: server fails to bind/load → `ssh $SSH_OPTS $RHOST 'kill $(cat ~/wici_server.pid) 2>/dev/null; rm -f ~/wici_server.pid'`, inspect `~/wici_server.log`, adjust and retry. Removing the venv reverts all install state.

### S4 — Open the local port-forward tunnel
- Action: Start a background tunnel from the Codex host:
  `ssh -fN $SSH_OPTS -L 8080:localhost:8080 $RHOST`
  (record the resulting PID for teardown).
- Setup/prereqs: S3 server healthy.
- Validation: `curl -sf http://localhost:8080/v1/models` (local) returns the model.
- Failure signal / rollback: tunnel dies / port busy → kill stale `ssh -fN` PID, free local `:8080`, restart tunnel.

### S5 — Initial measurement (baseline)
- Action: Run `bash .opt/checks.sh` then `bash .opt/measure.sh`. Record the
  baseline `METRIC` line and the resolved server config into
  `./artifacts/s5_baseline.txt`.
- Setup/prereqs: S4 tunnel up; `.opt/checks.sh` and `.opt/measure.sh` present.
- Validation: `measure.sh` exits 0 and emits a `METRIC value=... unit=token/s` line.
- Failure signal / rollback: non-zero exit or no METRIC line → revisit S3/S4.

### S6 — Optimize to ≥ 700 token/s
- Action: Iteratively tune and re-run `.opt/measure.sh` after each change.
  Diffusion-LLM throughput levers, in rough priority order:
  - decoding/denoising config: number of diffusion steps, block/segment length,
    parallel-token decode width, remasking/confidence threshold;
  - precision: bf16/fp16, and 8-bit/4-bit weight quant if supported;
  - server/runtime: `MAX_TOKENS`, batch size, KV-cache / attention backend
    (e.g. flash-attn), `torch.compile`/CUDA graphs if available;
  - throughput mode: if R1's 700 token/s is interpreted as aggregate server
    throughput, raise `CONCURRENCY` in `measure.sh` and tune server batch size;
    if interpreted as single-stream decode speed, keep `CONCURRENCY=1` and tune
    denoising steps/parallel decode. Report both numbers in the final summary so
    the user-facing claim is unambiguous.
  Log each trial (config → token/s) to `./artifacts/s6_trials.csv`.
- Setup/prereqs: S5 baseline captured.
- Validation: `.opt/measure.sh` reports `value >= 700`.
- Failure signal / rollback: if a config regresses or fails to load, revert to
  the last good launch command in `artifacts/s3_launch.sh` and continue; if 700
  is unreachable on this hardware, record the best achieved value, the binding
  bottleneck (GPU compute/mem-bandwidth from `nvidia-smi dmon`), and report.

### S7 — Finalize, persist, commit
- Action: Pin the winning server launch command, model id, and decode config
  into `artifacts/final_config.md`; capture the final `METRIC` line into
  `artifacts/final_metric.txt`. Stop is optional (leave server running for the
  user). Commit confirmed progress on the current branch.
- Setup/prereqs: S6 target met (or best-effort recorded).
- Validation: `git log -1` shows the commit; `final_metric.txt` contains the
  passing/last `METRIC` line.
- Failure signal / rollback: `git revert` the commit; teardown =
  `ssh $SSH_OPTS $RHOST 'kill $(cat ~/wici_server.pid) 2>/dev/null'` and kill the
  local `ssh -fN` tunnel PID.

## Validation
- tool: .opt/measure.sh (curl against the OpenAI-compatible endpoint over the forwarded port)
- command: `bash .opt/checks.sh && bash .opt/measure.sh`
- metric: generation throughput
- direction: maximize
- target: 700
- unit: token/s
- reason: Diffusion LLMs are promoted for fast decoding; token/s of completion
  generation over the served model is the direct expression of R1's "700 token/s
  以上" requirement. Measuring through the user's own `-L 8080:localhost:8080`
  forward validates exactly the path the user described.

## Benchmark knobs (env vars for .opt/measure.sh)
- `ENDPOINT` (default `http://localhost:8080`)
- `MODEL` (auto-detected from `/v1/models` if empty)
- `N` measured requests (default 10), `WARMUP` discarded (default 2)
- `MAX_TOKENS` (default 256), `PROMPT` (default long-essay prompt)
- `CONCURRENCY` (default 1 = single-stream decode tps; >1 = aggregate throughput)
