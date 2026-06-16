import { appendFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { runPaths } from './paths.js';

let installed = false;
let performanceCleanupInstalled = false;

// Best-effort, SYNCHRONOUS crash trace. Process-fatal events (uncaughtException,
// unhandledRejection, OOM-adjacent throws) can kill the process before any async
// write flushes, so this writes synchronously. The in-process supervisor shares
// the TUI process, so without this a fatal leaves no trace (App.tsx's .catch only
// catches normal rejections of the runSupervisor() promise).
export function installCrashHandlers(target: string): void {
  if (installed) return;
  installed = true;
  installPerformanceTimelineCleanup();
  const log = runPaths(target).supervisorLog;

  const write = (label: string, error: unknown): void => {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    try {
      mkdirSync(runPaths(target).wici, { recursive: true });
      appendFileSync(log, `[${new Date().toISOString()}] ${label}: ${detail}\n\n`);
    } catch {
      // Nothing more we can do if even the sync write fails.
    }
  };

  process.on('uncaughtException', (error) => {
    write('uncaughtException', error);
  });
  process.on('unhandledRejection', (reason) => {
    write('unhandledRejection', reason);
  });
}

function installPerformanceTimelineCleanup(): void {
  if (performanceCleanupInstalled) return;
  performanceCleanupInstalled = true;
  const timer = setInterval(() => {
    try {
      performance.clearMarks();
      performance.clearMeasures();
    } catch {
      // Best-effort cleanup for user-timing entries emitted by dev React/Ink.
    }
  }, 250);
  timer.unref?.();
}
