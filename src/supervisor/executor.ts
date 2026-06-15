import { spawn } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { atomicWriteFile, atomicWriteJson, exists } from '../shared/atomic.js';
import { schemaPath, type RunPaths } from '../shared/paths.js';
import type { GoalFile, IterResult, ToolInvocationResult, WiCiConfig } from '../shared/types.js';
import { CodexRunError, appendCodexRunTranscript, assertCodexRunSucceeded, parseCodexRunEvents, syntheticCodexRunEvent } from './codexRun.js';
import { formatSafetyForPrompt } from './safety.js';

const EXECUTOR_IDLE_TIMEOUT_MS = 60 * 60_000;
const EXECUTOR_HARD_TIMEOUT_MS = 12 * 60 * 60_000;
const EXECUTOR_HEARTBEAT_MS = 30_000;

export interface ExecutorProgress {
  kind: 'event' | 'heartbeat';
  eventType?: string;
  usage: import('../shared/types.js').ToolUsageSummary;
  wallMs: number;
  idleMs: number;
}

export interface ExecutorRunOptions {
  artifactId?: string;
  resume?: boolean;
  onProgress?: (progress: ExecutorProgress) => Promise<void>;
  idleTimeoutMs?: number;
  hardTimeoutMs?: number;
  heartbeatMs?: number;
}

async function commandExists(command: string): Promise<boolean> {
  const result = await execa('command', ['-v', command], { shell: true, reject: false });
  return result.exitCode === 0;
}

export async function runExecutorStep(
  paths: RunPaths,
  goal: GoalFile,
  stepId: string,
  iter: number,
  config: WiCiConfig,
  steerText?: string,
  lessonsText?: string,
  options: ExecutorRunOptions = {}
): Promise<IterResult & { invocation: ToolInvocationResult }> {
  const available = await commandExists(config.tools.executor.command);
  if (config.tools.mode === 'real' && !available) {
    throw new Error(`Executor command not found in real mode: ${config.tools.executor.command}`);
  }

  if (config.tools.mode !== 'stub' && available) {
    try {
      const safetyText = formatSafetyForPrompt(config);
      const artifactId = options.artifactId ?? `iter-${iter}`;
      const prompt = await buildExecutorPrompt(paths, stepId, iter, artifactId, safetyText, steerText, lessonsText);

      const artifactPath = join(paths.artifacts, `${artifactId}.txt`);
      await atomicWriteFile(join(paths.artifacts, `${artifactId}.prompt.txt`), `${prompt}\n`);
      const args = buildExecutorArgs({
        iter,
        target: paths.target,
        artifactPath,
        schemaPath: schemaPath('iter-result'),
        prompt,
        resume: options.resume,
        model: config.tools.executor.model
      });

      const result = await runCodexProcess(config.tools.executor.command, args, paths, {
        cwd: paths.target,
        onProgress: options.onProgress,
        idleTimeoutMs: options.idleTimeoutMs,
        hardTimeoutMs: options.hardTimeoutMs,
        heartbeatMs: options.heartbeatMs
      });
      if (result.exitCode !== 0) {
        throw new CodexRunError(`codex exec exited ${result.exitCode}:\n${result.all}`, result.usage);
      }
      assertCodexRunSucceeded(result.usage, 'codex exec reported failure event');
      const iterResult = await readIterResult(paths, artifactId);
      return { ...iterResult, invocation: { ok: true, stdout: result.all, usage: result.usage } };
    } catch (error) {
      if (config.tools.mode === 'real') throw error;
    }
  }

  const stubPrompt = await buildExecutorPrompt(paths, stepId, iter, `iter-${iter}`, formatSafetyForPrompt(config), steerText, lessonsText);
  await atomicWriteFile(join(paths.artifacts, `iter-${iter}.prompt.txt`), `${stubPrompt}\n`);
  const iterResult = await runStubExecutor(paths, goal, stepId, iter);
  const usage = await appendCodexRunTranscript(paths, syntheticCodexRunEvent(iter, iterResult.notes));
  return { ...iterResult, invocation: { ok: true, sessionId: 'stub-executor', stdout: iterResult.notes, usage } };
}

async function buildExecutorPrompt(
  paths: RunPaths,
  stepId: string,
  iter: number,
  artifactId: string,
  safetyText: string,
  steerText?: string,
  memoryText?: string
): Promise<string> {
  const goalMarkdown = await readTextIfExists(paths.goalDoc);
  const planMarkdown = await readTextIfExists(paths.plan);
  return [
    iter === 1 ? 'Execute the current GOAL.md and PLAN.md as one Codex goal.' : 'Continue executing the current GOAL.md and PLAN.md as one Codex goal.',
    `Supervisor receipt focus: ${stepId}. Use this as orientation for progress reporting; do not ignore other PLAN.md work needed to satisfy the goal.`,
    steerText ? `NOTE new requirement or steering input: ${steerText}` : '',
    `Use the target repository as the only workspace.`,
    `Treat GOAL.md and PLAN.md below as the execution goal input. Re-read the files from disk if you need exact current contents.`,
    `You may edit PLAN.md, GOAL.md, and planner-provided .opt scripts when execution teaches you the plan is wrong, incomplete, or needs a better strategy. Keep the user's requirement intact and record the reasoning in the files you change.`,
    `Do not stop at the first failing command. Diagnose the failure, inspect logs/state, update the plan if needed, and continue with the best next attempt until the goal is actually satisfied or you have concrete evidence that it cannot be satisfied.`,
    `When the task depends on unfamiliar tools, models, services, runtimes, or deployment practices, research the relevant documentation or tutorials yourself using the native tools available to Codex; do not require the user to include research/debugging instructions in Chat.`,
    `For long-running installs, builds, SSH tasks, model downloads, and benchmarks, prefer commands that stream progress or write logs you can tail so the TUI remains observable.`,
    `Treat existing .opt scripts as planner-provided validation artifacts; follow PLAN.md if it explicitly asks you to run or adjust them.`,
    '',
    'Current GOAL.md:',
    fencedMarkdown(goalMarkdown || '(missing GOAL.md; inspect the workspace before proceeding)'),
    '',
    'Current PLAN.md:',
    fencedMarkdown(planMarkdown || '(missing PLAN.md; stop and report this as a WiCi setup error)'),
    '',
    safetyText,
    memoryText ? memoryText : '',
    `Write result JSON to .wici/artifacts/${artifactId}.json with shape {step_done,tests_pass,notes,changed_files,next}; use [] for changed_files and null for next when empty.`
  ]
    .filter((item) => item !== '')
    .join('\n');
}

async function readTextIfExists(path: string): Promise<string> {
  return (await exists(path)) ? readFile(path, 'utf8') : '';
}

function fencedMarkdown(text: string): string {
  return ['```markdown', text.trimEnd(), '```'].join('\n');
}

async function runCodexProcess(
  command: string,
  args: string[],
  paths: RunPaths,
  options: {
    cwd: string;
    onProgress?: (progress: ExecutorProgress) => Promise<void>;
    idleTimeoutMs?: number;
    hardTimeoutMs?: number;
    heartbeatMs?: number;
  }
): Promise<{ stdout: string; stderr: string; all: string; usage: ExecutorProgress['usage']; exitCode: number | null; signal: NodeJS.Signals | null }> {
  const idleTimeoutMs = options.idleTimeoutMs ?? EXECUTOR_IDLE_TIMEOUT_MS;
  const hardTimeoutMs = options.hardTimeoutMs ?? EXECUTOR_HARD_TIMEOUT_MS;
  const heartbeatMs = options.heartbeatMs ?? EXECUTOR_HEARTBEAT_MS;
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  let stdoutLineBuffer = '';
  let stderrLineBuffer = '';
  let timeoutReason: 'idle' | 'hard' | null = null;
  let transcriptChain = Promise.resolve();
  let transcriptError: unknown;
  let progressChain = Promise.resolve();
  let progressError: unknown;
  const usage = emptyUsageSummary();
  const startedAt = Date.now();
  let lastActivityAt = startedAt;

  const markActivity = () => {
    lastActivityAt = Date.now();
  };

  const scheduleProgress = (progress: Omit<ExecutorProgress, 'usage' | 'wallMs' | 'idleMs'>) => {
    if (!options.onProgress) return;
    const now = Date.now();
    const snapshot = cloneUsageSummary(usage);
    progressChain = progressChain.then(async () => {
      if (progressError) return;
      try {
        await options.onProgress?.({
          ...progress,
          usage: snapshot,
          wallMs: now - startedAt,
          idleMs: now - lastActivityAt
        });
      } catch (error) {
        progressError = error;
      }
    });
  };

  const appendTranscript = (chunk: string) => {
    if (!chunk) return;
    transcriptChain = transcriptChain.then(async () => {
      if (transcriptError) return;
      try {
        await appendFile(paths.codexRun, chunk);
      } catch (error) {
        transcriptError = error;
      }
    });
  };

  const consumeLines = (buffer: string, chunk: string): string => {
    let nextBuffer = buffer + chunk;
    const lines = nextBuffer.split(/\r?\n/);
    nextBuffer = lines.pop() ?? '';
    for (const line of lines) consumeCodexLine(line, usage, scheduleProgress);
    return nextBuffer;
  };

  const killForTimeout = (reason: 'idle' | 'hard') => {
    if (timeoutReason) return;
    timeoutReason = reason;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
  };

  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - startedAt >= hardTimeoutMs) {
      killForTimeout('hard');
    } else if (now - lastActivityAt >= idleTimeoutMs) {
      killForTimeout('idle');
    }
  }, Math.min(5_000, Math.max(50, idleTimeoutMs)));
  watchdog.unref();

  const heartbeat = setInterval(() => {
    scheduleProgress({ kind: 'heartbeat' });
  }, heartbeatMs);
  heartbeat.unref();

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    markActivity();
    stdout += chunk;
    appendTranscript(chunk);
    stdoutLineBuffer = consumeLines(stdoutLineBuffer, chunk);
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    markActivity();
    stderr += chunk;
    appendTranscript(chunk);
    stderrLineBuffer = consumeLines(stderrLineBuffer, chunk);
  });

  let exit: { code: number | null; signal: NodeJS.Signals | null };
  try {
    exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } catch (error) {
    clearInterval(watchdog);
    clearInterval(heartbeat);
    await transcriptChain;
    await progressChain;
    throw new CodexRunError(`codex exec failed to start: ${error instanceof Error ? error.message : String(error)}`, cloneUsageSummary(usage));
  }

  clearInterval(watchdog);
  clearInterval(heartbeat);
  if (stdoutLineBuffer) consumeCodexLine(stdoutLineBuffer, usage, scheduleProgress);
  if (stderrLineBuffer) consumeCodexLine(stderrLineBuffer, usage, scheduleProgress);
  await transcriptChain;
  await progressChain;

  if (transcriptError) {
    throw transcriptError;
  }
  if (progressError) {
    throw progressError;
  }

  const all = `${stdout}${stderr}`;
  if (timeoutReason === 'hard') {
    throw new CodexRunError(`Codex executor exceeded hard timeout after ${durationLabel(hardTimeoutMs)}`, cloneUsageSummary(usage));
  }
  if (timeoutReason === 'idle') {
    throw new CodexRunError(`Codex executor timed out after ${durationLabel(idleTimeoutMs)} without stdout/stderr output`, cloneUsageSummary(usage));
  }

  return {
    stdout,
    stderr,
    all,
    usage: cloneUsageSummary(usage),
    exitCode: exit.code,
    signal: exit.signal
  };
}

function consumeCodexLine(
  line: string,
  usage: ExecutorProgress['usage'],
  scheduleProgress: (progress: Omit<ExecutorProgress, 'usage' | 'wallMs' | 'idleMs'>) => void
): void {
  const delta = parseCodexRunEvents(line);
  mergeUsageSummary(usage, delta);
  if (delta.events > 0 || delta.parse_errors) {
    scheduleProgress({ kind: 'event', eventType: codexEventType(line) });
  }
}

function emptyUsageSummary(): ExecutorProgress['usage'] {
  return {
    events: 0,
    completed_turns: 0,
    completed_items: 0,
    failed: false,
    errors: []
  };
}

function cloneUsageSummary(summary: ExecutorProgress['usage']): ExecutorProgress['usage'] {
  return {
    ...summary,
    errors: [...summary.errors]
  };
}

function mergeUsageSummary(target: ExecutorProgress['usage'], delta: ExecutorProgress['usage']): void {
  target.events += delta.events;
  target.completed_turns += delta.completed_turns;
  target.completed_items += delta.completed_items;
  if (delta.tokens_input !== undefined) target.tokens_input = (target.tokens_input ?? 0) + delta.tokens_input;
  if (delta.tokens_output !== undefined) target.tokens_output = (target.tokens_output ?? 0) + delta.tokens_output;
  if (delta.usd !== undefined) target.usd = Number(((target.usd ?? 0) + delta.usd).toFixed(8));
  target.failed ||= delta.failed;
  target.errors.push(...delta.errors);
  if (delta.parse_errors !== undefined) target.parse_errors = (target.parse_errors ?? 0) + delta.parse_errors;
}

function codexEventType(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    for (const key of ['type', 'event', 'name']) {
      const value = record[key];
      if (typeof value === 'string') return value;
    }
    const item = record.item;
    if (item && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).type === 'string') {
      return (item as Record<string, unknown>).type as string;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function durationLabel(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

async function readIterResult(paths: RunPaths, artifactId: string): Promise<IterResult> {
  const path = join(paths.artifacts, `${artifactId}.json`);
  if (!(await exists(path))) {
    throw new Error(`Executor did not write expected result file: ${path}`);
  }
  const parsed = JSON.parse(await readFile(path, 'utf8')) as IterResult;
  return {
    ...parsed,
    changed_files: Array.isArray(parsed.changed_files) ? parsed.changed_files : [],
    next: parsed.next ?? undefined
  };
}

async function runStubExecutor(paths: RunPaths, _goal: GoalFile, stepId: string, iter: number): Promise<IterResult> {
  const hotPath = join(paths.target, 'src', 'hotpath.js');
  const result: IterResult = {
    step_done: false,
    tests_pass: false,
    notes: 'Stub executor found no fixture hotpath.js; wrote a no-op result.',
    changed_files: [],
    next: null
  };

  if (await exists(hotPath)) {
    const current = await readFile(hotPath, 'utf8');
    if (current.includes('for (const candidate of values)')) {
      const optimized = `export function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}
`;
      await writeFile(hotPath, optimized);
      result.step_done = true;
      result.tests_pass = true;
      result.notes = `Stub executor completed ${stepId}: replaced quadratic unique sort with Set-based implementation.`;
      result.changed_files = ['src/hotpath.js'];
    } else if ((await exists(join(paths.wici, 'stub-two-keeps'))) && !current.includes('wici-stub-v2')) {
      await writeFile(hotPath, `${current.trimEnd()}\n// wici-stub-v2\n`);
      result.step_done = false;
      result.tests_pass = true;
      result.notes = `Stub executor completed ${stepId}: added fixture marker for a second accepted stepping stone.`;
      result.changed_files = ['src/hotpath.js'];
    } else {
      result.step_done = true;
      result.tests_pass = true;
      result.notes = `Stub executor completed ${stepId}: hot path already optimized.`;
      result.changed_files = [];
    }
  }

  await atomicWriteJson(join(paths.artifacts, `iter-${iter}.json`), result);
  return result;
}

export function buildExecutorArgs(input: {
  iter: number;
  target: string;
  artifactPath: string;
  schemaPath: string;
  prompt: string;
  resume?: boolean;
  model?: string;
}): string[] {
  if (!(input.resume ?? input.iter > 1)) {
    return [
      'exec',
      ...modelArgs(input.model),
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      '--output-last-message',
      input.artifactPath,
      '--output-schema',
      input.schemaPath,
      '-C',
      input.target,
      '--skip-git-repo-check',
      input.prompt
    ];
  }

  return [
    'exec',
    'resume',
    '--last',
    ...modelArgs(input.model),
    '--dangerously-bypass-approvals-and-sandbox',
    '--json',
    '--output-last-message',
    input.artifactPath,
    '--output-schema',
    input.schemaPath,
    '--skip-git-repo-check',
    input.prompt
  ];
}

function modelArgs(model: string | undefined): string[] {
  return model?.trim() ? ['--model', model.trim()] : [];
}
