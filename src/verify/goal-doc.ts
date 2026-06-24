import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import type { CheckpointSnapshot, GoalFile, LedgerEntry, MetricStats } from '../shared/types.js';
import { markSatisfiedPrimaryRequirements } from '../supervisor/goalInterrogation.js';
import { renderGoalMarkdown } from '../supervisor/goalDoc.js';
import { ignoreFixturePlannerOpt } from './fixture-git.js';

const target = resolve('fixture/goal-doc-target');
const goalText = 'Use a generic markdown goal contract; planner and executor decide any deployment details.';

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await ignoreFixturePlannerOpt(target);
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

  const modeledGoal = sampleGoal();
  const rendered = renderGoalMarkdown(modeledGoal);
  assert(rendered.includes('## Primary'), 'GOAL.md must render primary requirements separately');
  assert(rendered.includes('## Stretch'), 'GOAL.md must render stretch requirements separately');
  assert(rendered.includes('R1: Ship the fixed deliverable'), 'GOAL.md missing primary requirement text');
  assert(rendered.includes('R2 (stop-when: no further measurable improvement): Keep polishing within bounds'), 'GOAL.md missing stretch stop_when text');

  const satisfied = markSatisfiedPrimaryRequirements(modeledGoal, [ledgerEntry(1, 'keep', metric(10))]);
  assert(satisfied, 'target-met ledger should mark active primary requirements satisfied');
  assert(satisfied.version === modeledGoal.version + 1, 'marking requirements should bump goal version');
  assert(satisfied.requirements.find((req) => req.id === 'R1')?.status === 'done', 'primary requirement should be marked done');
  assert(satisfied.requirements.find((req) => req.id === 'R2')?.status === 'active', 'stretch requirement should remain active');

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        goal_doc: 'GOAL.md',
        internal_goal_json: '.wici/goal.json',
        snapshot_preserved_goal_doc: true,
        primary_stretch_rendered: true,
        primary_marked_satisfied: true
      },
      null,
      2
    )
  );
}

function sampleGoal(): GoalFile {
  return {
    run_id: 'goal-doc-primary-stretch',
    version: 1,
    requirements: [
      { id: 'R1', text: 'Ship the fixed deliverable', source: 'initial', status: 'active', kind: 'primary' },
      {
        id: 'R2',
        text: 'Keep polishing within bounds',
        source: 'chat',
        status: 'active',
        kind: 'stretch',
        stop_when: 'no further measurable improvement'
      }
    ],
    acceptance_criteria: [{ id: 'A1', text: 'target metric is met', check: 'read ledger' }],
    constraints: [],
    metric: { name: 'quality score', direction: 'maximize', target: 10, unit: 'score' },
    budget: { max_iters: 0, max_cost_usd: 0, deadline: null },
    stop: { tau: 0.01, K: 3, N: 4, mode: 'auto' }
  };
}

function metric(value: number): MetricStats {
  return { value, p50: value, p95: value, p99: value, unit: 'score', n: 5 };
}

function ledgerEntry(iter: number, status: LedgerEntry['status'], entryMetric: MetricStats): LedgerEntry {
  return {
    id: `iter-${iter}`,
    ts: new Date().toISOString(),
    iter,
    step_id: `S${iter}`,
    commit: null,
    hypothesis: `step ${iter}`,
    metric: entryMetric,
    baseline: null,
    delta_pct: 0,
    confidence: 'fixture',
    cost: { wall_ms: 1, tokens_input: 0, tokens_output: 0, usd: 0 },
    guards: { step_done: status === 'keep', tests_pass: status === 'keep' },
    status,
    reflection: status
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
