import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import type { GoalFile, LedgerEntry } from '../shared/types.js';
import { writeContextSummary } from '../supervisor/context.js';

const target = resolve('fixture/context-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure();
  const paths = runPaths(target);

  const result = await execa(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Condense public history while preserving the pinned goal', '--max-iters', '2', '--mode', 'stub'],
    {
      cwd: resolve('.'),
      all: true,
      reject: false,
      timeout: 30_000
    }
  );
  assert(result.exitCode === 0, `context condensation verifier supervisor run failed:\n${result.all}`);

  const context = await readFile(paths.context, 'utf8');
  assert(context.includes('# WiCi Condensed Run Context'), 'context summary missing title');
  assert(context.includes('KEEP_FIRST_GOAL'), 'context summary missing keep-first goal section');
  assert(context.includes('Condense public history while preserving the pinned goal'), 'context summary missing initial requirement');
  assert(context.includes('## Recent Public Ledger'), 'context summary missing recent public ledger');
  assert(context.includes('iter-1'), 'context summary missing first ledger entry');
  assert(context.includes('iter-2'), 'context summary missing second ledger entry');
  assert(!context.includes('heldout_p99'), 'context summary leaked held-out guard');

  const secondPrompt = await readFile(join(paths.artifacts, 'iter-2.prompt.txt'), 'utf8');
  assert(secondPrompt.includes('Condensed WiCi run context'), 'iter-2 prompt missing condensed context header');
  assert(secondPrompt.includes('KEEP_FIRST_GOAL'), 'iter-2 prompt missing keep-first goal');
  assert(secondPrompt.includes('iter-1'), 'iter-2 prompt missing prior public ledger row');

  const events = await readJsonLines<{ type: string }>(paths.events);
  assert(events.some((event) => event.type === 'CONTEXT_SUMMARY_WRITTEN'), 'missing context summary event');

  await assertHeldoutGuardFiltered();

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after context condensation run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        context_written: true,
        prompt_reused_context: true,
        heldout_guard_filtered: true
      },
      null,
      2
    )
  );
}

async function writeDeterministicMeasure(): Promise<void> {
  await writeFile(
    `${target}/measure.mjs`,
    `import { readFileSync } from 'node:fs';

const source = readFileSync('./src/hotpath.js', 'utf8');
const optimized = source.includes('new Set');
const samples = optimized ? [10, 10, 10, 10, 10, 10, 10] : [100, 100, 100, 100, 100, 100, 100];
const p50 = samples[3];
const p95 = samples[6];
const p99 = samples[6];
console.log(\`METRIC p50=\${p50} p95=\${p95} p99=\${p99} unit=ms n=\${samples.length} warmup_discarded=2 samples=\${samples.join(',')}\`);
`
  );
}

async function assertHeldoutGuardFiltered(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'wici-context-'));
  try {
    const paths = runPaths(tmp);
    const goal: GoalFile = {
      run_id: 'synthetic-context-run',
      version: 1,
      requirements: [{ id: 'R1', text: 'Synthetic held-out leak test', source: 'initial', status: 'active' }],
      acceptance_criteria: [],
      constraints: [],
      metric: { name: 'p99 latency', direction: 'minimize', target: null, unit: 'ms' },
      budget: { max_iters: 2, max_cost_usd: 0, deadline: null },
      stop: { tau: 0, K: 2, N: 2, mode: 'auto' }
    };
    const ledger: LedgerEntry[] = [
      {
        id: 'iter-heldout',
        ts: new Date().toISOString(),
        iter: 1,
        step_id: 'S1',
        commit: null,
        hypothesis: 'Synthetic ledger row',
        metric: { p50: 10, p95: 10, p99: 10, unit: 'ms', n: 5 },
        baseline: { p50: 20, p95: 20, p99: 20, unit: 'ms', n: 5 },
        delta_pct: 0.5,
        confidence: 'heldout-regression',
        cost: { wall_ms: 1 },
        guards: {
          checks: true,
          reason: 'synthetic',
          heldout_p99: 999,
          heldout_delta_pct: -1,
          prescreen_p99: 10
        },
        status: 'reject',
        reflection: 'Synthetic held-out row',
        parent_id: null
      }
    ];
    await writeContextSummary(paths, goal, ledger);
    const context = await readFile(paths.context, 'utf8');
    assert(!context.includes('heldout_p99'), 'synthetic context leaked heldout_p99');
    assert(!context.includes('heldout_delta_pct'), 'synthetic context leaked heldout_delta_pct');
    assert(context.includes('prescreen_p99'), 'synthetic context should retain public prescreen guard');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
