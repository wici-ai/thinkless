import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { iterationSnapshotPath } from '../supervisor/checkpoint.js';
import { runPaths } from '../shared/paths.js';
import type { CheckpointSnapshot, CurriculumEntry, RunEvent } from '../shared/types.js';
import { ignoreFixturePlannerOpt } from './fixture-git.js';

const target = resolve('fixture/curriculum-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure();
  await git(['add', 'measure.mjs']);
  await git(['commit', '-m', 'test: add deterministic curriculum measure']);
  await ignoreFixturePlannerOpt(target);
  const paths = runPaths(target);

  const result = await execa(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Delegate stalled replan direction to the planner', '--max-iters', '3', '--mode', 'stub'],
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
  assert(entries.length === 0, `supervisor should not generate category curriculum entries, got ${entries.length}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(!events.some((item) => item.type === 'CURRICULUM_SUBGOAL'), 'supervisor should not emit CURRICULUM_SUBGOAL');
  assert(!events.some((item) => item.type === 'BRANCH_REPLAN_REQUEST'), 'fresh direct path should not force an optimizer branch replan');

  const plan = await readFile(paths.plan, 'utf8');
  assert(!plan.includes('Curriculum sub-goal:'), 'PLAN.md should not include supervisor-generated curriculum text');
  assert(!plan.includes('Avenue:'), 'PLAN.md should not include supervisor-selected avenue text');
  assert(plan.includes('S1') && plan.includes('S2'), 'PLAN.md should remain a normal direct execution plan');

  const context = await readFile(paths.context, 'utf8');
  assert(context.includes('## Latest Curriculum Sub-goal'), 'context missing latest curriculum section');
  assert(context.includes('- none yet'), 'context should not contain supervisor-generated curriculum');

  const snapshot = JSON.parse(await readFile(iterationSnapshotPath(paths, 0), 'utf8')) as CheckpointSnapshot;
  assert(!snapshot.files.curriculum, 'iteration snapshot should not preserve absent curriculum jsonl');

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after curriculum run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        supervisor_curriculum_disabled: true,
        direct_path_avoids_branch_replan: true
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
  let raw = '';
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
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
