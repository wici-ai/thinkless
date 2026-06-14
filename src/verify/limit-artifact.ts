import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { ensureRunDirs, runPaths } from '../shared/paths.js';
import { atomicWriteJson } from '../shared/atomic.js';
import type { GoalFile, OutboxMessage, RunEvent } from '../shared/types.js';

const maxTarget = resolve('fixture/limit-artifact-target');
const deadlineTarget = resolve('fixture/limit-artifact-deadline-target');

async function main(): Promise<void> {
  await verifyMaxIterArtifact();
  await verifyDeadlineArtifact();
}

async function verifyMaxIterArtifact(): Promise<void> {
  await createSampleTarget(maxTarget, true);
  await writeDeterministicMeasure(maxTarget);
  const paths = runPaths(maxTarget);

  const first = await run(maxTarget, ['--goal', 'Commit the best artifact when max_iters is reached', '--max-iters', '1', '--mode', 'stub']);
  assert(first.exitCode === 0, `max_iters limit artifact run failed:\n${first.all}`);

  const artifact = await readFile(`${maxTarget}/wici-limit-artifact.md`, 'utf8');
  assert(artifact.includes('Reason: Reached max_iters=1'), 'limit artifact missing max_iters reason');
  assert(artifact.includes('Best commit:'), 'limit artifact missing best commit');
  assert(artifact.includes('Accepted rows: 1'), 'limit artifact missing accepted row count');

  const firstCommitCount = await limitArtifactCommitCount(maxTarget);
  assert(firstCommitCount === 1, `expected one limit artifact commit, got ${firstCommitCount}`);

  const second = await run(maxTarget, ['--max-iters', '1', '--mode', 'stub']);
  assert(second.exitCode === 0, `idempotent max_iters rerun failed:\n${second.all}`);
  const secondCommitCount = await limitArtifactCommitCount(maxTarget);
  assert(secondCommitCount === 1, `limit artifact rerun created duplicate commits: ${secondCommitCount}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'LIMIT_ARTIFACT_COMMIT'), 'missing LIMIT_ARTIFACT_COMMIT event');
  const outbox = await readOutbox(paths.outbox);
  assert(outbox.some((message) => message.text === 'Reached max_iters=1' && message.data), 'missing outbox limit artifact data');

  const status = await git(maxTarget, ['status', '--short']);
  assert(status.trim() === '', `max target dirty after limit artifact run:\n${status}`);
}

async function verifyDeadlineArtifact(): Promise<void> {
  await createSampleTarget(deadlineTarget, true);
  const paths = runPaths(deadlineTarget);
  await ensureRunDirs(paths);
  const goal: GoalFile = {
    run_id: 'deadline-limit-artifact-run',
    version: 1,
    requirements: [{ id: 'R1', text: 'Commit the best artifact when deadline is exceeded', source: 'initial', status: 'active' }],
    acceptance_criteria: [
      { id: 'A1', text: 'Locked checks pass.', check: './.opt/checks.sh' },
      { id: 'A2', text: 'Metric is measured.', check: './.opt/measure.sh' }
    ],
    constraints: [],
    metric: { name: 'p99 latency', direction: 'minimize', target: null, unit: 'ms' },
    budget: { max_iters: 1, max_cost_usd: 0, deadline: '2000-01-01T00:00:00.000Z' },
    stop: { tau: 0.01, K: 3, N: 4, mode: 'auto' }
  };
  await atomicWriteJson(paths.goal, goal);

  const result = await run(deadlineTarget, ['--max-iters', '1', '--mode', 'stub']);
  assert(result.exitCode !== 0, 'deadline hard backstop should return a failed process');
  assert((result.all ?? '').includes('Hard deadline exceeded'), `deadline result missing hard backstop reason:\n${result.all}`);

  const artifact = await readFile(`${deadlineTarget}/wici-limit-artifact.md`, 'utf8');
  assert(artifact.includes('Reason: Hard deadline exceeded: 2000-01-01T00:00:00.000Z'), 'deadline artifact missing reason');
  assert(artifact.includes('Ledger rows: 0'), 'deadline artifact should record zero ledger rows');

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'LIMIT_ARTIFACT_COMMIT'), 'missing deadline LIMIT_ARTIFACT_COMMIT event');
  assert(events.some((event) => event.type === 'FAILED' && event.message.includes('Hard deadline exceeded')), 'missing deadline FAILED event');

  const status = await git(deadlineTarget, ['status', '--short']);
  assert(status.trim() === '', `deadline target dirty after limit artifact run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        max_target: maxTarget,
        deadline_target: deadlineTarget,
        max_artifact_idempotent: true,
        deadline_artifact_committed: true
      },
      null,
      2
    )
  );
}

async function writeDeterministicMeasure(root: string): Promise<void> {
  await writeFile(
    `${root}/measure.mjs`,
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

async function run(target: string, args: string[]) {
  return execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, ...args], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
}

async function limitArtifactCommitCount(target: string): Promise<number> {
  const commits = await git(target, ['log', '--oneline', '--grep', '^chore: record WiCi limit artifact']);
  return commits.split('\n').filter(Boolean).length;
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

async function git(target: string, args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
