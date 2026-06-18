import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandExists } from '../shared/commands.js';
import type { Checkpoint } from '../shared/types.js';
import {
  assertNoActiveToolVersionDrift,
  assertRealToolsReady,
  parseCodexDoctorError,
  parseCodexUpdatePending,
  reconcileToolVersionDrift,
  shouldAutoUpdateToolsAtBoundary,
  toolVersionsFromHealth,
  updateToolsBetweenRuns
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

  const externalDrift = reconcileToolVersionDrift(active, {
    mode: 'real',
    codex: 'codex-cli 0.140.0',
    claude: '2.1.178 (Claude Code)',
    checked_at: new Date().toISOString()
  });
  assert(
    externalDrift.accepted.includes('codex codex-cli 0.139.0 -> codex-cli 0.140.0') &&
      externalDrift.accepted.includes('claude 2.1.162 (Claude Code) -> 2.1.178 (Claude Code)'),
    `expected Codex/Claude drift to be accepted, got ${JSON.stringify(externalDrift)}`
  );
  assertNoActiveToolVersionDrift(active, {
    mode: 'real',
    codex: 'codex-cli 0.140.0',
    claude: '2.1.178 (Claude Code)',
    checked_at: new Date().toISOString()
  });

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
    parseCodexDoctorError('16 ok · 1 idle · 1 notes · 1 warn · 0 fail degraded', 1) === undefined,
    'optional Codex doctor warnings must not block real mode'
  );
  assert(
    parseCodexDoctorError('15 ok · 1 fail degraded', 1) === 'tool reported a non-zero health check',
    'degraded Codex doctor failures should still be captured as diagnostics'
  );
  assertRealToolsReady(fakeConfig('real'), {
    ...fakeReport(false),
    codex: {
      ...fakeReport(false).codex,
      doctorError: 'tool reported a non-zero health check'
    }
  });
  expectThrows(
    () =>
      assertRealToolsReady(fakeConfig('real'), {
        ...fakeReport(false),
        codex: {
          ...fakeReport(false).codex,
          error: 'tool reported a non-zero version check'
        }
      }),
    'Real mode requires healthy tools'
  );
  assert(
    parseCodexUpdatePending('version                  0.139.0\nlatest version           0.140.0') === true,
    'expected latest version greater than current to parse as pending update'
  );
  assert(fakeReport(true).codex.updatePending === true, 'pending updates should be reported for operator visibility, not used as a supervisor start gate');
  assert(shouldAutoUpdateToolsAtBoundary(fakeConfig('real'), checkpoint('STOP', active.tool_versions!)) === true, 'stopped runs should auto-update tools before the next run');
  assert(shouldAutoUpdateToolsAtBoundary(fakeConfig('real'), checkpoint('FAILED', active.tool_versions!)) === true, 'failed runs should auto-update tools before the next run');
  assert(shouldAutoUpdateToolsAtBoundary(fakeConfig('real'), checkpoint('EXECUTE', active.tool_versions!)) === false, 'active runs should not invoke tool updaters');
  assert(shouldAutoUpdateToolsAtBoundary({ ...fakeConfig('real'), tools: { ...fakeConfig('real').tools, auto_update: false } }, stopped) === false, 'auto-update can be disabled');
  const updateCalls = await runFakeToolUpdaterCheck();
  assert(updateCalls.some((call) => call.tool === 'codex' && call.args[0] === 'update'), `codex updater was not called: ${JSON.stringify(updateCalls)}`);
  assert(updateCalls.some((call) => call.tool === 'claude' && call.args[0] === 'update'), `claude updater was not called: ${JSON.stringify(updateCalls)}`);

  const current = await toolVersionsFromHealth(fakeConfig('stub'), null);
  const packageVersion = await readPackageVersion();
  assert(current.wici?.package_version === packageVersion, `expected WiCi package version ${packageVersion}, got ${current.wici?.package_version}`);
  assert(
    current.wici?.git_commit === null || /^[0-9a-f]{40}$/.test(current.wici?.git_commit ?? ''),
    `unexpected WiCi git commit: ${current.wici?.git_commit}`
  );
  assert(typeof current.wici?.git_dirty === 'boolean' || current.wici?.git_dirty === undefined, 'WiCi dirty flag must be boolean when git is available');

  console.log(
    JSON.stringify(
      {
        ok: true,
        external_tool_drift_accepted: true,
        wici_drift_rejected: true,
        wici_version_recorded: true,
        stopped_drift_allowed: true,
        unpinned_allowed: true,
        boundary_auto_update: true,
        tool_updaters_called: true,
        pending_update_reported_not_gated: true,
        optional_doctor_warning_allowed: true
      },
      null,
      2
    )
  );
}

async function runFakeToolUpdaterCheck(): Promise<Array<{ tool: string; args: string[] }>> {
  const dir = await mkdtemp(join(tmpdir(), 'wici-tool-version-'));
  try {
    const logPath = join(dir, 'calls.jsonl');
    const codex = join(dir, 'codex');
    const claude = join(dir, 'claude');
    await writeFakeTool(codex, 'codex', 'codex-cli 9.0.0', logPath);
    await writeFakeTool(claude, 'claude', '9.0.0 (Claude Code)', logPath);
    assert(await commandExists(codex), 'shared command resolver should find explicit fake Codex path');
    assert(await commandExists(claude), 'shared command resolver should find explicit fake Claude path');
    assert(!(await commandExists(join(dir, 'missing-tool'))), 'shared command resolver should reject missing explicit paths');
    const config = fakeConfig('real');
    config.tools.executor.command = codex;
    config.tools.planner.command = claude;
    await updateToolsBetweenRuns(config);
    const raw = await readFile(logPath, 'utf8');
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { tool: string; args: string[] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeFakeTool(path: string, tool: string, version: string, logPath: string): Promise<void> {
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      "const { appendFileSync } = require('node:fs');",
      `const tool = ${JSON.stringify(tool)};`,
      `const version = ${JSON.stringify(version)};`,
      `const logPath = ${JSON.stringify(logPath)};`,
      'const args = process.argv.slice(2);',
      "appendFileSync(logPath, JSON.stringify({ tool, args }) + '\\n');",
      "if (args[0] === '--version') { console.log(version); process.exit(0); }",
      "if (args[0] === 'doctor') { console.log('16 ok - 0 fail degraded'); process.exit(0); }",
      "if (args[0] === 'update') { console.log('updated'); process.exit(0); }",
      'console.log("ok");'
    ].join('\n') + '\n'
  );
  await chmod(path, 0o755);
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
      auto_update: true,
      planner: { command: 'claude', effort: 'default' },
      executor: { command: 'codex', dangerouslyBypassApprovalsAndSandbox: true }
    },
    budget: { max_iters: 20, max_cost_usd: 1, deadline: null },
    stop: { tau: 0.01, K: 3, N: 4, mode: 'auto' },
    retry: { max_attempts_per_step: 2, reverts_before_reset: 5, stall_replan_after: 3 },
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

async function readPackageVersion(): Promise<string | undefined> {
  return (JSON.parse(await readFile('package.json', 'utf8')) as { version?: string }).version;
}

await main();
