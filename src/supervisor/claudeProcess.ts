import { spawn } from 'node:child_process';
import { resolveCommandForSpawn } from '../shared/commands.js';

export interface ClaudeStreamOptions {
  cwd: string;
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  /** Called once per complete stdout line (newline-delimited), in order. */
  onLine?: (line: string) => void | Promise<void>;
  /** Checked by the watchdog so callers can interrupt long planner/chat subprocesses. */
  shouldAbort?: () => boolean | Promise<boolean>;
}

export type CommandArgs = string[] & { stdin?: string };

export interface ClaudeStreamResult {
  stdout: string;
  stderr: string;
  all: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timeoutReason: 'idle' | 'hard' | 'aborted' | null;
}

/**
 * Spawn a `claude` (or compatible) CLI, stream its stdout line-by-line, and
 * enforce idle/hard watchdog timeouts. This is the shared transport used by both
 * the planner (plan mode) and the Chat agent (conversational mode). It never
 * throws on a non-zero exit or timeout; callers inspect the result and decide how
 * to surface failures (the planner summarizes and throws; the Chat agent degrades).
 */
export async function runClaudeStreamProcess(
  command: string,
  args: CommandArgs,
  options: ClaudeStreamOptions
): Promise<ClaudeStreamResult> {
  const resolved = await resolveCommandForSpawn(command, args);
  const child = spawn(resolved.command, resolved.args, {
    cwd: options.cwd,
    stdio: [args.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    shell: resolved.shell
  });
  if (args.stdin !== undefined) {
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(args.stdin);
  }

  let stdout = '';
  let stderr = '';
  let lineBuffer = '';
  let timeoutReason: 'idle' | 'hard' | 'aborted' | null = null;
  let lineChain = Promise.resolve();
  let abortCheckChain = Promise.resolve();
  const startedAt = Date.now();
  let lastActivityAt = startedAt;

  const markActivity = () => {
    lastActivityAt = Date.now();
  };
  const killForTimeout = (reason: 'idle' | 'hard' | 'aborted') => {
    if (timeoutReason) return;
    timeoutReason = reason;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
  };
  const handleLine = (line: string) => {
    if (!options.onLine) return;
    lineChain = lineChain.then(() => options.onLine?.(line)).then(() => undefined);
  };

  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - startedAt >= options.hardTimeoutMs) {
      killForTimeout('hard');
    } else if (now - lastActivityAt >= options.idleTimeoutMs) {
      killForTimeout('idle');
    }
  }, 5_000);
  watchdog.unref();

  const abortWatchdog = options.shouldAbort
    ? setInterval(() => {
        if (options.shouldAbort && !timeoutReason) {
          abortCheckChain = abortCheckChain.then(async () => {
            if (!timeoutReason && await options.shouldAbort?.()) killForTimeout('aborted');
          }).then(() => undefined, () => undefined);
        }
      }, 500)
    : null;
  abortWatchdog?.unref();

  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (!stdoutStream || !stderrStream) throw new Error('failed to open child stdout/stderr pipes');

  stdoutStream.setEncoding('utf8');
  stdoutStream.on('data', (chunk: string) => {
    markActivity();
    stdout += chunk;
    lineBuffer += chunk;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  });
  stderrStream.setEncoding('utf8');
  stderrStream.on('data', (chunk: string) => {
    markActivity();
    stderr += chunk;
  });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearInterval(watchdog);
  if (abortWatchdog) clearInterval(abortWatchdog);
  await abortCheckChain;

  if (lineBuffer.length > 0) handleLine(lineBuffer);
  await lineChain;

  return {
    stdout,
    stderr,
    all: `${stdout}${stderr}`,
    exitCode: exit.code,
    signal: exit.signal,
    timeoutReason
  };
}
