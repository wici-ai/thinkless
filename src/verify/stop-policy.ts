import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson } from '../shared/atomic.js';
import { ensureRunDirs, runPaths } from '../shared/paths.js';
import type { GoalFile, LedgerEntry, OutboxMessage, RunEvent, WiCiConfig } from '../shared/types.js';
import { buildStopAnalysis, shouldStop } from '../supervisor/stop.js';

const target = resolve('fixture/stop-policy-target');

async function main(): Promise<void> {
  await verifyCostAnalysis();
  await verifySupervisorOutboxAnalysis();
}

async function verifyCostAnalysis(): Promise<void> {
  const goal = stopGoal({ tau: 0.05, mode: 'auto' });
  const ledger = syntheticLedger();
  const analysis = buildStopAnalysis(goal, ledger);
  assert(analysis.target_met === true, 'target should be met by the latest keep');
  assert(analysis.no_recent_keep === true, 'latest reject should satisfy no_recent_keep with N=1');
  assert(analysis.cumulative_cost.wall_ms === 3500, `unexpected wall cost ${analysis.cumulative_cost.wall_ms}`);
  assert(analysis.cumulative_cost.tokens_input === 3000, `unexpected input tokens ${analysis.cumulative_cost.tokens_input}`);
  assert(analysis.cumulative_cost.tokens_output === 1500, `unexpected output tokens ${analysis.cumulative_cost.tokens_output}`);
  assert(analysis.cumulative_cost.usd === 0.03, `unexpected usd cost ${analysis.cumulative_cost.usd}`);
  assert(analysis.cumulative_cost.effective_cost_units > analysis.cumulative_cost.wall_ms / 1000, 'effective cost did not include token/usd cost');
  assert(analysis.recent_curve.length === 2, `expected two keep points, got ${analysis.recent_curve.length}`);
  assert(analysis.recent_curve[1].marginal_value < analysis.recent_curve[0].marginal_value, 'recent marginal value should fall as cost rises and delta shrinks');

  const paths = runPaths(resolve('fixture/stop-policy-synthetic'));
  const decision = await shouldStop(paths, goal, ledger, config());
  assert(decision.candidate === true, `expected stop candidate: ${JSON.stringify(decision)}`);
  assert(decision.stop === true, `stub worth-it verdict should stop: ${JSON.stringify(decision)}`);
  assert(decision.reason.includes('tokens='), `stop reason should include token cost: ${decision.reason}`);

  const continueGoal = stopGoal({ tau: 0.000001, mode: 'auto' });
  const keepGoing = await shouldStop(paths, continueGoal, ledger, config());
  assert(keepGoing.candidate === false, `low tau should continue: ${JSON.stringify(keepGoing)}`);
}

async function verifySupervisorOutboxAnalysis(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  await ensureRunDirs(paths);
  await atomicWriteJson(paths.goal, stopGoal({ tau: 999, mode: 'ask' }));

  const result = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--max-iters', '3', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(result.exitCode === 0, `stop-policy supervisor run failed:\n${result.all}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  const stopCheck = events.find((event) => event.type === 'STOP_CHECK' && (event.data as { stop?: boolean } | undefined)?.stop === true);
  const eventAnalysis = (stopCheck?.data as { stop_analysis?: { cumulative_cost?: { tokens_input?: number } } } | undefined)?.stop_analysis;
  assert((eventAnalysis?.cumulative_cost?.tokens_input ?? 0) > 0, `STOP_CHECK missing token-aware analysis: ${JSON.stringify(stopCheck)}`);

  const messages = await readOutbox(paths.outbox);
  const question = messages.find((message) => message.kind === 'question' && message.text.includes('Stop candidate:'));
  const outboxAnalysis = (question?.data as { stop_analysis?: { recent_curve?: unknown[]; cumulative_cost?: { tokens_output?: number } } } | undefined)?.stop_analysis;
  assert(outboxAnalysis, `ask stop outbox missing stop_analysis: ${JSON.stringify(question)}`);
  assert((outboxAnalysis.cumulative_cost?.tokens_output ?? 0) > 0, `outbox analysis missing token output cost: ${JSON.stringify(outboxAnalysis)}`);
  assert((outboxAnalysis.recent_curve?.length ?? 0) > 0, `outbox analysis missing marginal curve: ${JSON.stringify(outboxAnalysis)}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after stop-policy run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        stop_analysis_in_event: true,
        stop_analysis_in_outbox: true,
        token_cost_included: true
      },
      null,
      2
    )
  );
}

function syntheticLedger(): LedgerEntry[] {
  return [
    ledgerRow('iter-1', 1, 'keep', 0.1, 120, { wall_ms: 1000, tokens_input: 500, tokens_output: 250, usd: 0.01 }),
    ledgerRow('iter-2', 2, 'keep', 0.01, 90, { wall_ms: 2000, tokens_input: 1500, tokens_output: 750, usd: 0.02 }),
    ledgerRow('iter-3', 3, 'reject', -0.001, 91, { wall_ms: 500, tokens_input: 1000, tokens_output: 500 })
  ];
}

function ledgerRow(
  id: string,
  iter: number,
  status: LedgerEntry['status'],
  delta: number,
  p99: number,
  cost: LedgerEntry['cost']
): LedgerEntry {
  return {
    id,
    ts: new Date().toISOString(),
    iter,
    step_id: `S${iter}`,
    commit: status === 'keep' ? `commit-${iter}` : null,
    hypothesis: `Synthetic ${status}`,
    metric: { p50: p99, p95: p99, p99, unit: 'ms', n: 5 },
    baseline: { p50: 150, p95: 150, p99: 150, unit: 'ms', n: 5 },
    delta_pct: delta,
    confidence: 'synthetic',
    cost,
    guards: { checks: true },
    status,
    reflection: 'synthetic',
    parent_id: null
  };
}

function stopGoal(input: { tau: number; mode: 'auto' | 'ask' }): GoalFile {
  return {
    run_id: `stop-policy-${Date.now()}`,
    version: 1,
    requirements: [{ id: 'R1', text: 'Stop only when marginal value is not worth cost', source: 'initial', status: 'active' }],
    acceptance_criteria: [
      { id: 'A1', text: 'checks pass', check: './.opt/checks.sh' },
      { id: 'A2', text: 'measure emits metric', check: './.opt/measure.sh' }
    ],
    constraints: [],
    metric: { name: 'p99 latency', direction: 'minimize', target: 1000, unit: 'ms' },
    budget: { max_iters: 3, max_cost_usd: 50, deadline: null },
    stop: { tau: input.tau, K: 2, N: 1, mode: input.mode }
  };
}

function config(): WiCiConfig {
  return {
    tools: {
      mode: 'stub',
      planner: { command: 'claude', effort: 'max' },
      executor: { command: 'codex', dangerouslyBypassApprovalsAndSandbox: true }
    },
    budget: { max_iters: 3, max_cost_usd: 50, deadline: null },
    stop: { tau: 0.01, K: 2, N: 1, mode: 'auto' },
    retry: { max_attempts_per_step: 2, reverts_before_reset: 5, stall_replan_after: 3 },
    diversity: { avenues: ['algorithmic complexity'] },
    evaluation: { noise_threshold: 0.01, min_reps: 5, bootstrap_resamples: 1000, checks_timeout_ms: 300000, measure_timeout_ms: 300000 },
    git: { init_if_missing: false, user_name: 'WiCi Bot', user_email: 'wici@example.invalid' },
    safety: { container_hint: 'test', forbidden_actions: [] }
  };
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function readOutbox(path: string): Promise<OutboxMessage[]> {
  const { readdir } = await import('node:fs/promises');
  return Promise.all(
    (await readdir(path))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map(async (name) => JSON.parse(await readFile(`${path}/${name}`, 'utf8')) as OutboxMessage)
  );
}

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
