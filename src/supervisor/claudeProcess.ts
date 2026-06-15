import { spawn } from 'node:child_process';

export interface ClaudeStreamOptions {
  cwd: string;
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  /** Called once per complete stdout line (newline-delimited), in order. */
  onLine?: (line: string) => void | Promise<void>;
}

export interface ClaudeStreamResult {
  stdout: string;
  all: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timeoutReason: 'idle' | 'hard' | null;
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
  args: string[],
  options: ClaudeStreamOptions
): Promise<ClaudeStreamResult> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  let lineBuffer = '';
  let timeoutReason: 'idle' | 'hard' | null = null;
  let lineChain = Promise.resolve();
  const startedAt = Date.now();
  let lastActivityAt = startedAt;

  const markActivity = () => {
    lastActivityAt = Date.now();
  };
  const killForTimeout = (reason: 'idle' | 'hard') => {
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

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    markActivity();
    stdout += chunk;
    lineBuffer += chunk;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    markActivity();
    stderr += chunk;
  });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearInterval(watchdog);

  if (lineBuffer.length > 0) handleLine(lineBuffer);
  await lineChain;

  return {
    stdout,
    all: `${stdout}${stderr}`,
    exitCode: exit.code,
    signal: exit.signal,
    timeoutReason
  };
}
