import { resolve } from 'node:path';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import type { GoalFile, WiCiConfig } from '../shared/types.js';
import { runExecutorStep } from '../supervisor/executor.js';
import { runInitialPlanner, runPlanDiff } from '../supervisor/planner.js';

const target = resolve('fixture/real-mode-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  const config = fakeRealConfig();
  const goal = fakeGoal();

  await expectRejects(() => runInitialPlanner(paths, goal, config), 'Planner command not found in real mode');
  await expectRejects(() => runPlanDiff(paths, goal, undefined, 'new requirement', config), 'Planner command not found in real mode');
  await expectRejects(() => runExecutorStep(paths, goal, 'S1', 1, config), 'Executor command not found in real mode');

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        real_mode_does_not_fallback_to_stub: true
      },
      null,
      2
    )
  );
}

function fakeRealConfig(): WiCiConfig {
  return {
    tools: {
      mode: 'real',
      planner: {
        command: 'definitely-missing-claude-for-wici-test',
        effort: 'max',
        dangerouslySkipPermissions: true
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
    diversity: {
      avenues: ['algorithmic complexity', 'data structure change']
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
    metric: { name: 'p99', direction: 'minimize', target: null, unit: 'ms' },
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
