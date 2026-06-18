#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { App } from './tui/App.js';
import { DISABLE_MOUSE_REPORTING_SEQUENCE, DISABLE_POINTER_INPUT_SEQUENCE, ENABLE_ALTERNATE_SCROLL_SEQUENCE, ENABLE_MOUSE_REPORTING_SEQUENCE } from './tui/input.js';
import { installTuiInputTrace } from './tui/inputTrace.js';
import { runSupervisor } from './supervisor/index.js';
import { createSampleTarget } from './sample.js';
import type { ToolMode } from './shared/types.js';
import { loadConfig } from './shared/config.js';
import { runPaths, TOOL_ROOT } from './shared/paths.js';
import { installCrashHandlers } from './shared/crashHandlers.js';
import { previewRollback, rollbackTarget } from './supervisor/rollback.js';
import { checkToolHealth, updateToolsBetweenRuns } from './supervisor/selfupdate.js';

const program = new Command();
const DEFAULT_DEMO_TARGET = 'fixture/demo-target';

program.name('wici').description('Autonomous long-horizon coding TUI orchestrator').version(readPackageVersionSync());

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
  .requiredOption('--target <path>', 'target repository')
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
  .command('tui')
  .description('Open the Chat-first TUI')
  .requiredOption('--target <path>', 'target repository')
  .option('--goal <text>', 'initial goal')
  .option('--max-iters <n>', 'max iterations', (value) => Number(value))
  .option('--resume-iteration <n>', 'load checkpoint snapshot for iteration N before running', parseNonNegativeInteger)
  .option('--mode <mode>', 'tool mode: real, auto, or stub', 'auto')
  .option('--lock-mode <mode>', 'eval lock mode: auto or manual')
  .option('--no-supervisor', 'do not start the supervisor loop')
  .option('--no-fullscreen', 'render without fullscreen mode')
  .option('--mouse-reporting', 'enable mouse wheel/click tracking; disables native terminal text selection', false)
  .action((options: { target: string; goal?: string; maxIters?: number; resumeIteration?: number; mode: ToolMode; lockMode?: 'auto' | 'manual'; supervisor: boolean; fullscreen: boolean; mouseReporting: boolean }) => {
    renderTui({
      target: resolve(options.target),
      goal: options.goal,
      maxIters: options.maxIters,
      resumeIteration: options.resumeIteration,
      mode: options.mode,
      lockMode: options.lockMode,
      supervisor: options.supervisor,
      fullscreen: options.fullscreen,
      mouseReporting: options.mouseReporting
    });
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
    process.exitCode = report.codex.available && report.claude.available && !report.codex.error && !report.claude.error ? 0 : 1;
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

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got ${value}`);
  }
  return parsed;
}

function renderTui(options: {
  target: string;
  goal?: string;
  maxIters?: number;
  resumeIteration?: number;
  mode?: ToolMode;
  lockMode?: 'auto' | 'manual';
  supervisor: boolean;
  fullscreen: boolean;
  mouseReporting: boolean;
}): void {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  installCrashHandlers(options.target);
  const cleanupInputTrace = interactive ? installTuiInputTrace(options.target) : () => undefined;
  const tree = (
    <App
      target={options.target}
      interactive={interactive}
      supervisor={{
        enabled: options.supervisor,
        initialGoal: options.goal,
        maxIters: options.maxIters,
        resumeIteration: options.resumeIteration,
        mode: options.mode,
        lockMode: options.lockMode
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
  const pointerSequence = mouseReporting ? `${DISABLE_POINTER_INPUT_SEQUENCE}${ENABLE_MOUSE_REPORTING_SEQUENCE}` : `${DISABLE_MOUSE_REPORTING_SEQUENCE}${ENABLE_ALTERNATE_SCROLL_SEQUENCE}`;
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
