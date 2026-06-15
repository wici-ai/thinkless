import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { ensureRunDirs, runPaths } from '../shared/paths.js';
import { atomicWriteJson, exists } from '../shared/atomic.js';
import type { AcceptanceSpec, BaselineFile, GoalFile, OutboxMessage, RunEvent } from '../shared/types.js';

const target = resolve('fixture/acceptance-spec-target');
const clarifyTarget = resolve('fixture/acceptance-clarify-target');
process.env.WICI_LEGACY_OPTIMIZER = '1';

async function main(): Promise<void> {
  await verifyFrozenSpec();
  await verifyUpfrontClarify();
}

async function verifyFrozenSpec(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure(target);
  const paths = runPaths(target);

  const result = await execa(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Freeze acceptance criteria before optimization', '--max-iters', '2', '--mode', 'stub'],
    {
      cwd: resolve('.'),
      all: true,
      reject: false,
      timeout: 30_000
    }
  );
  assert(result.exitCode === 0, `acceptance spec supervisor run failed:\n${result.all}`);

  const spec = JSON.parse(await readFile(paths.acceptanceSpec, 'utf8')) as AcceptanceSpec;
  assert(spec.version === 1, `unexpected spec version ${spec.version}`);
  assert(spec.run_id.length > 0, 'acceptance spec missing run_id');
  assert(spec.criteria.some((criterion) => criterion.check === './.opt/checks.sh'), 'acceptance spec missing checks criterion');
  assert(spec.criteria.some((criterion) => criterion.check === './.opt/measure.sh'), 'acceptance spec missing measure criterion');

  const baseline = JSON.parse(await readFile(paths.baseline, 'utf8')) as BaselineFile;
  assert(typeof baseline.eval_sha256.acceptance_spec === 'string' && baseline.eval_sha256.acceptance_spec.length > 0, 'baseline did not pin acceptance spec hash');

  const secondPrompt = await readFile(join(paths.artifacts, 'iter-2.prompt.txt'), 'utf8');
  assert(secondPrompt.includes('Frozen acceptance spec'), 'iter-2 prompt missing frozen acceptance spec');
  assert(secondPrompt.includes('./.opt/checks.sh'), 'iter-2 prompt missing acceptance check command');

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'ACCEPTANCE_SPEC_FROZEN'), 'missing ACCEPTANCE_SPEC_FROZEN event');

  await chmod(paths.acceptanceSpec, 0o644);
  const tampered = JSON.parse(await readFile(paths.acceptanceSpec, 'utf8')) as AcceptanceSpec;
  tampered.criteria[0] = { ...tampered.criteria[0], check: 'true' };
  await atomicWriteJson(paths.acceptanceSpec, tampered);
  const rejected = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--max-iters', '3', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(rejected.exitCode !== 0, 'tampered acceptance spec was not rejected');
  assert((rejected.all ?? '').includes('acceptance.spec.json'), `tamper error did not mention acceptance spec:\n${rejected.all}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        acceptance_spec_pinned: true,
        prompt_reused_acceptance_spec: true,
        tamper_rejected: true
      },
      null,
      2
    )
  );
}

async function verifyUpfrontClarify(): Promise<void> {
  await createSampleTarget(clarifyTarget, true);
  const paths = runPaths(clarifyTarget);
  await ensureRunDirs(paths);
  const goal: GoalFile = {
    run_id: 'acceptance-clarify-run',
    version: 1,
    requirements: [{ id: 'R1', text: 'Optimize but criteria are intentionally incomplete', source: 'initial', status: 'active' }],
    acceptance_criteria: [{ id: 'A1', text: 'Intentionally incomplete criterion', check: '' }],
    constraints: [],
    metric: { name: 'p99 latency', direction: 'minimize', target: null, unit: 'ms' },
    budget: { max_iters: 1, max_cost_usd: 0, deadline: null },
    stop: { tau: 0.01, K: 3, N: 4, mode: 'auto' }
  };
  await atomicWriteJson(paths.goal, goal);

  const result = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', clarifyTarget, '--max-iters', '1', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(result.exitCode === 0, `acceptance clarify run failed unexpectedly:\n${result.all}`);
  assert((result.all ?? '').includes('awaiting acceptance criteria clarification'), `clarify run returned wrong reason:\n${result.all}`);
  assert(await exists(paths.plan), 'PLAN.md should be allowed to materialize before legacy acceptance clarification');
  assert(!(await exists(paths.baseline)), 'baseline should not be initialized before acceptance clarification');
  assert(!(await exists(paths.acceptanceSpec)), 'acceptance.spec.json should not exist before clarification');

  const outbox = await readOutboxFiles(paths.outbox);
  const question = outbox.find((message) => message.reply_key === 'acceptance-spec');
  assert(question?.kind === 'question', `missing acceptance clarification question: ${JSON.stringify(outbox)}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'ACCEPTANCE_SPEC_CLARIFY'), 'missing ACCEPTANCE_SPEC_CLARIFY event');
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

async function readJsonLines<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function readOutboxFiles(path: string): Promise<OutboxMessage[]> {
  return Promise.all(
    (await readdir(path))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map(async (name) => JSON.parse(await readFile(join(path, name), 'utf8')) as OutboxMessage)
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
