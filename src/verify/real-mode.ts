import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { ensureRunDirs, ensureTargetGitignore, runPaths } from '../shared/paths.js';
import type { GoalFile, WiCiConfig } from '../shared/types.js';
import { runExecutorStep } from '../supervisor/executor.js';
import { commitAll, ensureGitIdentity, ensureGitRepo } from '../supervisor/gitgate.js';
import { runSupervisor } from '../supervisor/index.js';
import { runInitialPlanner, runPlanDiff } from '../supervisor/planner.js';

const target = resolve('fixture/real-mode-target');
const scratchRoot = join(tmpdir(), `thinkless-real-mode-${process.pid}`);
const emptyTarget = join(scratchRoot, 'empty-target');
const nonGitTarget = join(scratchRoot, 'non-git-target');
const junctionRealTarget = resolve('fixture/real-mode-junction-real-target');
const junctionLinkTarget = resolve('fixture/real-mode-junction-link-target');
const nestedRepoTarget = resolve('fixture/real-mode-nested-root');
const parentWithRepoTarget = join(scratchRoot, 'parent-with-repo');
const siblingRepoTarget = join(scratchRoot, 'sibling-root');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  const config = fakeRealConfig();
  const goal = fakeGoal();

  await verifyFreshTargetGitInit(config);
  await verifyNonEmptyNonGitTargetInitialized(config);
  await verifyLinkedTargetGitRepoAccepted(config);
  await verifyNestedTargetGitRepoAccepted(config);
  await verifyParentTargetFindsNestedRepo(config);
  await verifySiblingTargetFindsAdjacentRepo(config);
  await verifyNonGitSupervisorReachesPlanner();

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
          non_empty_non_git_initialized: true,
          linked_target_git_repo_accepted: true,
          nested_target_git_repo_accepted: true,
          parent_target_finds_nested_repo: true,
          sibling_target_finds_adjacent_repo: true,
          non_git_supervisor_reaches_planner: true,
          real_mode_does_not_fallback_to_stub: true
        },
      null,
      2
    )
  );
}

async function verifyNonGitSupervisorReachesPlanner(): Promise<void> {
  await rm(nonGitTarget, { recursive: true, force: true });
  try {
    await mkdir(nonGitTarget, { recursive: true });
    await writeFile(join(nonGitTarget, 'user-file.txt'), 'user owned file\n');
    const result = await runSupervisor({
      target: nonGitTarget,
      goal: 'Verify non-git targets are prepared instead of rejected before planning.',
      maxIters: 0,
      mode: 'stub'
    });
    if (result.state === 'FAILED') {
      throw new Error(`non-git target should not fail before planner, got ${JSON.stringify(result)}`);
    }
    await execa('git', ['-C', nonGitTarget, 'rev-parse', '--show-toplevel']);
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

async function verifyNestedTargetGitRepoAccepted(config: WiCiConfig): Promise<void> {
  await rm(nestedRepoTarget, { recursive: true, force: true });
  try {
    const nestedTarget = join(nestedRepoTarget, 'packages', 'app');
    await mkdir(nestedTarget, { recursive: true });
    await writeFile(join(nestedRepoTarget, 'README.md'), 'nested target fixture\n');
    await execa('git', ['-C', nestedRepoTarget, 'init']);
    await execa('git', ['-C', nestedRepoTarget, 'config', 'user.name', 'WiCi Fixture']);
    await execa('git', ['-C', nestedRepoTarget, 'config', 'user.email', 'fixture@example.invalid']);
    await execa('git', ['-C', nestedRepoTarget, 'add', '-A']);
    await execa('git', ['-C', nestedRepoTarget, 'commit', '-m', 'chore: initial nested fixture']);

    const paths = runPaths(nestedTarget);
    await ensureRunDirs(paths);
    await ensureGitRepo(paths, config);
    await ensureGitIdentity(paths, config);
    await ensureTargetGitignore(paths);
    await writeFile(paths.plan, '# Plan\n\n- [ ] S1 Nested target plan\n');
    await writeFile(join(nestedRepoTarget, 'root-change.txt'), 'commit from nested target\n');
    await commitAll(paths, 'chore: commit from nested target');

    const gitignore = await readFile(join(nestedRepoTarget, '.gitignore'), 'utf8');
    if (!gitignore.includes('packages/app/.thinkless*/') || !gitignore.includes('packages/app/PLAN.md')) {
      throw new Error(`nested target gitignore did not include scoped Thinkless entries:\n${gitignore}`);
    }
    const committed = await execa('git', ['-C', nestedRepoTarget, 'show', '--name-only', '--format=', 'HEAD']);
    if (!committed.stdout.split('\n').includes('root-change.txt')) {
      throw new Error(`nested target commit did not stage repo-root changes:\n${committed.stdout}`);
    }
    if (committed.stdout.includes('packages/app/PLAN.md') || committed.stdout.includes('packages/app/.thinkless')) {
      throw new Error(`nested target commit included Thinkless state:\n${committed.stdout}`);
    }
  } finally {
    await rm(nestedRepoTarget, { recursive: true, force: true });
  }
}

async function verifyParentTargetFindsNestedRepo(config: WiCiConfig): Promise<void> {
  await rm(parentWithRepoTarget, { recursive: true, force: true });
  try {
    const repo = join(parentWithRepoTarget, 'checkout');
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, 'README.md'), 'nested checkout fixture\n');
    await execa('git', ['-C', repo, 'init']);
    await execa('git', ['-C', repo, 'config', 'user.name', 'WiCi Fixture']);
    await execa('git', ['-C', repo, 'config', 'user.email', 'fixture@example.invalid']);
    await execa('git', ['-C', repo, 'add', '-A']);
    await execa('git', ['-C', repo, 'commit', '-m', 'chore: initial nested checkout']);

    const paths = runPaths(parentWithRepoTarget);
    await ensureRunDirs(paths);
    await ensureGitRepo(paths, config);
    await ensureGitIdentity(paths, config);
    await writeFile(join(repo, 'nested-change.txt'), 'commit from parent target\n');
    await commitAll(paths, 'chore: commit nested checkout from parent target');

    const committed = await execa('git', ['-C', repo, 'show', '--name-only', '--format=', 'HEAD']);
    if (!committed.stdout.split('\n').includes('nested-change.txt')) {
      throw new Error(`parent target did not discover and commit nested repo:\n${committed.stdout}`);
    }
    const parentGit = await execa('git', ['-C', parentWithRepoTarget, 'rev-parse', '--show-toplevel'], { reject: false });
    if (parentGit.exitCode === 0 && (await realpath(resolve(parentGit.stdout.trim()))) === (await realpath(parentWithRepoTarget))) {
      throw new Error('parent target should not be initialized when it contains a usable nested repo');
    }
  } finally {
    await rm(parentWithRepoTarget, { recursive: true, force: true });
  }
}

async function verifySiblingTargetFindsAdjacentRepo(config: WiCiConfig): Promise<void> {
  await rm(siblingRepoTarget, { recursive: true, force: true });
  try {
    const requested = join(siblingRepoTarget, 'requested-dir');
    const repo = join(siblingRepoTarget, 'actual-repo');
    await mkdir(requested, { recursive: true });
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, 'README.md'), 'adjacent repo fixture\n');
    await execa('git', ['-C', repo, 'init']);
    await execa('git', ['-C', repo, 'config', 'user.name', 'WiCi Fixture']);
    await execa('git', ['-C', repo, 'config', 'user.email', 'fixture@example.invalid']);
    await execa('git', ['-C', repo, 'add', '-A']);
    await execa('git', ['-C', repo, 'commit', '-m', 'chore: initial adjacent repo']);

    const paths = runPaths(requested);
    await ensureRunDirs(paths);
    await ensureGitRepo(paths, config);
    await ensureGitIdentity(paths, config);
    await writeFile(join(repo, 'sibling-change.txt'), 'commit from sibling target\n');
    await commitAll(paths, 'chore: commit adjacent repo from sibling target');

    const committed = await execa('git', ['-C', repo, 'show', '--name-only', '--format=', 'HEAD']);
    if (!committed.stdout.split('\n').includes('sibling-change.txt')) {
      throw new Error(`sibling target did not discover and commit adjacent repo:\n${committed.stdout}`);
    }
    const requestedGit = await execa('git', ['-C', requested, 'rev-parse', '--show-toplevel'], { reject: false });
    if (requestedGit.exitCode === 0 && (await realpath(resolve(requestedGit.stdout.trim()))) === (await realpath(requested))) {
      throw new Error('requested sibling directory should not be initialized when an adjacent repo is available');
    }
  } finally {
    await rm(siblingRepoTarget, { recursive: true, force: true });
  }
}

async function verifyFreshTargetGitInit(config: WiCiConfig): Promise<void> {
  await rm(emptyTarget, { recursive: true, force: true });
  try {
    const paths = runPaths(emptyTarget);
    await ensureRunDirs(paths);
    await ensureGitRepo(paths, config);
    const result = await execa('git', ['-C', emptyTarget, 'rev-parse', '--show-toplevel']);
    if (await realpath(resolve(result.stdout.trim())) !== await realpath(emptyTarget)) throw new Error('fresh WiCi target was not initialized as a git top-level');
  } finally {
    await rm(emptyTarget, { recursive: true, force: true });
  }
}

async function verifyNonEmptyNonGitTargetInitialized(config: WiCiConfig): Promise<void> {
  await rm(nonGitTarget, { recursive: true, force: true });
  try {
    await mkdir(nonGitTarget, { recursive: true });
    await writeFile(`${nonGitTarget}/user-file.txt`, 'user owned file\n');
    const paths = runPaths(nonGitTarget);
    await ensureRunDirs(paths);
    await ensureGitRepo(paths, config);
    const result = await execa('git', ['-C', nonGitTarget, 'rev-parse', '--show-toplevel']);
    if (await realpath(resolve(result.stdout.trim())) !== await realpath(nonGitTarget)) throw new Error('non-empty non-git target was not initialized');
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
