import { assertRealToolsReady, parseClaudeProbeError } from '../supervisor/selfupdate.js';
import type { ToolHealthReport } from '../supervisor/selfupdate.js';
import type { WiCiConfig } from '../shared/types.js';

function main(): void {
  const notLoggedIn = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: 'Not logged in · Please run /login'
  });
  assert(parseClaudeProbeError(notLoggedIn, 1)?.includes('Not logged in'), 'expected not logged in probe to be reported');
  assert(parseClaudeProbeError(JSON.stringify({ is_error: false, result: { ok: true } }), 0) === undefined, 'expected successful probe to pass');
  assert(parseClaudeProbeError('', 1)?.includes('exited with code 1'), 'expected empty non-zero probe to fail');

  expectThrows(
    () => assertRealToolsReady(fakeConfig('real'), fakeReport('Not logged in · Please run /login')),
    'Real mode requires healthy tools'
  );
  assertRealToolsReady(fakeConfig('auto'), fakeReport('Not logged in · Please run /login'));

  console.log(
    JSON.stringify(
      {
        ok: true,
        not_logged_in_detected: true,
        real_mode_rejects_unhealthy_claude: true
      },
      null,
      2
    )
  );
}

function fakeConfig(mode: WiCiConfig['tools']['mode']): WiCiConfig {
  return {
    tools: {
      mode,
      planner: { command: 'claude', effort: 'max' },
      executor: { command: 'codex', dangerouslyBypassApprovalsAndSandbox: true }
    },
    budget: { max_iters: 20, max_cost_usd: 1, deadline: null },
    stop: { tau: 0.01, K: 3, N: 4, mode: 'auto' },
    retry: { max_attempts_per_step: 2, reverts_before_reset: 5, stall_replan_after: 3 },
    diversity: { avenues: ['algorithmic complexity', 'data structure change'] },
    evaluation: { noise_threshold: 0.01, min_reps: 5, bootstrap_resamples: 1000, checks_timeout_ms: 300000, measure_timeout_ms: 300000 },
    git: { init_if_missing: false, user_name: 'WiCi Test', user_email: 'wici-test@example.invalid' },
    safety: { container_hint: 'test', forbidden_actions: [] }
  };
}

function fakeReport(claudeError: string): ToolHealthReport {
  return {
    codex: { command: 'codex', available: true, version: 'codex-cli 0.139.0' },
    claude: { command: 'claude', available: true, version: '2.1.162 (Claude Code)', error: claudeError }
  };
}

function expectThrows(fn: () => void, expected: string): void {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(expected)) return;
    throw new Error(`Expected error containing "${expected}", got "${message}"`);
  }
  throw new Error(`Expected error containing "${expected}"`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

main();
