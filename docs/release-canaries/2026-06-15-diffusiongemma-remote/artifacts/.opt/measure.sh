#!/usr/bin/env bash
set -euo pipefail
```bash
#!/usr/bin/env bash
# Measure generation throughput (token/s) of the diffusion-Gemma endpoint over
# the forwarded port. Emits a single METRIC line for WiCi.
#
#   CONCURRENCY=1  -> value = median single-stream decode tokens/s
#   CONCURRENCY>1  -> value = aggregate throughput = total_tokens / wall_time
set -euo pipefail

ENDPOINT="${ENDPOINT:-http://localhost:8080}"
MODEL="${MODEL:-}"
N="${N:-10}"
WARMUP="${WARMUP:-2}"
MAX_TOKENS="${MAX_TOKENS:-256}"
CONCURRENCY="${CONCURRENCY:-1}"
PROMPT="${PROMPT:-Write a detailed, well-structured essay about the history, present state, and likely future of artificial intelligence. Cover key milestones, current capabilities, and open research problems.}"

if [ -z "${MODEL}" ]; then
  MODEL="$(curl -sf --max-time 20 "${ENDPOINT}/v1/models" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["data"][0]["id"])' 2>/dev/null || true)"
fi
if [ -z "${MODEL}" ]; then
  echo "measure: could not resolve MODEL from ${ENDPOINT}/v1/models" >&2
  exit 1
fi

export ENDPOINT MODEL N WARMUP MAX_TOKENS CONCURRENCY PROMPT

python3 - <<'PY'
import os, json, time, urllib.request, statistics, concurrent.futures as cf

ENDPOINT    = os.environ["ENDPOINT"].rstrip("/")
MODEL       = os.environ["MODEL"]
N           = int(os.environ["N"])
WARMUP      = int(os.environ["WARMUP"])
MAX_TOKENS  = int(os.environ["MAX_TOKENS"])
CONCURRENCY = max(1, int(os.environ["CONCURRENCY"]))
PROMPT      = os.environ["PROMPT"]

COMPLETIONS = ENDPOINT + "/v1/completions"
CHAT        = ENDPOINT + "/v1/chat/completions"

def _post(url, payload, timeout=300):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

# Decide endpoint shape once.
def make_call():
    comp_payload = {"model": MODEL, "prompt": PROMPT, "max_tokens": MAX_TOKENS, "temperature": 0}
    chat_payload = {"model": MODEL, "messages": [{"role": "user", "content": PROMPT}],
                    "max_tokens": MAX_TOKENS, "temperature": 0}
    try:
        _post(COMPLETIONS, {**comp_payload, "max_tokens": 1})
        mode = "completions"
    except Exception:
        _post(CHAT, {**chat_payload, "max_tokens": 1})
        mode = "chat"

    def call():
        t0 = time.perf_counter()
        if mode == "completions":
            resp = _post(COMPLETIONS, comp_payload)
        else:
            resp = _post(CHAT, chat_payload)
        dt = time.perf_counter() - t0
        toks = None
        usage = resp.get("usage") or {}
        if isinstance(usage, dict) and usage.get("completion_tokens"):
            toks = int(usage["completion_tokens"])
        if toks is None:
            # Fallback: rough whitespace token count of the text.
            ch = resp.get("choices", [{}])[0]
            txt = ch.get("text") or (ch.get("message") or {}).get("content") or ""
            toks = max(1, len(txt.split()))
        return toks, dt
    return call

call = make_call()

# Warmup (discarded).
for _ in range(WARMUP):
    try:
        call()
    except Exception as e:
        print(f"measure: warmup request failed: {e}", file=__import__('sys').stderr)

# Timed measurement.
results = []  # (tokens, dt)
wall0 = time.perf_counter()
if CONCURRENCY == 1:
    for _ in range(N):
        results.append(call())
else:
    with cf.ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        futs = [ex.submit(call) for _ in range(N)]
        for f in cf.as_completed(futs):
            results.append(f.result())
wall = time.perf_counter() - wall0

per_req_tps = [t / d for (t, d) in results if d > 0]
total_tokens = sum(t for (t, _) in results)

if CONCURRENCY == 1:
    value = statistics.median(per_req_tps)
else:
    value = total_tokens / wall if wall > 0 else 0.0

def pct(xs, p):
    xs = sorted(xs)
    if not xs:
        return 0.0
    k = (len(xs) - 1) * (p / 100.0)
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)

p50 = pct(per_req_tps, 50)
p95 = pct(per_req_tps, 95)
p99 = pct(per_req_tps, 99)
samples = ",".join(f"{x:.2f}" for x in per_req_tps)

print(f"measure: model={MODEL} concurrency={CONCURRENCY} n={N} warmup={WARMUP} "
      f"max_tokens={MAX_TOKENS} total_tokens={total_tokens} wall={wall:.3f}s")
print(f"METRIC value={value:.2f} unit=token/s n={len(per_req_tps)} warmup_discarded={WARMUP} "
      f"p50={p50:.2f} p95={p95:.2f} p99={p99:.2f} samples={samples}")
PY
```

Notes on the plan:
- **Single source of decision for "700 token/s":** I default to single-stream median decode tps (`CONCURRENCY=1`), which is the natural reading of a diffusion-LLM speed claim, but S6 also has Codex report aggregate throughput so the final claim is unambiguous.
- **Model discovery is a step, not an assumption:** "diffusionGemma" is resolved on the remote box in S2 rather than hard-coded, with a documented fallback if no exact Gemma-diffusion checkpoint exists.
- **Everything routes through the user's own forward** (`localhost:8080`), so validation tests exactly the path described in R1.
- Rollback for every mutating step (server launch, tunnel, commit) is explicit; no `git push`, no destructive removal outside the workspace.
