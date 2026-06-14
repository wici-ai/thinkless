import { decideImprovement, ledgerFromEvaluation, mannWhitneyPValue } from '../supervisor/evaluate.js';
import type { CandidateEvaluation, CommandOutcome } from '../supervisor/evaluate.js';
import type { GoalFile, MetricStats, WiCiConfig } from '../shared/types.js';

const goal: GoalFile = {
  run_id: 'verify-mann-whitney',
  version: 1,
  requirements: [{ id: 'req-1', text: 'Improve p99 latency', source: 'initial', status: 'active' }],
  acceptance_criteria: [{ id: 'acc-1', text: 'metric gate passes', check: 'npm run verify:mann-whitney' }],
  constraints: [],
  metric: { name: 'p99 latency', direction: 'minimize', unit: 'ms' },
  budget: { max_iters: 1, max_cost_usd: 0, deadline: null },
  stop: { tau: 0.01, K: 1, N: 1, mode: 'auto' }
};

const config: WiCiConfig = {
  tools: {
    mode: 'stub',
    planner: { command: 'claude', effort: 'low' },
    executor: { command: 'codex', dangerouslyBypassApprovalsAndSandbox: false }
  },
  budget: { max_iters: 1, max_cost_usd: 0, deadline: null },
  stop: { tau: 0.01, K: 1, N: 1, mode: 'auto' },
  retry: { max_attempts_per_step: 1, reverts_before_reset: 1, stall_replan_after: 1 },
  diversity: { avenues: [] },
  evaluation: {
    noise_threshold: 0.01,
    min_reps: 5,
    bootstrap_resamples: 0,
    checks_timeout_ms: 1_000,
    measure_timeout_ms: 1_000,
    lock_mode: 'auto'
  },
  git: { init_if_missing: true, user_name: 'WiCi Verify', user_email: 'verify@example.invalid' },
  safety: { container_hint: 'verify', forbidden_actions: [] }
};

async function main(): Promise<void> {
  const separatedP = mannWhitneyPValue([100, 101, 102, 103, 104], [70, 71, 72, 73, 74]);
  assert(separatedP < 0.05, `expected separated samples to be significant, got p=${separatedP}`);

  const tiedP = mannWhitneyPValue([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]);
  assert(tiedP > 0.95, `expected identical samples to be non-significant, got p=${tiedP}`);

  const baseline: MetricStats = metric([100, 101, 102, 103, 104]);
  const candidate: MetricStats = metric([70, 71, 72, 73, 74]);
  const decision = decideImprovement(baseline, candidate, goal, config);
  assert(decision.improved, `expected Mann-Whitney fallback to accept: ${JSON.stringify(decision)}`);
  assert(decision.confidence === 'mann-whitney-p<0.05', `unexpected confidence: ${decision.confidence}`);
  assert((decision.pValue ?? 1) < 0.05, `decision p-value not significant: ${JSON.stringify(decision)}`);

  const evaluation: CandidateEvaluation = {
    checks: okCommand(),
    measure: okCommand(),
    metric: candidate,
    improved: decision.improved,
    deltaPct: decision.deltaPct,
    confidence: decision.confidence,
    ciLow: decision.ciLow,
    ciHigh: decision.ciHigh,
    pValue: decision.pValue,
    reason: decision.reason
  };
  const ledger = ledgerFromEvaluation({
    iter: 1,
    stepId: 'step-1',
    status: 'keep',
    hypothesis: 'verify significance fallback',
    commit: 'abc123',
    baseline,
    evaluation,
    wallMs: 5,
    reflection: evaluation.reason
  });
  assert(ledger.p_value === decision.pValue, `ledger did not persist p-value: ${JSON.stringify(ledger)}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        confidence: decision.confidence,
        p_value: decision.pValue,
        ledger_p_value: ledger.p_value
      },
      null,
      2
    )
  );
}

function metric(samples: number[]): MetricStats {
  return {
    p50: samples[2],
    p95: samples[4],
    p99: samples[4],
    unit: 'ms',
    n: samples.length,
    warmup_discarded: 0,
    samples
  };
}

function okCommand(): CommandOutcome {
  return { ok: true, exitCode: 0, output: '', wallMs: 1 };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
