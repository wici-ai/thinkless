import { spawn } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { execa } from 'execa';
import { atomicWriteFile, atomicWriteJson, exists } from '../shared/atomic.js';
import { commandExists, resolveCommandForSpawn } from '../shared/commands.js';
import { schemaPath, type RunPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, IterResult, ToolInvocationResult, WiCiConfig } from '../shared/types.js';
import { CodexRunError, appendCodexRunTranscript, assertCodexRunSucceeded, parseCodexRunEvents, syntheticCodexRunEvent } from './codexRun.js';
import { formatSafetyForPrompt } from './safety.js';
import { startCodexAppServerTurn } from './codexAppServer.js';

const EXECUTOR_IDLE_TIMEOUT_MS = 60 * 60_000;
const EXECUTOR_HARD_TIMEOUT_MS = 12 * 60 * 60_000;
const EXECUTOR_HEARTBEAT_MS = 30_000;
const EXECUTOR_FIRST_MEANINGFUL_EVENT_TIMEOUT_MS = 5 * 60_000;
// Bound in-memory output so a multi-hour exec step cannot grow a string past
// V8's ~512MB max length or exhaust the heap. Full output is on disk already.
const OUTPUT_TAIL_CHARS = 256 * 1024;
const MAX_USAGE_ERRORS = 50;

function tailChars(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

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
  freshFallback?: boolean;
  onProgress?: (progress: ExecutorProgress) => Promise<void>;
  onBackendFallback?: (fallback: ExecutorBackendFallback) => Promise<void>;
  shouldPreempt?: () => Promise<boolean>;
  completionArtifactId?: string;
  idleTimeoutMs?: number;
  hardTimeoutMs?: number;
  heartbeatMs?: number;
  firstMeaningfulEventTimeoutMs?: number;
}

export interface ExecutorBackendFallback {
  from: 'app-server';
  to: 'exec';
  phase: 'start' | 'turn';
  reason: string;
  threadId?: string;
  turnId?: string;
}

export interface ExecutorController {
  backend: 'app-server' | 'exec' | 'stub';
  threadId?: string;
  turnId?: string;
  done: Promise<IterResult & { invocation: ToolInvocationResult }>;
  steer: (text: string) => Promise<boolean>;
  interrupt: () => Promise<void>;
}

export class ExecutorPreemptedError extends Error {
  readonly usage: ToolInvocationResult['usage'];

  constructor(message: string, usage: ToolInvocationResult['usage']) {
    super(message);
    this.name = 'ExecutorPreemptedError';
    this.usage = usage;
  }
}

export function isExecutorPreempted(error: unknown): error is ExecutorPreemptedError {
  return error instanceof ExecutorPreemptedError;
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
      const prompt = await buildExecutorPrompt(paths, stepId, iter, artifactId, safetyText, steerText, lessonsText, options.resume ?? iter > 1);

      const artifactPath = join(paths.artifacts, `${artifactId}.txt`);
      await atomicWriteFile(join(paths.artifacts, `${artifactId}.prompt.txt`), `${prompt}\n`);
      const args = buildExecutorArgs({
        iter,
        target: paths.target,
        artifactPath,
        schemaPath: schemaPath('iter-result'),
        prompt,
        resume: options.resume,
        model: config.tools.executor.model,
        effort: config.tools.executor.effort
      });

      const result = await runCodexProcess(config.tools.executor.command, args, paths, {
        cwd: paths.target,
        stdin: args.stdin,
        onProgress: options.onProgress,
        shouldPreempt: options.shouldPreempt,
        completionArtifactId: artifactId,
        idleTimeoutMs: options.idleTimeoutMs,
        hardTimeoutMs: options.hardTimeoutMs,
        heartbeatMs: options.heartbeatMs,
        firstMeaningfulEventTimeoutMs: options.firstMeaningfulEventTimeoutMs
      });
      if (result.exitCode !== 0) {
        throw new CodexRunError(`codex exec exited ${result.exitCode}:\n${result.all}`, result.usage);
      }
      assertCodexRunSucceeded(result.usage, 'codex exec reported failure event');
      const iterResult = await readIterResult(paths, artifactId);
      return { ...iterResult, invocation: { ok: true, stdout: result.all, usage: result.usage } };
    } catch (error) {
      if (config.tools.mode === 'real') throw error;
      throw new Error(`Executor command failed after starting real executor; refusing to fall back to stub: ${errorMessage(error)}`);
    }
  }

  const stubPrompt = await buildExecutorPrompt(paths, stepId, iter, `iter-${iter}`, formatSafetyForPrompt(config), steerText, lessonsText, iter > 1);
  await atomicWriteFile(join(paths.artifacts, `iter-${iter}.prompt.txt`), `${stubPrompt}\n`);
  const iterResult = await runStubExecutor(paths, goal, stepId, iter);
  const usage = await appendCodexRunTranscript(paths, syntheticCodexRunEvent(iter, iterResult.notes));
  return { ...iterResult, invocation: { ok: true, sessionId: 'stub-executor', stdout: iterResult.notes, usage } };
}

export async function startExecutorStep(
  paths: RunPaths,
  goal: GoalFile,
  stepId: string,
  iter: number,
  config: WiCiConfig,
  checkpoint: Checkpoint,
  steerText?: string,
  lessonsText?: string,
  options: ExecutorRunOptions = {}
): Promise<ExecutorController> {
  const backend = config.tools.executor.backend ?? 'auto';
  const available = await commandExists(config.tools.executor.command);
  if (config.tools.mode === 'real' && !available) {
    throw new Error(`Executor command not found in real mode: ${config.tools.executor.command}`);
  }

  if (config.tools.mode !== 'stub' && available && shouldAttemptAppServerBackend(backend)) {
    try {
      const safetyText = formatSafetyForPrompt(config);
      const artifactId = options.artifactId ?? `iter-${iter}`;
      const prompt = await buildExecutorPrompt(paths, stepId, iter, artifactId, safetyText, steerText, lessonsText, Boolean(checkpoint.sessions.executorApp?.threadId));
      await atomicWriteFile(join(paths.artifacts, `${artifactId}.prompt.txt`), `${prompt}\n`);
      const startedAt = Date.now();
      let lastEventAt = startedAt;
      const turn = await startCodexAppServerTurn({
        paths,
        config,
        checkpoint,
        prompt,
        artifactId,
        idleTimeoutMs: options.idleTimeoutMs,
        hardTimeoutMs: options.hardTimeoutMs,
        heartbeatMs: options.heartbeatMs,
        firstMeaningfulEventTimeoutMs: options.firstMeaningfulEventTimeoutMs,
        onRawNotification: async (_line, usage, method) => {
          const now = Date.now();
          await options.onProgress?.({
            kind: 'event',
            eventType: method,
            usage,
            wallMs: now - startedAt,
            idleMs: now - lastEventAt
          });
          lastEventAt = now;
        }
      });
      return {
        backend: 'app-server',
        threadId: turn.threadId,
        turnId: turn.turnId,
        done: turn.done
          .then(async (result) => {
            assertCodexRunSucceeded(result.usage, 'codex app-server reported failure event');
            const iterResult = await readIterResult(paths, artifactId);
            return {
              ...iterResult,
              invocation: {
                ok: true,
                sessionId: turn.threadId,
                stdout: result.stdout,
                usage: result.usage
              }
            };
          })
          .catch(async (error) => {
            await options.onBackendFallback?.({
              from: 'app-server',
              to: 'exec',
              phase: 'turn',
              reason: errorMessage(error),
              threadId: turn.threadId,
              turnId: turn.turnId
            });
            return runExecutorStep(paths, goal, stepId, iter, config, steerText, lessonsText, {
              ...options,
              resume: options.freshFallback ? false : options.resume ?? iter > 1
            });
          }),
        steer: turn.steer,
        interrupt: turn.interrupt
      };
    } catch (error) {
      await options.onBackendFallback?.({
        from: 'app-server',
        to: 'exec',
        phase: 'start',
        reason: errorMessage(error)
      });
    }
  }

  const done = runExecutorStep(paths, goal, stepId, iter, config, steerText, lessonsText, options);
  return {
    backend: config.tools.mode === 'stub' || !available ? 'stub' : 'exec',
    done,
    steer: async () => false,
    interrupt: async () => undefined
  };
}

function shouldAttemptAppServerBackend(backend: NonNullable<WiCiConfig['tools']['executor']['backend']>): boolean {
  if (backend === 'exec') return false;
  if (backend === 'app-server') return true;
  return !process.env.WICI_FAKE_TARGET;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function buildExecutorPrompt(
  paths: RunPaths,
  stepId: string,
  iter: number,
  artifactId: string,
  safetyText: string,
  steerText?: string,
  memoryText?: string,
  resume = iter > 1
): Promise<string> {
  const goalMarkdown = await readTextIfExists(paths.goalDoc);
  const planMarkdown = await readTextIfExists(paths.plan);
  const goalPath = workspaceRelativePath(paths, paths.goalDoc);
  const planPath = workspaceRelativePath(paths, paths.plan);
  const optPath = workspaceRelativePath(paths, paths.opt);
  const resultPath = workspaceRelativePath(paths, join(paths.artifacts, `${artifactId}.json`));
  if (resume) {
    return [
      'Continue the existing Codex session for this WiCi run.',
      `Supervisor receipt focus: ${stepId}. Use this as orientation only; satisfy the current ${goalPath} and ${planPath} as a whole.`,
      `${goalPath} and ${planPath} have already been updated on disk. Re-read them from the workspace before acting.`,
      steerText ? `New requirement or steering delta to apply now:\n${steerText}` : '',
      'Do not restart the task from scratch. Continue from the existing workspace and remote state; preserve completed useful work.',
      `If the updated ${goalPath}/${planPath} changes validation, update only the necessary local files/scripts and run the new checks.`,
      `Use the target repository as the only workspace.`,
      `Before architecture-sensitive changes or debugging, infer the target system invariants from repo docs, code paths, logs, tests, ledger/receipts, and ASSUMPTIONS.md: source of truth, ownership boundary, resource identity/lifecycle, translation or mapping points, fallback policy, and proof evidence.`,
      `Debug deeply when needed: add bounded instrumentation, correlate logs across boundaries, inspect call stacks/modules/return values, bisect, profile, and run targeted experiments, while respecting inferred invariants and avoiding unlabelled fallbacks or masked ownership/resource mapping gaps.`,
      `Only mark diagnostic work done when you have decision-quality evidence: narrowed root cause, falsified hypothesis, concrete next experiment, or durable invariant/constraint; if the blocker remains, name the earliest suspicious point, what was ruled out, and the next highest-value test.`,
      `When you intentionally change target repository files, validate them and create the git commit yourself as directed by ${planPath}. Thinkless will not run git add or git commit for direct V1 execution.`,
      `For long-running installs, builds, SSH tasks, model downloads, and benchmarks, prefer commands that stream progress or write logs you can tail so the TUI remains observable.`,
      `Treat existing scripts under ${optPath} as planner-provided validation artifacts; follow ${planPath} if it explicitly asks you to run or adjust them.`,
      '',
      safetyText,
      memoryText ? memoryText : '',
      `Write result JSON to ${resultPath} with shape {step_done,tests_pass,notes,changed_files,next}; use [] for changed_files and null for next when empty.`
    ]
      .filter((item) => item !== '')
      .join('\n');
  }
  return [
    iter === 1 ? `Execute the current ${goalPath} and ${planPath} as one Codex goal.` : `Continue executing the current ${goalPath} and ${planPath} as one Codex goal.`,
    `Supervisor receipt focus: ${stepId}. Use this as orientation for progress reporting; do not ignore other ${planPath} work needed to satisfy the goal.`,
    steerText ? `NOTE new requirement or steering input: ${steerText}` : '',
    `Use the target repository as the only workspace.`,
    `Treat ${goalPath} and ${planPath} below as the execution goal input. Re-read the files from disk if you need exact current contents.`,
    `You may edit ${planPath}, ${goalPath}, and planner-provided scripts under ${optPath} when execution teaches you the plan is wrong, incomplete, or needs a better strategy. Keep the user's requirement intact and record the reasoning in the files you change.`,
    `Before architecture-sensitive changes or debugging, infer the target system invariants from repo docs, code paths, logs, tests, ledger/receipts, and ASSUMPTIONS.md: source of truth, ownership boundary, resource identity/lifecycle, translation or mapping points, fallback policy, and proof evidence. Do not hardcode domain assumptions from examples.`,
    `Use a compact RFC-style decision packet for nontrivial architecture/debug turns: problem, inferred invariants, options considered, chosen approach, risks, and validation. Preserve durable findings in ${planPath} or ASSUMPTIONS.md so later steps do not blind-guess from stale context.`,
    `When you intentionally change target repository files, validate them and create the git commit yourself as directed by ${planPath}. Thinkless will not run git add or git commit for direct V1 execution.`,
    `Do not stop at the first failing command. Diagnose the failure, inspect logs/state, add bounded instrumentation, correlate logs across boundaries, inspect call stacks/modules/return values, bisect, profile, update the plan if needed, and continue with the best next attempt until the goal is actually satisfied or you have concrete evidence that it cannot be satisfied.`,
    `Aggressive debugging is allowed when it is bounded and evidence-producing, but it must respect inferred architecture invariants: no unlabelled fallback, no masking missing ownership/resource mappings, and no pretending compatibility data is authoritative truth.`,
    `Only mark diagnostic work done when you have decision-quality evidence: narrowed root cause, falsified hypothesis, concrete next experiment, or durable invariant/constraint. If the blocker remains, report the earliest suspicious point, what you ruled out, and the next highest-value test; adding logs without a new conclusion is partial/reject, not done.`,
    `If repeated iterations have the same blocker, same evidence, or same reject reason, change strategy or inspect the plan/harness/receipt path instead of repeating the same test.`,
    `When the task depends on unfamiliar tools, models, services, runtimes, or deployment practices, research the relevant documentation or tutorials yourself using the native tools available to Codex; do not require the user to include research/debugging instructions in Chat.`,
    `For long-running installs, builds, SSH tasks, model downloads, and benchmarks, prefer commands that stream progress or write logs you can tail so the TUI remains observable.`,
    `Treat existing scripts under ${optPath} as planner-provided validation artifacts; follow ${planPath} if it explicitly asks you to run or adjust them.`,
    '',
    `Current ${goalPath}:`,
    fencedMarkdown(goalMarkdown || '(missing GOAL.md; inspect the workspace before proceeding)'),
    '',
    `Current ${planPath}:`,
    fencedMarkdown(planMarkdown || '(missing PLAN.md; stop and report this as a WiCi setup error)'),
    '',
    safetyText,
    memoryText ? memoryText : '',
    `Write result JSON to ${resultPath} with shape {step_done,tests_pass,notes,changed_files,next}; use [] for changed_files and null for next when empty.`
  ]
    .filter((item) => item !== '')
    .join('\n');
}

function workspaceRelativePath(paths: RunPaths, path: string): string {
  const rel = relative(paths.target, path) || '.';
  if (rel.startsWith('..') || isAbsolute(rel)) return path;
  return rel;
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
    stdin?: string;
    onProgress?: (progress: ExecutorProgress) => Promise<void>;
    shouldPreempt?: () => Promise<boolean>;
    completionArtifactId?: string;
    idleTimeoutMs?: number;
    hardTimeoutMs?: number;
    heartbeatMs?: number;
    firstMeaningfulEventTimeoutMs?: number;
  }
): Promise<{ stdout: string; stderr: string; all: string; usage: ExecutorProgress['usage']; exitCode: number | null; signal: NodeJS.Signals | null }> {
  const idleTimeoutMs = options.idleTimeoutMs ?? EXECUTOR_IDLE_TIMEOUT_MS;
  const hardTimeoutMs = options.hardTimeoutMs ?? EXECUTOR_HARD_TIMEOUT_MS;
  const heartbeatMs = options.heartbeatMs ?? EXECUTOR_HEARTBEAT_MS;
  const firstMeaningfulEventTimeoutMs = options.firstMeaningfulEventTimeoutMs ?? EXECUTOR_FIRST_MEANINGFUL_EVENT_TIMEOUT_MS;
  const resolved = await resolveCommandForSpawn(command, args);
  const child = spawn(resolved.command, resolved.args, {
    cwd: options.cwd,
    stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    shell: resolved.shell
  });
  if (options.stdin !== undefined) {
    child.stdin?.end(options.stdin);
  }

  let stdout = '';
  let stderr = '';
  let stdoutLineBuffer = '';
  let stderrLineBuffer = '';
  let timeoutReason: 'idle' | 'hard' | 'no_meaningful_event' | null = null;
  let transcriptChain = Promise.resolve();
  let transcriptError: unknown;
  let progressChain = Promise.resolve();
  let progressError: unknown;
  let preemptChain = Promise.resolve();
  let preemptError: unknown;
  let completionChain = Promise.resolve();
  let completionError: unknown;
  let preempted = false;
  let turnCompleted = false;
  let completedFromReceipt = false;
  const usage = emptyUsageSummary();
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let firstMeaningfulEventAt: number | null = null;

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
    for (const line of lines) {
      const eventType = consumeCodexLine(line, usage, scheduleProgress);
      if (isMeaningfulCodexEvent(eventType)) firstMeaningfulEventAt ??= Date.now();
      if (eventType === 'turn.completed') turnCompleted = true;
    }
    return nextBuffer;
  };

  const killForTimeout = (reason: NonNullable<typeof timeoutReason>) => {
    if (timeoutReason) return;
    timeoutReason = reason;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
  };

  const requestPreemptCheck = () => {
    if (!options.shouldPreempt || preempted || timeoutReason) return;
    preemptChain = preemptChain.then(async () => {
      if (preempted || timeoutReason || preemptError) return;
      try {
        if (await options.shouldPreempt?.()) {
          preempted = true;
          child.kill('SIGTERM');
          setTimeout(() => {
            if (preempted) child.kill('SIGKILL');
          }, 2_000).unref();
        }
      } catch (error) {
        preemptError = error;
      }
    });
  };

  const requestCompletionCheck = () => {
    if (!options.completionArtifactId || !turnCompleted || completedFromReceipt || timeoutReason) return;
    completionChain = completionChain.then(async () => {
      if (!options.completionArtifactId || !turnCompleted || completedFromReceipt || timeoutReason || completionError) return;
      try {
        await readIterResult(paths, options.completionArtifactId);
        completedFromReceipt = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (completedFromReceipt) child.kill('SIGKILL');
        }, 2_000).unref();
      } catch {
        // Codex can emit turn.completed just before --output-last-message is flushed.
      }
    }).catch((error: unknown) => {
      completionError = error;
    });
  };

  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - startedAt >= hardTimeoutMs) {
      killForTimeout('hard');
    } else if (!firstMeaningfulEventAt && now - startedAt >= firstMeaningfulEventTimeoutMs) {
      killForTimeout('no_meaningful_event');
    } else if (now - lastActivityAt >= idleTimeoutMs) {
      killForTimeout('idle');
    }
  }, Math.min(5_000, Math.max(50, Math.min(idleTimeoutMs, firstMeaningfulEventTimeoutMs))));
  watchdog.unref();

  const heartbeat = setInterval(() => {
    scheduleProgress({ kind: 'heartbeat' });
    requestCompletionCheck();
    requestPreemptCheck();
  }, heartbeatMs);
  heartbeat.unref();

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    markActivity();
    stdout = tailChars(stdout + chunk, OUTPUT_TAIL_CHARS);
    appendTranscript(chunk);
    stdoutLineBuffer = consumeLines(stdoutLineBuffer, chunk);
    requestCompletionCheck();
    requestPreemptCheck();
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    markActivity();
    stderr = tailChars(stderr + chunk, OUTPUT_TAIL_CHARS);
    appendTranscript(chunk);
    stderrLineBuffer = consumeLines(stderrLineBuffer, chunk);
    requestCompletionCheck();
    requestPreemptCheck();
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
    await preemptChain;
    await completionChain;
    throw new CodexRunError(`codex exec failed to start: ${error instanceof Error ? error.message : String(error)}`, cloneUsageSummary(usage));
  }

  clearInterval(watchdog);
  clearInterval(heartbeat);
  if (stdoutLineBuffer) {
    const eventType = consumeCodexLine(stdoutLineBuffer, usage, scheduleProgress);
    if (isMeaningfulCodexEvent(eventType)) firstMeaningfulEventAt ??= Date.now();
    if (eventType === 'turn.completed') turnCompleted = true;
  }
  if (stderrLineBuffer) {
    const eventType = consumeCodexLine(stderrLineBuffer, usage, scheduleProgress);
    if (isMeaningfulCodexEvent(eventType)) firstMeaningfulEventAt ??= Date.now();
    if (eventType === 'turn.completed') turnCompleted = true;
  }
  requestCompletionCheck();
  await transcriptChain;
  await progressChain;
  await preemptChain;
  await completionChain;

  if (transcriptError) {
    throw transcriptError;
  }
  if (progressError) {
    throw progressError;
  }
  if (preemptError) {
    throw preemptError;
  }
  if (completionError) {
    throw completionError;
  }
  if (preempted) {
    throw new ExecutorPreemptedError('Codex executor preempted to apply pending Chat input', cloneUsageSummary(usage));
  }

  const all = `${stdout}${stderr}`;
  if (timeoutReason === 'hard') {
    throw new CodexRunError(`Codex executor exceeded hard timeout after ${durationLabel(hardTimeoutMs)}`, cloneUsageSummary(usage));
  }
  if (timeoutReason === 'no_meaningful_event') {
    throw new CodexRunError(
      `Codex executor produced no actionable event after ${durationLabel(firstMeaningfulEventTimeoutMs)}; restarting via resume`,
      cloneUsageSummary(usage)
    );
  }
  if (timeoutReason === 'idle') {
    throw new CodexRunError(`Codex executor timed out after ${durationLabel(idleTimeoutMs)} without stdout/stderr output`, cloneUsageSummary(usage));
  }

  return {
    stdout,
    stderr,
    all,
    usage: cloneUsageSummary(usage),
    exitCode: completedFromReceipt ? 0 : exit.code,
    signal: exit.signal
  };
}

function consumeCodexLine(
  line: string,
  usage: ExecutorProgress['usage'],
  scheduleProgress: (progress: Omit<ExecutorProgress, 'usage' | 'wallMs' | 'idleMs'>) => void
): string | undefined {
  const delta = parseCodexRunEvents(line);
  mergeUsageSummary(usage, delta);
  const eventType = codexEventType(line);
  if (delta.events > 0 || delta.parse_errors) {
    scheduleProgress({ kind: 'event', eventType });
  }
  return eventType;
}

function isMeaningfulCodexEvent(eventType: string | undefined): boolean {
  return Boolean(eventType && eventType !== 'thread.started');
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
  if (target.errors.length > MAX_USAGE_ERRORS) target.errors = target.errors.slice(-MAX_USAGE_ERRORS);
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
  const lastMessagePath = join(paths.artifacts, `${artifactId}.txt`);
  if (await exists(path)) {
    const parsed = normalizeIterResult(JSON.parse(await readFile(path, 'utf8')) as IterResult);
    if (isStubNoopResult(parsed)) {
      const recovered = await readIterResultFromLastMessage(lastMessagePath);
      if (recovered && !isStubNoopResult(recovered)) {
        await atomicWriteJson(path, recovered);
        return recovered;
      }
    }
    return parsed;
  }

  const parsed = await readIterResultFromLastMessage(lastMessagePath);
  if (parsed) {
    await atomicWriteJson(path, parsed);
    return parsed;
  }

  throw new Error(`Executor did not write expected result file: ${path}`);
}

async function readIterResultFromLastMessage(path: string): Promise<IterResult | null> {
  if (!(await exists(path))) return null;
  const raw = (await readFile(path, 'utf8')).trim();
  if (!raw) return null;

  for (const candidate of iterResultJsonCandidates(raw)) {
    try {
      return normalizeIterResult(JSON.parse(candidate) as IterResult);
    } catch {
      // Try the next candidate; the last message may contain prose around JSON.
    }
  }

  return null;
}

function iterResultJsonCandidates(raw: string): string[] {
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(raw.slice(firstBrace, lastBrace + 1));
  return candidates;
}

function isStubNoopResult(result: IterResult): boolean {
  return (
    result.step_done === false &&
    result.tests_pass === false &&
    result.changed_files.length === 0 &&
    result.notes === 'Stub executor found no fixture hotpath.js; wrote a no-op result.'
  );
}

function normalizeIterResult(parsed: IterResult): IterResult {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Executor result was not a JSON object');
  }
  if (typeof parsed.step_done !== 'boolean' || typeof parsed.tests_pass !== 'boolean' || typeof parsed.notes !== 'string') {
    throw new Error('Executor result JSON missing required step_done/tests_pass/notes fields');
  }
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

  if (result.changed_files.length > 0) {
    await commitStubExecutorChanges(paths, result.changed_files, stepId);
  }
  await atomicWriteJson(join(paths.artifacts, `iter-${iter}.json`), result);
  return result;
}

async function commitStubExecutorChanges(paths: RunPaths, changedFiles: string[], stepId: string): Promise<void> {
  const status = await execa('git', ['-C', paths.target, 'status', '--porcelain', '--', ...changedFiles], { reject: false });
  if (status.exitCode !== 0 || !status.stdout.trim()) return;
  await execa('git', ['-C', paths.target, 'add', '--', ...changedFiles]);
  const commit = await execa('git', ['-C', paths.target, 'commit', '-m', `test: stub executor complete ${stepId}`], { reject: false, all: true });
  if (commit.exitCode !== 0) {
    throw new Error(`Stub executor failed to commit changed files: ${commit.all ?? commit.stderr}`);
  }
}

export function buildExecutorArgs(input: {
  iter: number;
  target: string;
  artifactPath: string;
  schemaPath: string;
  prompt: string;
  resume?: boolean;
  model?: string;
  effort?: string;
}): string[] & { stdin?: string } {
  if (!(input.resume ?? input.iter > 1)) {
    return withStdinPrompt([
      'exec',
      ...modelArgs(input.model),
      ...codexEffortArgs(input.effort),
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      '--output-last-message',
      input.artifactPath,
      '--output-schema',
      input.schemaPath,
      '-C',
      input.target,
      '--skip-git-repo-check',
      '-'
    ], input.prompt);
  }

  return withStdinPrompt([
    'exec',
    'resume',
    '--last',
    ...modelArgs(input.model),
    ...codexEffortArgs(input.effort),
    '--dangerously-bypass-approvals-and-sandbox',
    '--json',
    '--output-last-message',
    input.artifactPath,
    '--output-schema',
    input.schemaPath,
    '--skip-git-repo-check',
    '-'
  ], input.prompt);
}

function withStdinPrompt(args: string[], prompt: string): string[] & { stdin?: string } {
  return Object.assign(args, { stdin: prompt });
}

function modelArgs(model: string | undefined): string[] {
  const normalized = model?.trim();
  if (!normalized || normalized === 'default') return [];
  return ['--model', normalized];
}

export function codexEffortArgs(effort: string | undefined): string[] {
  const normalized = effort?.trim();
  if (!normalized || normalized === 'default') return [];
  return ['-c', `model_reasoning_effort=${JSON.stringify(normalized)}`];
}
