import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSampleTarget } from '../sample.js';
import { ensureRunDirs, runPaths, schemaPath } from '../shared/paths.js';
import type { GoalFile, WiCiConfig } from '../shared/types.js';
import { buildInitialPlannerArgs, buildPlanDiffArgs } from '../supervisor/planner.js';
import { runExecutorStep } from '../supervisor/executor.js';
import { formatSafetyForPrompt } from '../supervisor/safety.js';

const target = resolve('fixture/safety-prompts-target');

async function main(): Promise<void> {
  const config = testConfig();
  const safetyText = formatSafetyForPrompt(config);
  assert(safetyText.includes('disposable VM only'), `safety text missing container hint: ${safetyText}`);
  assert(safetyText.includes('Forbidden action: git push'), `safety text missing git push ban: ${safetyText}`);
  assert(safetyText.includes('Forbidden action: rm -rf outside workspace'), `safety text missing rm -rf ban: ${safetyText}`);
  assert(safetyText.includes('Forbidden action: production credentials'), `safety text missing credential ban: ${safetyText}`);

  const initialArgs = buildInitialPlannerArgs({
    goalText: 'optimize safely',
    schema: await readFile(schemaPath('plan'), 'utf8'),
    effort: 'max',
    systemPrompt: 'planner-system',
    safetyText
  });
  const initialSystem = argAfter(initialArgs, '--append-system-prompt');
  assert(initialSystem.includes('planner-system'), 'initial planner system prompt lost base prompt');
  assert(initialSystem.includes('Forbidden action: git push'), 'initial planner system prompt missing safety list');
  assert(initialArgs.includes('Bash(git push *)'), 'initial planner missing git push disallowed tool');

  const diffArgs = buildPlanDiffArgs({
    newText: 'new safety-sensitive requirement',
    currentPlan: '# plan',
    goal: goal(),
    sessionId: 'session-1',
    schema: await readFile(schemaPath('plan-diff'), 'utf8'),
    systemPrompt: 'diff-system',
    safetyText
  });
  const diffSystem = argAfter(diffArgs, '--append-system-prompt');
  assert(diffSystem.includes('diff-system'), 'plan diff system prompt lost base prompt');
  assert(diffSystem.includes('Forbidden action: production credentials'), 'plan diff system prompt missing safety list');

  await createSampleTarget(target, true);
  const paths = runPaths(target);
  await ensureRunDirs(paths);
  await runExecutorStep(paths, goal(), 'S1', 1, config, undefined, undefined);
  const executorPrompt = await readFile(join(paths.artifacts, 'iter-1.prompt.txt'), 'utf8');
  assert(executorPrompt.includes('WiCi safety constraints for this autonomous run'), 'executor prompt missing safety header');
  assert(executorPrompt.includes('Forbidden action: git push'), 'executor prompt missing git push ban');
  assert(executorPrompt.includes('Forbidden action: production credentials'), 'executor prompt missing credential ban');
  assert(executorPrompt.includes('Use the target repository as the only workspace.'), 'executor prompt missing workspace boundary');

  const status = await git(['status', '--short']);
  assert(status.trim() === 'M src/hotpath.js' || status.trim() === '', `unexpected target worktree status after direct executor prompt test:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        planner_safety_prompt: true,
        executor_safety_prompt: true,
        disallowed_tools: true
      },
      null,
      2
    )
  );
}

function argAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  assert(index >= 0 && index + 1 < args.length, `missing ${flag} in ${args.join(' ')}`);
  return args[index + 1];
}

function goal(): GoalFile {
  return {
    run_id: 'safety-prompts-run',
    version: 1,
    requirements: [{ id: 'R1', text: 'Optimize without unsafe actions', source: 'initial', status: 'active' }],
    acceptance_criteria: [{ id: 'A1', text: 'checks pass', check: './.opt/checks.sh' }],
    constraints: [],
    metric: { name: 'p99 latency', direction: 'minimize', target: null, unit: 'ms' },
    budget: { max_iters: 1, max_cost_usd: 1, deadline: null },
    stop: { tau: 0.01, K: 1, N: 1, mode: 'auto' }
  };
}

function testConfig(): WiCiConfig {
  return {
    tools: {
      mode: 'stub',
      planner: { command: 'claude', effort: 'max', dangerouslySkipPermissions: true },
      executor: { command: 'codex', dangerouslyBypassApprovalsAndSandbox: true }
    },
    budget: { max_iters: 1, max_cost_usd: 1, deadline: null },
    stop: { tau: 0.01, K: 1, N: 1, mode: 'auto' },
    retry: { max_attempts_per_step: 2, reverts_before_reset: 5, stall_replan_after: 3 },
    diversity: { avenues: ['algorithmic complexity'] },
    evaluation: { noise_threshold: 0.01, min_reps: 5, bootstrap_resamples: 1000, checks_timeout_ms: 300000, measure_timeout_ms: 300000 },
    git: { init_if_missing: false, user_name: 'WiCi Bot', user_email: 'wici@example.invalid' },
    safety: {
      container_hint: 'disposable VM only',
      forbidden_actions: ['git push', 'rm -rf outside workspace', 'production credentials']
    }
  };
}

async function git(args: string[]): Promise<string> {
  const { execa } = await import('execa');
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
