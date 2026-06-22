#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { App } from './tui/App.js';
import { DISABLE_POINTER_INPUT_SEQUENCE, ENABLE_MOUSE_REPORTING_SEQUENCE } from './tui/input.js';
import { installTuiInputTrace } from './tui/inputTrace.js';
import { runSupervisor } from './supervisor/index.js';
import { createSampleTarget } from './sample.js';
import type { ToolMode } from './shared/types.js';
import { loadConfig } from './shared/config.js';
import { allocateNumberedSessionDir, isNumberedSessionDirName, latestNumberedSessionDir, runPaths, THINKLESS_SESSION_DIR_ENV, TOOL_ROOT } from './shared/paths.js';
import { installCrashHandlers } from './shared/crashHandlers.js';
import { previewRollback, rollbackTarget } from './supervisor/rollback.js';
import { checkToolHealth, runThinklessStartupSelfUpdate, updateToolsBetweenRuns, type ThinklessSelfUpdateResult } from './supervisor/selfupdate.js';

const program = new Command();
const DEFAULT_DEMO_TARGET = 'fixture/demo-target';
const WORKSPACE_ROOT = join(homedir(), 'thinkless-workspaces');
const TARGET_OPTION_DESCRIPTION = 'target repository';
const RESUME_TARGET_OPTION_DESCRIPTION = 'target repository to resume (defaults to current Thinkless run, then latest Thinkless workspace)';

program.name('thinkless').description('Autonomous long-horizon coding TUI orchestrator').version(readPackageVersionSync());

program
  .command('sample')
  .description('Create the fixture target repository')
  .option('--target <path>', 'target directory', 'fixture/slow-target')
  .option('--force', 'recreate the fixture target', false)
  .action(async (options: { target: string; force: boolean }) => {
    const target = await createSampleTarget(options.target, options.force);
    console.log(target);
  });

program
  .command('run')
  .description('Run the supervisor headlessly')
  .requiredOption('--target <path>', TARGET_OPTION_DESCRIPTION)
  .option('--goal <text>', 'initial goal')
  .option('--once', 'run one iteration', false)
  .option('--max-iters <n>', 'max iterations', (value) => Number(value))
  .option('--resume-iteration <n>', 'load checkpoint snapshot for iteration N before running', parseNonNegativeInteger)
  .option('--mode <mode>', 'tool mode: real, auto, or stub', 'auto')
  .option('--lock-mode <mode>', 'eval lock mode: auto or manual')
  .action(async (options: { target: string; goal?: string; once: boolean; maxIters?: number; resumeIteration?: number; mode: ToolMode; lockMode?: 'auto' | 'manual' }) => {
    const result = await runSupervisor({
      target: resolve(options.target),
      goal: options.goal,
      goalSource: options.goal ? 'cli_goal' : undefined,
      once: options.once,
      maxIters: options.maxIters,
      resumeIteration: options.resumeIteration,
      mode: options.mode,
      lockMode: options.lockMode
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.state === 'FAILED' ? 1 : 0;
  });

program
  .command('tui', { isDefault: true })
  .description('Open a fresh Chat-first TUI workspace')
  .option('--target <path>', 'target workspace (defaults to the current git repository, or a new isolated workspace outside git)')
  .option('--goal <text>', 'initial goal')
  .option('--max-iters <n>', 'max iterations', (value) => Number(value))
  .option('--resume-iteration <n>', 'load checkpoint snapshot for iteration N before running', parseNonNegativeInteger)
  .option('--mode <mode>', 'tool mode: real, auto, or stub', 'auto')
  .option('--lock-mode <mode>', 'eval lock mode: auto or manual')
  .option('--no-supervisor', 'do not start the supervisor loop')
  .option('--no-fullscreen', 'render without fullscreen mode')
  .option('--mouse-reporting', 'enable mouse wheel/click tracking; disables native terminal text selection', false)
  .action((options: TuiCommandOptions) => {
    launchTui({ ...options, ...resolveFreshLaunchOption(options.target), resumeOnOpen: false });
  });

program
  .command('resume')
  .description('Resume an existing Thinkless run in the Chat-first TUI')
  .option('--target <path>', RESUME_TARGET_OPTION_DESCRIPTION)
  .option('--max-iters <n>', 'max iterations', (value) => Number(value))
  .option('--resume-iteration <n>', 'load checkpoint snapshot for iteration N before running', parseNonNegativeInteger)
  .option('--mode <mode>', 'tool mode: real, auto, or stub', 'auto')
  .option('--lock-mode <mode>', 'eval lock mode: auto or manual')
  .option('--no-supervisor', 'do not start the supervisor loop')
  .option('--no-fullscreen', 'render without fullscreen mode')
  .option('--mouse-reporting', 'enable mouse wheel/click tracking; disables native terminal text selection', false)
  .action((options: TuiCommandOptions) => {
    launchTui({ ...options, ...resolveResumeLaunchOption(options.target), resumeOnOpen: true });
  });

program
  .command('demo')
  .description('Create or reopen a sample target in the Chat-first TUI')
  .option('--target <path>', 'target directory', DEFAULT_DEMO_TARGET)
  .option('--fresh', 'recreate the target before opening', false)
  .option('--max-iters <n>', 'max iterations', (value) => Number(value))
  .option('--mode <mode>', 'tool mode: real, auto, or stub', 'stub')
  .option('--lock-mode <mode>', 'eval lock mode: auto or manual')
  .option('--no-fullscreen', 'render without fullscreen mode')
  .option('--mouse-reporting', 'enable mouse wheel/click tracking; disables native terminal text selection', false)
  .action(async (options: { target: string; fresh: boolean; maxIters?: number; mode: ToolMode; lockMode?: 'auto' | 'manual'; fullscreen: boolean; mouseReporting: boolean }) => {
    const targetArg = options.target || DEFAULT_DEMO_TARGET;
    const force = options.fresh;
    const target = await createSampleTarget(targetArg, force);
    renderTui({
      target,
      maxIters: options.maxIters,
      mode: options.mode,
      lockMode: options.lockMode,
      supervisor: true,
      resumeOnOpen: false,
      fullscreen: options.fullscreen,
      mouseReporting: options.mouseReporting
    });
  });

program
  .command('smoke')
  .description('Create the fixture and run one stubbed supervisor iteration')
  .option('--target <path>', 'target directory', 'fixture/slow-target')
  .action(async (options: { target: string }) => {
    const target = await createSampleTarget(options.target, true);
    const result = await runSupervisor({
      target,
      goal: 'Improve uniqueSorted while preserving exact sorted unique output.',
      goalSource: 'cli_goal',
      once: true,
      maxIters: 1,
      mode: 'stub'
    });
    console.log(JSON.stringify({ target, ...result }, null, 2));
    process.exitCode = result.state === 'FAILED' ? 1 : 0;
  });

program
  .command('doctor')
  .description('Check codex/claude reachability and optionally update between runs')
  .option('--mode <mode>', 'tool mode: real, auto, or stub', 'auto')
  .option('--update', 'run tool updaters before reporting health', false)
  .option('--deep', 'run a Claude print-mode auth probe', false)
  .action(async (options: { mode: ToolMode; update: boolean; deep: boolean }) => {
    const config = await loadConfig(options.mode);
    const report = options.update ? await updateToolsBetweenRuns(config) : await checkToolHealth(config, { probeClaude: options.deep });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.codex.available && report.claude.available && report.github.available && !report.codex.error && !report.claude.error && !report.github.error ? 0 : 1;
  });

program
  .command('rollback')
  .description('Preview or execute target rollback to the best WiCi commit')
  .requiredOption('--target <path>', 'target repository')
  .option('--confirm', 'execute git reset --hard and git clean -fd for the target', false)
  .action(async (options: { target: string; confirm: boolean }) => {
    const paths = runPaths(resolve(options.target));
    const result = options.confirm ? await rollbackTarget(paths) : await previewRollback(paths);
    console.log(JSON.stringify(result, null, 2));
  });

await maybeRunThinklessStartupSelfUpdate();

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

interface TuiCommandOptions {
  target?: string;
  goal?: string;
  maxIters?: number;
  resumeIteration?: number;
  mode: ToolMode;
  lockMode?: 'auto' | 'manual';
  supervisor: boolean;
  fullscreen: boolean;
  mouseReporting: boolean;
  resumeOnOpen?: boolean;
  sessionDir?: string;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got ${value}`);
  }
  return parsed;
}

async function maybeRunThinklessStartupSelfUpdate(): Promise<void> {
  const result: ThinklessSelfUpdateResult = await runThinklessStartupSelfUpdate().catch((error: unknown): ThinklessSelfUpdateResult => ({
    checked: true,
    action: 'failed-open',
    error: error instanceof Error ? error.message : String(error)
  }));
  if (process.env.THINKLESS_SELF_UPDATE_VERBOSE !== '1') return;
  const detail = result.error ? `: ${result.error}` : result.message ? `: ${result.message}` : '';
  console.error(`thinkless self-update: ${result.action}${detail}`);
}

function launchTui(options: TuiCommandOptions): void {
  const resolvedTarget = options.target ? resolve(options.target) : resolveFreshTargetOption(undefined);
  const sessionDir = options.sessionDir ?? join(resolvedTarget, '.thinkless');
  if (sessionDir) process.env[THINKLESS_SESSION_DIR_ENV] = sessionDir;
  else delete process.env[THINKLESS_SESSION_DIR_ENV];
  renderTui({
    target: resolvedTarget,
    sessionDir,
    goal: options.goal,
    maxIters: options.maxIters,
    resumeIteration: options.resumeIteration,
    mode: options.mode,
    lockMode: options.lockMode,
    supervisor: options.supervisor,
    resumeOnOpen: options.resumeOnOpen ?? false,
    fullscreen: options.fullscreen,
    mouseReporting: options.mouseReporting
  });
}

function resolveFreshLaunchOption(target?: string): { target: string; sessionDir?: string } {
  if (target?.trim()) return { target: resolve(target) };
  const resolvedTarget = resolveFreshTargetOption(undefined);
  return {
    target: resolvedTarget,
    sessionDir: allocateNumberedSessionDir(resolvedTarget)
  };
}

function resolveFreshTargetOption(target?: string): string {
  if (target?.trim()) return resolve(target);
  const currentRepo = gitTopLevelSync();
  if (currentRepo) return resolve(currentRepo);
  return defaultFreshTarget();
}

function resolveResumeLaunchOption(target?: string): { target: string; sessionDir?: string } {
  const resolvedTarget = resolveResumeTargetOption(target);
  const normalized = normalizeTargetAndSession(resolvedTarget);
  return {
    target: normalized.target,
    sessionDir: normalized.sessionDir ?? latestNumberedSessionDir(normalized.target) ?? undefined
  };
}

function resolveResumeTargetOption(target?: string): string {
  if (target?.trim()) return resolve(target);
  return defaultResumeTarget();
}

function defaultFreshTarget(): string {
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:]/g, '-');
  const source = basename(gitTopLevelSync() ?? process.cwd()) || 'workspace';
  const slug = source.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  const suffix = Math.random().toString(36).slice(2, 8);
  return resolve(WORKSPACE_ROOT, `${stamp}-${slug}-${suffix}`);
}

function defaultResumeTarget(): string {
  const current = defaultCurrentTarget();
  if (hasThinklessRun(current)) return current;
  if (migrateCompatibleWorkspaceRun(current)) return current;
  return latestThinklessWorkspace() ?? current;
}

function defaultCurrentTarget(): string {
  return resolve(gitTopLevelSync() ?? process.cwd());
}

function latestThinklessWorkspace(): string | null {
  try {
    const candidates = readdirSync(WORKSPACE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(WORKSPACE_ROOT, entry.name))
      .filter(hasThinklessRun)
      .map((target) => ({ target, mtimeMs: statSync(target).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0]?.target ?? null;
  } catch {
    return null;
  }
}

function hasThinklessRun(target: string): boolean {
  const paths = runPaths(resolve(target));
  return existsSync(paths.goal) || existsSync(paths.checkpoint) || existsSync(paths.chat);
}

function normalizeTargetAndSession(target: string): { target: string; sessionDir?: string } {
  const resolved = resolve(target);
  if (isNumberedSessionDirName(basename(resolved))) {
    return { target: dirname(resolved), sessionDir: resolved };
  }
  return { target: resolved };
}

function migrateCompatibleWorkspaceRun(current: string): string | null {
  const source = latestWorkspaceForProject(current);
  if (!source) return null;
  const sourcePaths = runPaths(source);
  const targetPaths = runPaths(current);
  if (existsSync(targetPaths.goal) || existsSync(targetPaths.checkpoint)) return null;
  mkdirSync(targetPaths.stateDir, { recursive: true });
  cpSync(sourcePaths.wici, targetPaths.stateDir, { recursive: true, force: true });
  copyIfPresent(join(source, 'GOAL.md'), join(current, 'GOAL.md'));
  writeFileSync(
    join(current, 'PLAN.md'),
    [
      '# Thinkless Execution Plan',
      '',
      `Goal: resume the migrated Thinkless run for ${basename(current)}`,
      '',
      '- [ ] S1 Replan and continue against the real target repository <!-- status:pending migrated-from-fixture:true -->',
      `  - Finding: a legacy isolated workspace at ${source} contained Thinkless state for this project, but its completed PLAN.md came from synthetic fixture work and must not be treated as product completion.`,
      '  - Action: inspect the real repository, replace fixture-only validation or implementation assumptions, and continue from the current GOAL.md against this workspace.',
      '  - Validation: use the project-appropriate checks selected after inspecting the real repository.'
    ].join('\n') + '\n'
  );
  copyIfPresent(join(source, 'ledger.jsonl'), join(current, 'ledger.jsonl'));
  copyIfPresent(join(source, 'baseline.json'), join(current, 'baseline.json'));
  resetMigratedCheckpoint(targetPaths.checkpoint, current, source);
  return source;
}

function latestWorkspaceForProject(current: string): string | null {
  const slug = basename(current).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return null;
  try {
    const candidates = readdirSync(WORKSPACE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().includes(slug))
      .map((entry) => resolve(WORKSPACE_ROOT, entry.name))
      .filter(hasThinklessRun)
      .map((target) => ({ target, mtimeMs: statSync(target).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0]?.target ?? null;
  } catch {
    return null;
  }
}

function copyIfPresent(source: string, target: string): void {
  if (!existsSync(source) || existsSync(target)) return;
  copyFileSync(source, target);
}

function resetMigratedCheckpoint(checkpointPath: string, current: string, source: string): void {
  if (!existsSync(checkpointPath)) return;
  try {
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Record<string, unknown>;
    const sessions = checkpoint.sessions && typeof checkpoint.sessions === 'object' ? checkpoint.sessions as Record<string, unknown> : {};
    checkpoint.supervisor_state = 'PLAN';
    checkpoint.next_step = null;
    checkpoint.updated_at = new Date().toISOString();
    checkpoint.sessions = {
      ...sessions,
      migratedFromWorkspace: source,
      targetWorkspace: current
    };
    writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  } catch {
    return;
  }
}

function gitTopLevelSync(): string | null {
  try {
    const output = execFileSync('git', ['-C', process.cwd(), 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return output.trim() || null;
  } catch {
    return null;
  }
}

function renderTui(options: {
  target: string;
  sessionDir?: string;
  goal?: string;
  maxIters?: number;
  resumeIteration?: number;
  mode?: ToolMode;
  lockMode?: 'auto' | 'manual';
  supervisor: boolean;
  resumeOnOpen?: boolean;
  fullscreen: boolean;
  mouseReporting: boolean;
}): void {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  installCrashHandlers(options.target);
  const cleanupInputTrace = interactive ? installTuiInputTrace(options.target) : () => undefined;
  const tree = (
    <App
      target={options.target}
      sessionDir={options.sessionDir}
      interactive={interactive}
      supervisor={{
        enabled: options.supervisor,
        initialGoal: options.goal,
        maxIters: options.maxIters,
        resumeIteration: options.resumeIteration,
        mode: options.mode,
        lockMode: options.lockMode,
        resumeOnOpen: options.resumeOnOpen ?? false
      }}
      mouseReporting={options.mouseReporting}
    />
  );
  if (options.fullscreen && interactive) {
    renderInAlternateScreen(tree, cleanupInputTrace, options.mouseReporting);
  } else {
    const instance = render(tree, { interactive });
    void instance.waitUntilExit().finally(cleanupInputTrace);
    // Test hook: non-interactive Ink output is only guaranteed after a clean unmount.
    if (process.env.WICI_TUI_RENDER_ONCE === '1') {
      const delayMs = Number(process.env.WICI_TUI_RENDER_ONCE_DELAY_MS ?? 250);
      void instance.waitUntilRenderFlush()
        .then(() => new Promise((resolve) => setTimeout(resolve, Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 250)))
        .then(() => instance.unmount());
    }
  }
}

function renderInAlternateScreen(tree: React.ReactElement, cleanupInputTrace: () => void, mouseReporting: boolean): void {
  const cleanupRawMode = enableRawModeForTerminalInput();
  const pointerSequence = mouseReporting ? `${DISABLE_POINTER_INPUT_SEQUENCE}${ENABLE_MOUSE_REPORTING_SEQUENCE}` : DISABLE_POINTER_INPUT_SEQUENCE;
  writeTerminalControl(`\x1b[?1049h\x1b[2J\x1b[3J\x1b[H\x1b[?25l${pointerSequence}`);
  const instance = render(tree, { interactive: true });
  writeTerminalControl(pointerSequence);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    cleanupInputTrace();
    cleanupRawMode();
    writeTerminalControl(`${DISABLE_POINTER_INPUT_SEQUENCE}\x1b[?25h\x1b[2J\x1b[3J\x1b[H\x1b[?1049l`);
  };
  process.once('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      cleanup();
      process.exit(exitCodeForSignal(signal));
    });
  }
  void instance.waitUntilExit().finally(cleanup);
}

function enableRawModeForTerminalInput(stdin: NodeJS.ReadStream = process.stdin): () => void {
  const wasRaw = stdin.isRaw === true;
  try {
    stdin.setRawMode?.(true);
    stdin.resume();
  } catch {
    // Ink will still attempt to configure stdin; this is a best-effort
    // match for crossterm's raw-mode-before-alt-screen ordering.
  }
  return () => {
    if (wasRaw) return;
    try {
      stdin.setRawMode?.(false);
    } catch {
      // Best-effort terminal state management.
    }
  };
}

function writeTerminalControl(sequence: string): void {
  try {
    writeSync(process.stdout.fd, sequence);
  } catch {
    // Best-effort terminal state management.
  }
}

function exitCodeForSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): number {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 129;
}

function readPackageVersionSync(): string {
  try {
    return (JSON.parse(readFileSync(`${TOOL_ROOT}/package.json`, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
