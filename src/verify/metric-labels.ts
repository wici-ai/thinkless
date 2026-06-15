import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { ensureRunDirs } from '../shared/paths.js';
import { readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { GoalFile, LedgerEntry } from '../shared/types.js';
import { saveGoalFiles } from '../supervisor/goalDoc.js';

const target = resolve('fixture/metric-label-target');
const goalText = '听说diffussionGemma很快，要求达到700token/s以上';
process.env.WICI_LEGACY_OPTIMIZER = '1';

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeThroughputMeasure();
  await git(['add', 'measure.mjs']);
  await git(['commit', '-m', 'test: make throughput measure deterministic']);
  const paths = runPaths(target);
  await ensureRunDirs(paths);
  await saveGoalFiles(paths, throughputGoal());

  const result = await execa(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--max-iters', '1', '--mode', 'stub'],
    {
      cwd: resolve('.'),
      all: true,
      reject: false,
      timeout: 30_000
    }
  );
  assert(result.exitCode === 0, `metric label run failed:\n${result.all}`);

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 1, `expected one ledger row, got ${ledger.length}`);
  assert(ledger[0].status === 'keep', `expected throughput row to be kept, got ${ledger[0].status}`);
  assert(ledger[0].metric?.unit === 'token/s', `ledger should record token/s metric: ${JSON.stringify(ledger[0].metric)}`);

  const log = await git(['log', '--format=%s', '-8']);
  assert(log.includes('throughput 650token/s->850token/s'), `perf commit did not use planner-selected metric label:\n${log}`);
  assert(!log.includes('| p99 650->850token/s'), `perf commit leaked p99 label for throughput:\n${log}`);

  const tags = await git(['tag', '--list', 'perf/*']);
  assert(tags.split('\n').some((tag) => tag.startsWith('perf/throughput-850token-s-')), `planner metric perf tag missing or unsanitized:\n${tags}`);
  assert(!tags.includes('perf/p99-850token/s'), `throughput perf tag used p99 label:\n${tags}`);

  const artifact = await readFile(`${target}/wici-limit-artifact.md`, 'utf8');
  assert(artifact.includes('Best throughput=850token/s'), `limit artifact missing planner metric label:\n${artifact}`);
  assert(artifact.includes('throughput=850token/s'), `recent ledger artifact missing planner metric:\n${artifact}`);
  assert(!artifact.includes('Best p99:'), `limit artifact leaked old p99 heading:\n${artifact}`);

  const context = await readFile(paths.context, 'utf8');
  assert(context.includes('throughput=850token/s'), `context summary missing planner metric:\n${context}`);
  assert(!context.includes(' p99=850token/s'), `context summary leaked p99 label:\n${context}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target dirty after metric label run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        metric: ledger[0].metric,
        generic_commit_label: true,
        generic_tag_label: true,
        generic_artifact_label: true,
        generic_context_label: true
      },
      null,
      2
    )
  );
}

async function writeThroughputMeasure(): Promise<void> {
  await writeFile(
    `${target}/measure.mjs`,
    `import { readFileSync } from 'node:fs';

const source = readFileSync('./src/hotpath.js', 'utf8');
const optimized = source.includes('new Set');
const samples = optimized ? [850, 850, 850, 850, 850, 850, 850] : [650, 650, 650, 650, 650, 650, 650];
const value = samples[6];
console.log(\`METRIC value=\${value} unit=token/s n=\${samples.length} warmup_discarded=2 samples=\${samples.join(',')}\`);
`
  );
}

function throughputGoal(): GoalFile {
  return {
    run_id: `metric-label-${Date.now()}`,
    version: 1,
    requirements: [{ id: 'R1', text: goalText, source: 'initial', status: 'active' }],
    acceptance_criteria: [
      { id: 'A1', text: 'Fixture tests pass.', check: './.opt/checks.sh' },
      { id: 'A2', text: 'Throughput measurement runs.', check: './.opt/measure.sh' }
    ],
    constraints: ['Do not edit planner-generated validation scripts after lock.'],
    metric: { name: 'throughput', direction: 'maximize', target: 700, unit: 'token/s' },
    budget: { max_iters: 1, max_cost_usd: 0, deadline: null },
    stop: { tau: 0.01, K: 1, N: 1, mode: 'auto' }
  };
}

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
