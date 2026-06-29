import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { readJsonFileMaybe, readJsonLines } from '../shared/atomic.js';
import { ensureRunDirs, runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, RunEvent, WiCiConfig } from '../shared/types.js';
import { runExecutorStep } from '../supervisor/executor.js';
import { ensureGitRepo } from '../supervisor/gitgate.js';
import { runSupervisor } from '../supervisor/index.js';
import { runInitialPlanner, runPlanDiff } from '../supervisor/planner.js';

const target = resolve('fixture/real-mode-target');
const emptyTarget = resolve('fixture/real-mode-empty-target');
const nonGitTarget = resolve('fixture/real-mode-non-git-target');
const junctionRealTarget = resolve('fixture/real-mode-junction-real-target');
const junctionLinkTarget = resolve('fixture/real-mode-junction-link-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  const config = fakeRealConfig();
  const goal = fakeGoal();

  await verifyFreshTargetGitInit(config);
  await verifyNonEmptyNonGitTargetRejected(config);
  await verifyLinkedTargetGitRepoAccepted(config);
  await verifyEarlyGitFailurePersistsRestartableContext();

  await expectRejects(() => runInitialPlanner(paths, goal, config), 'Planner command not found');
  await writeFile(paths.plan, '# Plan\n\n- [ ] S1 Existing real-mode step\n');
  await expectRejects(() => runPlanDiff(paths, goal, 'fake-planner-session', 'new requirement', config), 'Planner command not found');
  await expectRejects(() => runExecutorStep(paths, goal, 'S1', 1, config), 'Executor command not found in real mode');

  console.log(
    JSON.stringify(
        {
          ok: true,
          target,
          fresh_target_git_init: true,
          non_empty_non_git_rejected: true,
          linked_target_git_repo_accepted: true,
          early_git_failure_persists_restartable_context: true,
          real_mode_does_not_fallback_to_stub: true
        },
      null,
      2
    )
  );
}

async function verifyEarlyGitFailurePersistsRestartableContext(): Promise<void> {
  await rm(nonGitTarget, { recursive: true, force: true });
  try {
    await mkdir(nonGitTarget, { recursive: true });
    await writeFile(join(nonGitTarget, 'user-file.txt'), 'user owned file\n');
    const result = await runSupervisor({
      target: nonGitTarget,
      goal: 'Verify early git guard failures remain restartable.',
      maxIters: 0,
      mode: 'stub'
    });
    if (result.state !== 'FAILED' || !result.reason.includes('Target is not a git repository')) {
      throw new Error(`expected early git guard failure, got ${JSON.stringify(result)}`);
    }
    const paths = runPaths(nonGitTarget);
    const checkpoint = await readJsonFileMaybe<Checkpoint>(paths.checkpoint);
    if (checkpoint?.supervisor_state !== 'FAILED') {
      throw new Error(`early git guard failure did not persist FAILED checkpoint: ${JSON.stringify(checkpoint)}`);
    }
    const events = await readJsonLines<RunEvent>(paths.events);
    if (!events.some((event) => event.type === 'FAILED' && event.message.includes('Target is not a git repository'))) {
      throw new Error(`early git guard failure did not persist FAILED event: ${JSON.stringify(events)}`);
    }
  } finally {
    await rm(nonGitTarget, { recursive: true, force: true });
  }
}

async function verifyLinkedTargetGitRepoAccepted(config: WiCiConfig): Promise<void> {
  await rm(junctionLinkTarget, { recursive: true, force: true });
  await rm(junctionRealTarget, { recursive: true, force: true });
  try {
    await mkdir(junctionRealTarget, { recursive: true });
    await writeFile(join(junctionRealTarget, 'README.md'), 'linked target fixture\n');
    await execa('git', ['-C', junctionRealTarget, 'init']);
    await execa('git', ['-C', junctionRealTarget, 'config', 'user.name', 'WiCi Fixture']);
    await execa('git', ['-C', junctionRealTarget, 'config', 'user.email', 'fixture@example.invalid']);
    await execa('git', ['-C', junctionRealTarget, 'add', '-A']);
    await execa('git', ['-C', junctionRealTarget, 'commit', '-m', 'chore: initial linked fixture']);
    await symlink(junctionRealTarget, junctionLinkTarget, process.platform === 'win32' ? 'junction' : 'dir');
    const paths = runPaths(junctionLinkTarget);
    await ensureRunDirs(paths);
    await ensureGitRepo(paths, config);
  } finally {
    await rm(junctionLinkTarget, { recursive: true, force: true });
    await rm(junctionRealTarget, { recursive: true, force: true });
  }
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
