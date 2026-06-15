#!/usr/bin/env bash
# Health/readiness checks for the diffusion-Gemma endpoint reached via the
# SSH -L 8080:localhost:8080 forward. Exits non-zero if the server is not ready.
set -euo pipefail

ENDPOINT="${ENDPOINT:-http://localhost:8080}"

echo "[checks] endpoint=${ENDPOINT}"

# 1) Models listing must respond.
if ! MODELS_JSON="$(curl -sf --max-time 20 "${ENDPOINT}/v1/models")"; then
  echo "[checks] FAIL: ${ENDPOINT}/v1/models not reachable (is the tunnel + server up?)" >&2
  exit 1
fi
echo "[checks] /v1/models OK"

# 2) Resolve a model id.
MODEL="${MODEL:-}"
if [ -z "${MODEL}" ]; then
  MODEL="$(printf '%s' "${MODELS_JSON}" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["data"][0]["id"])' 2>/dev/null || true)"
fi
if [ -z "${MODEL}" ]; then
  echo "[checks] FAIL: could not resolve a model id from /v1/models" >&2
  exit 1
fi
echo "[checks] model=${MODEL}"

# 3) A minimal generation must succeed (try completions, fall back to chat).
gen_ok() {
  curl -sf --max-time 60 "${ENDPOINT}/v1/completions" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"${MODEL}\",\"prompt\":\"Hello\",\"max_tokens\":8,\"temperature\":0}" \
    >/dev/null 2>&1 && return 0
  curl -sf --max-time 60 "${ENDPOINT}/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}],\"max_tokens\":8,\"temperature\":0}" \
    >/dev/null 2>&1 && return 0
  return 1
}

if ! gen_ok; then
  echo "[checks] FAIL: minimal generation request did not succeed" >&2
  exit 1
fi

echo "[checks] generation OK — endpoint ready"
exit 0
