import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { ensureRunDirs, runPaths } from '../shared/paths.js';
import type { GoalFile, WiCiConfig } from '../shared/types.js';
import { runExecutorStep } from '../supervisor/executor.js';
import { ensureGitRepo } from '../supervisor/gitgate.js';
import { runInitialPlanner, runPlanDiff } from '../supervisor/planner.js';

const target = resolve('fixture/real-mode-target');
const emptyTarget = resolve('fixture/real-mode-empty-target');
const nonGitTarget = resolve('fixture/real-mode-non-git-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  const config = fakeRealConfig();
  const goal = fakeGoal();

  await verifyFreshTargetGitInit(config);
  await verifyNonEmptyNonGitTargetRejected(config);

  await expectRejects(() => runInitialPlanner(paths, goal, config), 'Planner command not found in real mode');
  await expectRejects(() => runPlanDiff(paths, goal, undefined, 'new requirement', config), 'Planner command not found in real mode');
  await expectRejects(() => runExecutorStep(paths, goal, 'S1', 1, config), 'Executor command not found in real mode');

  console.log(
    JSON.stringify(
        {
          ok: true,
          target,
          fresh_target_git_init: true,
          non_empty_non_git_rejected: true,
          real_mode_does_not_fallback_to_stub: true
        },
      null,
      2
    )
  );
}

async function verifyFreshTargetGitInit(config: WiCiConfig): Promise<void> {
  await rm(emptyTarget, { recursive: true, force: true });
  try {
    const paths = runPaths(emptyTarget);
    await ensureRunDirs(paths);
    await ensureGitRepo(paths, config);
    const result = await execa('git', ['-C', emptyTarget, 'rev-parse', '--show-toplevel']);
    if (resolve(result.stdout.trim()) !== emptyTarget) throw new Error('fresh WiCi target was not initialized as a git top-level');
  } finally {
    await rm(emptyTarget, { recursive: true, force: true });
  }
}

async function verifyNonEmptyNonGitTargetRejected(config: WiCiConfig): Promise<void> {
  await rm(nonGitTarget, { recursive: true, force: true });
  try {
    await mkdir(nonGitTarget, { recursive: true });
    await writeFile(`${nonGitTarget}/user-file.txt`, 'user owned file\n');
    const paths = runPaths(nonGitTarget);
    await ensureRunDirs(paths);
    await expectRejects(() => ensureGitRepo(paths, config), 'Target is not a git repository');
  } finally {
    await rm(nonGitTarget, { recursive: true, force: true });
  }
}

function fakeRealConfig(): WiCiConfig {
  return {
    tools: {
      mode: 'real',
      planner: {
        command: 'definitely-missing-claude-for-wici-test',
        effort: 'default'
      },
      executor: {
        command: 'definitely-missing-codex-for-wici-test',
        dangerouslyBypassApprovalsAndSandbox: true
      }
    },
    budget: {
      max_iters: 3,
      max_cost_usd: 1,
      deadline: null
    },
    stop: {
      tau: 0.01,
      K: 3,
      N: 4,
      mode: 'auto'
    },
    retry: {
      max_attempts_per_step: 2,
      reverts_before_reset: 5,
      stall_replan_after: 3
    },
    evaluation: {
      noise_threshold: 0.01,
      min_reps: 5,
      bootstrap_resamples: 1000,
      checks_timeout_ms: 300000,
      measure_timeout_ms: 300000
    },
    git: {
      init_if_missing: false,
      user_name: 'WiCi Test',
      user_email: 'wici-test@example.invalid'
    },
    safety: {
      container_hint: 'test',
      forbidden_actions: []
    }
  };
}

function fakeGoal(): GoalFile {
  return {
    run_id: 'real-mode-test',
    version: 1,
    requirements: [{ id: 'R1', text: 'test real mode fallback', source: 'initial', status: 'active' }],
    acceptance_criteria: [],
    constraints: [],
    metric: { name: 'fixture runtime', direction: 'minimize', target: null, unit: 'ms' },
    budget: { max_iters: 3, max_cost_usd: 1, deadline: null },
    stop: { tau: 0.01, K: 3, N: 4, mode: 'auto' }
  };
}

async function expectRejects(fn: () => Promise<unknown>, expected: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(expected)) return;
    throw new Error(`Expected error containing "${expected}", got "${message}"`);
  }
  throw new Error(`Expected rejection containing "${expected}"`);
}

await main();
