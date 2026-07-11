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
  codexUpdateInvocation,
  detectCodexInstallMethod,
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
    github: 'gh version 2.0.0',
    checked_at: '2026-06-14T00:00:00.000Z'
  });

  const externalDrift = reconcileToolVersionDrift(active, {
    mode: 'real',
    codex: 'codex-cli 0.140.0',
    claude: '2.1.178 (Claude Code)',
    github: 'gh version 2.1.0',
    checked_at: new Date().toISOString()
  });
  assert(
    externalDrift.accepted.includes('codex codex-cli 0.139.0 -> codex-cli 0.140.0') &&
      externalDrift.accepted.includes('claude 2.1.162 (Claude Code) -> 2.1.178 (Claude Code)') &&
      externalDrift.accepted.includes('github gh version 2.0.0 -> gh version 2.1.0'),
    `expected Codex/Claude/GitHub CLI drift to be accepted, got ${JSON.stringify(externalDrift)}`
  );
  assertNoActiveToolVersionDrift(active, {
    mode: 'real',
    codex: 'codex-cli 0.140.0',
    claude: '2.1.178 (Claude Code)',
    github: 'gh version 2.1.0',
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
  const acceptedWiCiBoundary = reconcileToolVersionDrift(
    wiciPinned,
    {
      mode: 'stub',
      wici: {
        package_version: '0.1.1',
        git_commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        git_dirty: true
      },
      checked_at: new Date().toISOString()
    },
    { allowWiCiBoundary: true }
  );
  assert(
    acceptedWiCiBoundary.accepted.some((item) => item.includes('wici package')) &&
      acceptedWiCiBoundary.accepted.some((item) => item.includes('wici git')) &&
      acceptedWiCiBoundary.accepted.some((item) => item.includes('wici dirty')),
    `expected explicit resume boundary to accept WiCi drift, got ${JSON.stringify(acceptedWiCiBoundary)}`
  );
  const acceptedRuntimeBoundary = reconcileToolVersionDrift(
    checkpoint('EXECUTE', {
      mode: 'auto',
      wici: {
        package_version: '0.1.1',
        git_commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        git_dirty: false
      },
      checked_at: '2026-06-14T00:00:00.000Z'
    }),
    {
      mode: 'real',
      wici: {
        package_version: '0.1.1',
        git_commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        git_dirty: false
      },
      checked_at: new Date().toISOString()
    },
    { allowWiCiBoundary: true }
  );
  assert(
    acceptedRuntimeBoundary.accepted.some((item) => item === 'mode auto -> real'),
    `expected explicit resume boundary to accept runtime mode drift, got ${JSON.stringify(acceptedRuntimeBoundary)}`
  );

  const stopped = checkpoint('STOP', active.tool_versions!);
  assertNoActiveToolVersionDrift(stopped, {
    mode: 'real',
    codex: 'codex-cli 0.140.0',
    claude: '2.1.200 (Claude Code)',
    github: 'gh version 2.1.0',
    checked_at: new Date().toISOString()
  });

  const unpinned = checkpoint('EXECUTE', undefined);
  assertNoActiveToolVersionDrift(unpinned, {
    mode: 'real',
    codex: 'codex-cli 0.140.0',
    claude: '2.1.200 (Claude Code)',
    github: 'gh version 2.1.0',
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
  assert(shouldAutoUpdateToolsAtBoundary(fakeConfig('real'), checkpoint('EXECUTE', active.tool_versions!)) === false, 'active runs should not invoke tool updaters without a new resume boundary');
  assert(
    shouldAutoUpdateToolsAtBoundary(fakeConfig('real'), checkpoint('PLAN', active.tool_versions!), { resumePreflight: true }) === true,
    'explicit resume boundaries should auto-update tools before relaunching planner or executor work'
  );
  assert(shouldAutoUpdateToolsAtBoundary({ ...fakeConfig('real'), tools: { ...fakeConfig('real').tools, auto_update: false } }, stopped) === false, 'auto-update can be disabled');
  const updateCalls = await runFakeToolUpdaterCheck();
  assert(updateCalls.some((call) => call.tool === 'npm' && call.args.join(' ') === 'install -g @openai/codex@latest'), `npm Codex updater was not called: ${JSON.stringify(updateCalls)}`);
  assert(updateCalls.some((call) => call.tool === 'claude' && call.args[0] === 'update'), `claude updater was not called: ${JSON.stringify(updateCalls)}`);
  assert(
    codexUpdateInvocation('standalone', 'win32').args.at(-1)?.includes('https://chatgpt.com/codex/install.ps1'),
    'Windows standalone Codex updates should use the official PowerShell installer'
  );
  assert(
    codexUpdateInvocation('standalone', 'linux').args.at(-1)?.includes('https://chatgpt.com/codex/install.sh'),
    'macOS/Linux standalone Codex updates should use the official shell installer'
  );
  const detectedNpmCodex = await detectCodexInstallMethod(async (command, args) => ({
    exitCode: command === 'npm' && args.includes('@openai/codex') ? 0 : 1,
    stdout: command === 'npm' ? JSON.stringify({ dependencies: { '@openai/codex': { version: '9.0.0' } } }) : '',
    all: ''
  }));
  assert(detectedNpmCodex === 'npm', `global @openai/codex installs should select the npm updater, got ${detectedNpmCodex}`);

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
        wici_drift_resume_boundary_accepted: true,
        mode_drift_resume_boundary_accepted: true,
        wici_version_recorded: true,
        stopped_drift_allowed: true,
        unpinned_allowed: true,
        boundary_auto_update: true,
        resume_boundary_auto_update: true,
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
    config.tools.chat = { command: claude };
    config.tools.planner.command = codex;
    config.tools.executor.command = codex;
    const updateCalls: Array<{ tool: string; args: string[] }> = [];
    const report = await updateToolsBetweenRuns(config, {
      detectCodexInstallMethod: async () => 'npm',
      runCommand: async (command, args) => {
        updateCalls.push({ tool: command.split(/[\\/]/).at(-1) ?? command, args });
        return { exitCode: 0, stdout: 'updated', all: 'updated' };
      }
    });
    assert(report.codex.command === codex, `Codex health should use the selected Codex command, got ${report.codex.command}`);
    assert(report.claude.command === claude, `Claude health should use the selected Chat Claude command, got ${report.claude.command}`);
    assert(report.codex.update?.ok === true && report.claude.update?.ok === true, 'successful updater results should be attached to tool health');
    const failedOpenReport = await updateToolsBetweenRuns(config, {
      detectCodexInstallMethod: async () => 'npm',
      runCommand: async () => ({ exitCode: 42, stdout: 'simulated updater failure', all: 'simulated updater failure' })
    });
    assert(
      failedOpenReport.codex.available && failedOpenReport.claude.available &&
        failedOpenReport.codex.update?.ok === false && failedOpenReport.codex.update.error?.includes('simulated updater failure') &&
        failedOpenReport.claude.update?.ok === false && failedOpenReport.claude.update.error?.includes('simulated updater failure'),
      'updater failures should fail open while remaining visible in tool health'
    );
    const raw = await readFile(logPath, 'utf8');
    const healthCalls = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { tool: string; args: string[] });
    assert(healthCalls.some((call) => call.tool === 'codex' && call.args[0] === '--version'), 'Codex health check should run after updating');
    assert(healthCalls.some((call) => call.tool === 'claude' && call.args[0] === '--version'), 'Claude health check should run after updating');
    return updateCalls;
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
    },
    github: {
      command: 'gh',
      available: true,
      version: 'gh version 2.0.0'
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
