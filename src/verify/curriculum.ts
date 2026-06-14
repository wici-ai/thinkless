import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { iterationSnapshotPath } from '../supervisor/checkpoint.js';
import { runPaths } from '../shared/paths.js';
import type { CheckpointSnapshot, CurriculumEntry, RunEvent } from '../shared/types.js';

const target = resolve('fixture/curriculum-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure();
  const paths = runPaths(target);

  const result = await execa(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Generate a curriculum sub-goal when an avenue saturates', '--max-iters', '3', '--mode', 'stub'],
    {
      cwd: resolve('.'),
      all: true,
      reject: false,
      timeout: 30_000,
      env: {
        ...process.env,
        WICI_THOMPSON_SEED: '17'
      }
    }
  );
  assert(result.exitCode === 0, `curriculum verifier supervisor run failed:\n${result.all}`);

  const entries = await readJsonLines<CurriculumEntry>(paths.curriculum);
  assert(entries.length === 1, `expected one curriculum entry, got ${entries.length}`);
  const entry = entries[0];
  assert(entry.id === 'curriculum-3-S2', `unexpected curriculum id: ${entry.id}`);
  assert(entry.iter === 3, `expected curriculum at iter 3, got ${entry.iter}`);
  assert(entry.saturated_step_id === 'S2', `expected saturated step S2, got ${entry.saturated_step_id}`);
  assert(entry.parent_ledger_id === 'iter-1', `expected parent iter-1, got ${entry.parent_ledger_id}`);
  assert(entry.sub_goal.includes(entry.avenue), 'curriculum sub-goal missing selected avenue');
  assert(entry.sub_goal.includes('acceptance.spec.json'), 'curriculum sub-goal missing acceptance-spec guardrail');

  const events = await readJsonLines<RunEvent>(paths.events);
  const event = events.find((item) => item.type === 'CURRICULUM_SUBGOAL');
  assert(event, 'missing CURRICULUM_SUBGOAL event');
  assert((event.data as { id?: string } | undefined)?.id === entry.id, `curriculum event did not reference ${entry.id}`);

  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes('Curriculum sub-goal:'), 'PLAN.md missing curriculum replan text');
  assert(plan.includes(entry.sub_goal), 'PLAN.md missing generated curriculum sub-goal');

  const context = await readFile(paths.context, 'utf8');
  assert(context.includes('## Latest Curriculum Sub-goal'), 'context missing latest curriculum section');
  assert(context.includes(entry.id), 'context missing curriculum id');
  assert(context.includes(entry.sub_goal), 'context missing curriculum sub-goal');

  const snapshot = JSON.parse(await readFile(iterationSnapshotPath(paths, 3), 'utf8')) as CheckpointSnapshot;
  assert(snapshot.files.curriculum?.includes(entry.id), 'iteration snapshot did not preserve curriculum jsonl');

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after curriculum run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        curriculum_id: entry.id,
        avenue: entry.avenue,
        context_includes_curriculum: true
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
