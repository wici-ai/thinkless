import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import type { CheckpointSnapshot, GoalFile } from '../shared/types.js';

const target = resolve('fixture/goal-doc-target');
const goalText = 'Use a generic markdown goal contract; planner and executor decide any deployment details.';

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
  assert(result.exitCode === 0, `goal doc run failed:\n${result.all}`);
  assert((result.all ?? '').includes('Reached max_iters=1'), `goal doc run returned unexpected state:\n${result.all}`);

  const goalDoc = await readFile(paths.goalDoc, 'utf8');
  assert(goalDoc.startsWith('# GOAL'), 'GOAL.md missing title');
  assert(goalDoc.includes(goalText), 'GOAL.md missing initial natural-language goal');
  assert(goalDoc.includes('user-facing contract'), 'GOAL.md should identify the markdown contract');
  assert(goalDoc.includes('.wici/goal.json only as internal derived state'), 'GOAL.md should demote goal.json to internal state');
  assert(goalDoc.includes('Deployment, SSH, model discovery, benchmark setup'), 'GOAL.md should assign operational discovery to PLAN/Codex');

  const goal = JSON.parse(await readFile(paths.goal, 'utf8')) as GoalFile;
  assert(goal.requirements.some((req) => req.text === goalText), 'internal goal state missing initial requirement');

  const snapshot = JSON.parse(await readFile(`${paths.checkpoints}/iter-0.json`, 'utf8')) as CheckpointSnapshot;
  assert(snapshot.files.goal_doc?.includes(goalText), 'iteration snapshot did not preserve GOAL.md');

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after goal doc run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        goal_doc: 'GOAL.md',
        internal_goal_json: '.wici/goal.json',
        snapshot_preserved_goal_doc: true
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
