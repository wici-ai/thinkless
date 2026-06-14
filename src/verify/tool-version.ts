import type { Checkpoint } from '../shared/types.js';
import {
  assertNoActiveToolVersionDrift,
  assertNoPendingToolUpdatesForLongRun,
  parseCodexUpdatePending,
  toolVersionsFromHealth
} from '../supervisor/selfupdate.js';
import type { ToolHealthReport } from '../supervisor/selfupdate.js';
import type { WiCiConfig } from '../shared/types.js';

async function main(): Promise<void> {
  const active = checkpoint('EXECUTE', {
    mode: 'real',
    codex: 'codex-cli 0.139.0',
    claude: '2.1.162 (Claude Code)',
    checked_at: '2026-06-14T00:00:00.000Z'
  });

  expectThrows(
    () =>
      assertNoActiveToolVersionDrift(active, {
        mode: 'real',
        codex: 'codex-cli 0.140.0',
        claude: '2.1.162 (Claude Code)',
        checked_at: new Date().toISOString()
      }),
    'Tool version drift detected during active run'
  );

  const wiciPinned = checkpoint('EXECUTE', {
    mode: 'stub',
    wici: {
      package_version: '0.1.0',
      git_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      git_dirty: false
    },
    checked_at: '2026-06-14T00:00:00.000Z'
  });
  expectThrows(
    () =>
      assertNoActiveToolVersionDrift(wiciPinned, {
        mode: 'stub',
        wici: {
          package_version: '0.1.0',
          git_commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          git_dirty: false
        },
        checked_at: new Date().toISOString()
      }),
    'wici git'
  );

  const stopped = checkpoint('STOP', active.tool_versions!);
  assertNoActiveToolVersionDrift(stopped, {
    mode: 'real',
    codex: 'codex-cli 0.140.0',
    claude: '2.1.200 (Claude Code)',
    checked_at: new Date().toISOString()
  });

  const unpinned = checkpoint('EXECUTE', undefined);
  assertNoActiveToolVersionDrift(unpinned, {
    mode: 'real',
    codex: 'codex-cli 0.140.0',
    claude: '2.1.200 (Claude Code)',
    checked_at: new Date().toISOString()
  });

  assert(parseCodexUpdatePending('latest version status    current version is not older') === false, 'expected current codex doctor status to parse as no pending update');
  assert(parseCodexUpdatePending('latest version status    current version is older') === true, 'expected older codex doctor status to parse as pending update');
  assert(
    parseCodexUpdatePending('version                  0.139.0\nlatest version           0.140.0') === true,
    'expected latest version greater than current to parse as pending update'
  );
  expectThrows(
    () => assertNoPendingToolUpdatesForLongRun(fakeConfig('auto'), fakeReport(true), 2),
    'Refusing to start long run because tool update is pending'
  );
  assertNoPendingToolUpdatesForLongRun(fakeConfig('auto'), fakeReport(true), 1);
  assertNoPendingToolUpdatesForLongRun(fakeConfig('stub'), fakeReport(true), 20);

  const current = await toolVersionsFromHealth(fakeConfig('stub'), null);
  assert(current.wici?.package_version === '0.1.0', `expected WiCi package version 0.1.0, got ${current.wici?.package_version}`);
  assert(
    current.wici?.git_commit === null || /^[0-9a-f]{40}$/.test(current.wici?.git_commit ?? ''),
    `unexpected WiCi git commit: ${current.wici?.git_commit}`
  );
  assert(typeof current.wici?.git_dirty === 'boolean' || current.wici?.git_dirty === undefined, 'WiCi dirty flag must be boolean when git is available');

  console.log(
    JSON.stringify(
      {
        ok: true,
        active_drift_rejected: true,
        wici_drift_rejected: true,
        wici_version_recorded: true,
        stopped_drift_allowed: true,
        unpinned_allowed: true,
        pending_update_gate_verified: true
      },
      null,
      2
    )
  );
}

function checkpoint(state: Checkpoint['supervisor_state'], toolVersions: Checkpoint['tool_versions']): Checkpoint {
  return {
    supervisor_state: state,
    next_step: state === 'EXECUTE' ? 'S1' : null,
    iter: 1,
    goal_version: 1,
    plan_hash: null,
    ledger_seq: 0,
    events_seq: 0,
    sessions: {},
    tool_versions: toolVersions,
    drained_inbox: [],
    updated_at: new Date().toISOString()
  };
}

function fakeReport(updatePending: boolean): ToolHealthReport {
  return {
    codex: {
      command: 'codex',
      available: true,
      version: 'codex-cli 0.139.0',
      updatePending
    },
    claude: {
      command: 'claude',
      available: true,
      version: '2.1.162 (Claude Code)'
    }
  };
}

function fakeConfig(mode: WiCiConfig['tools']['mode']): WiCiConfig {
  return {
    tools: {
      mode,
      planner: { command: 'claude', effort: 'max', dangerouslySkipPermissions: true },
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

await main();
