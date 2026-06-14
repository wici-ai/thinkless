#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { withFullScreen } from 'fullscreen-ink';
import { Command } from 'commander';
import { resolve } from 'node:path';
import { App } from './tui/App.js';
import { runSupervisor } from './supervisor/index.js';
import { createSampleTarget } from './sample.js';
import type { ToolMode } from './shared/types.js';
import { loadConfig } from './shared/config.js';
import { runPaths } from './shared/paths.js';
import { previewRollback, rollbackTarget } from './supervisor/rollback.js';
import { checkToolHealth, updateToolsBetweenRuns } from './supervisor/selfupdate.js';

const program = new Command();

program.name('wici').description('Autonomous long-horizon coding TUI orchestrator').version('0.1.0');

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
  .description('Open the three-pane TUI')
  .requiredOption('--target <path>', 'target repository')
  .option('--goal <text>', 'initial goal')
  .option('--max-iters <n>', 'max iterations', (value) => Number(value))
  .option('--resume-iteration <n>', 'load checkpoint snapshot for iteration N before running', parseNonNegativeInteger)
  .option('--mode <mode>', 'tool mode: real, auto, or stub', 'auto')
  .option('--lock-mode <mode>', 'eval lock mode: auto or manual')
  .option('--no-supervisor', 'do not start the supervisor loop')
  .option('--no-fullscreen', 'render without fullscreen mode')
  .action((options: { target: string; goal?: string; maxIters?: number; resumeIteration?: number; mode: ToolMode; lockMode?: 'auto' | 'manual'; supervisor: boolean; fullscreen: boolean }) => {
    const target = resolve(options.target);
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const tree = (
      <App
        target={target}
        interactive={interactive}
        supervisor={{
          enabled: options.supervisor,
          initialGoal: options.goal,
          maxIters: options.maxIters,
          resumeIteration: options.resumeIteration,
          mode: options.mode,
          lockMode: options.lockMode
        }}
      />
    );
    if (options.fullscreen && interactive) {
      void withFullScreen(tree, { interactive: true }).start();
    } else {
      render(tree, { interactive });
    }
  });

program
  .command('smoke')
  .description('Create the fixture and run one stubbed supervisor iteration')
  .option('--target <path>', 'target directory', 'fixture/slow-target')
  .action(async (options: { target: string }) => {
    const target = await createSampleTarget(options.target, true);
    const result = await runSupervisor({
      target,
      goal: 'Reduce p99 latency of uniqueSorted while preserving exact sorted unique output.',
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
