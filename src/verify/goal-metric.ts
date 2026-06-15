import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import type { GoalFile } from '../shared/types.js';

const target = resolve('fixture/goal-metric-target');
const goalText = '听说diffussionGemma很快，在wici@192.168.1.222试试，要求达到700token/s以上';

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  const result = await execa(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', goalText, '--max-iters', '1', '--mode', 'stub'],
    {
      cwd: resolve('.'),
      all: true,
      reject: false,
      timeout: 30_000
    }
  );
  assert(result.exitCode === 0, `goal metric run failed:\n${result.all}`);

  const goal = JSON.parse(await readFile(paths.goal, 'utf8')) as GoalFile;
  assert(goal.requirements.some((req) => req.text === goalText), `GOAL should preserve raw user text: ${JSON.stringify(goal.requirements)}`);
  assert(goal.metric.name === 'fixture runtime', `stub planner should choose fixture metric, not WiCi parser output: ${JSON.stringify(goal.metric)}`);
  assert(goal.metric.target === null, `WiCi must not parse 700token/s into goal metric target, got ${goal.metric.target}`);
  assert(!goal.acceptance_criteria.some((criterion) => criterion.text.includes('700token/s')), 'acceptance criteria should not contain WiCi-parsed target');

  const goalDoc = await readFile(paths.goalDoc, 'utf8');
  assert(goalDoc.includes(goalText), 'GOAL.md missing raw user requirement');
  assert(!goalDoc.includes('- Target: 700token/s'), 'GOAL.md should not show a WiCi-inferred target');

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after goal metric run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        metric: goal.metric
      },
      null,
      2
    )
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
