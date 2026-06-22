import { chmod, readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join, relative } from 'node:path';
import { atomicWriteFile, atomicWriteJson, exists, makeReadOnly, makeWritable } from '../shared/atomic.js';
import { commandExists } from '../shared/commands.js';
import { promptPath, type RunPaths } from '../shared/paths.js';
import type { EvalSha256, GoalFile, ToolInvocationResult, WiCiConfig } from '../shared/types.js';
import { runtimeAgentFromCommand } from '../shared/runtime.js';
import { applyPlanDiff } from './plan.js';
import { type PlannerBenchmark, writeBenchmarkManifest } from './benchmark.js';
import { appendSafety, formatSafetyForPrompt } from './safety.js';
import { isPlannerSelectedMetricName, primaryMetricName } from './metricFormat.js';
import { isClaudeEnvelope, parseClaudeJsonOutput, type ClaudeUsage } from './claudeOutput.js';
import { runClaudeStreamProcess } from './claudeProcess.js';
import { saveGoalFiles } from './goalDoc.js';
import { isTransientNetworkFailure, transientFailureReason, transientRetryDelayMs, type TransientRetryInfo } from './transientRetry.js';

interface PlannerOutput {
  session_id?: string;
  goalMarkdown?: string;
  planMarkdown?: string;
  measureSh?: string;
  checksSh?: string;
}

export interface PlannerQuestion {
  session_id?: string;
  question: string;
  questions?: string[];
  reason?: string;
}

export type PlannerResponse = { kind: 'plan'; output: PlannerOutput } | { kind: 'question'; question: PlannerQuestion };

export type PlannerInvocationResult = ToolInvocationResult & {
  needsInput?: PlannerQuestion;
};

export interface PlannerUsageProgress {
  eventType?: string;
  sessionId?: string;
  totalCostUsd?: number;
  usage: ClaudeUsage;
}

export type PlannerRetryProgress = TransientRetryInfo;

export interface PlannerClarificationResume {
  sessionId?: string;
  question?: string;
  answer: string;
}

const PLANNER_IDLE_TIMEOUT_MS = 10 * 60_000;
const PLANNER_HARD_TIMEOUT_MS = 60 * 60_000;

function requirementText(goal: GoalFile): string {
  return goal.requirements.filter((req) => req.status === 'active').map((req) => req.text).join('\n');
}

export function extractStructured(raw: string): PlannerOutput {
  const response = extractPlannerResponse(raw);
  if (response.kind === 'plan') return response.output;
  throw new Error(`Planner requested clarification instead of plan artifacts: ${response.question.question}`);
}

export function extractPlannerResponse(raw: string): PlannerResponse {
  const parsed = parseClaudeJsonOutput(raw);
  let plannerError: string | undefined;
  for (const item of [...parsed].reverse()) {
    const output = plannerOutputFromCandidate(item);
    if (output) return { kind: 'plan', output };
    const question = plannerQuestionFromCandidate(item);
    if (question) return { kind: 'question', question };
    if (isClaudeEnvelope(item) && item.is_error) {
      const result = typeof item.result === 'string' ? item.result : JSON.stringify(item.result);
      plannerError = result || item.subtype || 'planner reported an error';
    }
  }
  throw new Error(plannerError ?? 'Planner output did not contain structured plan artifacts');
}

export async function runInitialPlanner(
  paths: RunPaths,
  goal: GoalFile,
  config: WiCiConfig,
  onProgress?: (progress: PlannerUsageProgress) => Promise<void>,
  onRetry?: (retry: PlannerRetryProgress) => Promise<void>,
  resume?: PlannerClarificationResume
): Promise<PlannerInvocationResult> {
  const available = await commandExists(config.tools.planner.command);
  const plannerAgent = runtimeAgentFromCommand(config.tools.planner.command, 'codex');
  if (config.tools.mode !== 'stub') {
    const systemPrompt = await readFile(promptPath('planner'), 'utf8');
    const safetyText = formatSafetyForPrompt(config);
    const goalText = await readPlannerGoalText(paths, goal);
    if (plannerAgent === 'codex' && available) {
      try {
        const result = await runCodexInitialPlanner(paths, goalText, config, systemPrompt, safetyText, resume);
        if (result) return result;
      } catch (error) {
        if (config.tools.mode === 'real') throw error;
      }
    }
    try {
      if (!available) throw new Error(`Planner command not found: ${config.tools.planner.command}`);
      const args =
        resume?.sessionId
          ? buildInitialPlannerResumeArgs({
              goalText,
              effort: config.tools.planner.effort,
              model: config.tools.planner.model,
              systemPrompt,
              safetyText,
              sessionId: resume.sessionId,
              question: resume.question,
              answer: resume.answer
            })
          : buildInitialPlannerArgs({
              goalText: resume ? appendClarificationAnswer(goalText, resume) : goalText,
              effort: config.tools.planner.effort,
              model: config.tools.planner.model,
              systemPrompt,
              safetyText
            });
      const result = await runPlannerProcess(
        config.tools.planner.command,
        args,
        {
          cwd: paths.target,
          onProgress,
          onRetry
        }
      );
      await persistPlannerRaw(paths, resume ? 'initial-resume' : 'initial', result);
      const response = extractPlannerResponse(result.stdout);
      if (response.kind === 'question') {
        return {
          ok: false,
          sessionId: response.question.session_id,
          stdout: result.all ?? result.stdout,
          error: 'Planner requested clarification',
          needsInput: response.question
        };
      }
      await materializePlannerOutput(paths, response.output);
      return { ok: true, sessionId: response.output.session_id, stdout: result.all ?? result.stdout };
    } catch (error) {
      const fallback = plannerAgent === 'claude'
        ? await runCodexInitialPlanner(paths, goalText, config, systemPrompt, safetyText, resume, error)
        : null;
      if (fallback) return fallback;
      if (config.tools.mode === 'real') throw error;
    }
  }

  await materializeStubPlan(paths, goal);
  return { ok: true, sessionId: 'stub-planner', stdout: 'stub planner materialized PLAN.md and .opt scripts' };
}

export async function runPlanDiff(
  paths: RunPaths,
  goal: GoalFile,
  plannerSessionId: string | undefined,
  newText: string,
  config: WiCiConfig,
  onProgress?: (progress: PlannerUsageProgress) => Promise<void>,
  onRetry?: (retry: PlannerRetryProgress) => Promise<void>
): Promise<PlannerInvocationResult> {
  const available = await commandExists(config.tools.planner.command);
  const plannerAgent = runtimeAgentFromCommand(config.tools.planner.command, 'codex');

  if (config.tools.mode !== 'stub') {
    const systemPrompt = await readFile(promptPath('planner-diff'), 'utf8');
    const plan = await readFile(paths.plan, 'utf8');
    const safetyText = formatSafetyForPrompt(config);
    const goalText = await readPlannerGoalText(paths, goal);
    if (plannerAgent === 'codex' && available) {
      try {
        const result = await runCodexPlanDiff(paths, goalText, plan, newText, plannerSessionId, config, systemPrompt, safetyText);
        if (result) return result;
      } catch (error) {
        if (config.tools.mode === 'real') throw error;
      }
    }
    try {
      if (!plannerSessionId || plannerSessionId === 'stub-planner') throw new Error('Planner resume session is required for Claude plan diffs');
      if (!available) throw new Error(`Planner command not found: ${config.tools.planner.command}`);
      const result = await runPlannerProcess(
        config.tools.planner.command,
        buildPlanDiffArgs({
          newText,
          currentPlan: plan,
          goalText,
          sessionId: plannerSessionId,
          effort: config.tools.planner.effort,
          model: config.tools.planner.model,
          systemPrompt,
          safetyText
        }),
        { cwd: paths.target, onProgress, onRetry }
      );
      await persistPlannerRaw(paths, `diff-${Date.now()}`, result);
      const response = extractPlannerResponse(result.stdout);
      if (response.kind === 'question') {
        return {
          ok: false,
          sessionId: response.question.session_id ?? plannerSessionId,
          stdout: result.all ?? result.stdout,
          error: 'Planner requested clarification',
          needsInput: response.question
        };
      }
      await materializePlannerOutput(paths, response.output);
      return { ok: true, sessionId: plannerSessionId, stdout: result.all ?? result.stdout };
    } catch (error) {
      const fallback = plannerAgent === 'claude'
        ? await runCodexPlanDiff(paths, goalText, plan, newText, undefined, config, systemPrompt, safetyText, error)
        : null;
      if (fallback) return fallback;
      if (config.tools.mode === 'real') throw error;
    }
  }

  const plan = await readFile(paths.plan, 'utf8');
  const nextId = `S${(plan.match(/-\s+\[[ x>!]\]\s+S\d+/g)?.length ?? 0) + 1}`;
  await applyPlanDiff(paths, {
    add: [{ after: 'S9999', id: nextId, text: `Incorporate new requirement: ${newText}` }]
  });
  return { ok: true, sessionId: plannerSessionId ?? 'stub-planner', stdout: 'stub planner applied requirement diff' };
}

export function buildInitialPlannerArgs(input: { goalText: string; effort: string; model?: string; systemPrompt: string; safetyText?: string }): string[] {
  return [
    '-p',
    `Plan for goal:\n${input.goalText}`,
    '--output-format',
    'stream-json',
    '--verbose',
    ...plannerModelArgs(input.model),
    ...plannerEffortArgs(input.effort),
    '--permission-mode',
    'plan',
    '--dangerously-skip-permissions',
    '--append-system-prompt',
    appendSafety(input.systemPrompt, input.safetyText ?? '')
  ];
}

export function buildInitialPlannerResumeArgs(input: {
  goalText: string;
  effort: string;
  model?: string;
  systemPrompt: string;
  safetyText?: string;
  sessionId: string;
  question?: string;
  answer: string;
}): string[] {
  return [
    '-p',
    `Planner clarification answer:\nQuestion: ${input.question ?? '(not recorded)'}\nAnswer:\n${input.answer}\n\nCurrent GOAL.md:\n${input.goalText}\n\nContinue planning for GOAL.md and return markdown planner artifacts.`,
    '--resume',
    input.sessionId,
    '--output-format',
    'stream-json',
    '--verbose',
    ...plannerModelArgs(input.model),
    ...plannerEffortArgs(input.effort),
    '--permission-mode',
    'plan',
    '--dangerously-skip-permissions',
    '--append-system-prompt',
    appendSafety(input.systemPrompt, input.safetyText ?? '')
  ];
}

function plannerEffortArgs(effort: string | undefined): string[] {
  const normalized = effort?.trim();
  if (!normalized || normalized === 'default') return [];
  return ['--effort', normalized];
}

function plannerModelArgs(model: string | undefined): string[] {
  const normalized = model?.trim();
  if (!normalized || normalized === 'default') return [];
  return ['--model', normalized];
}

export function buildCodexPlannerArgs(input: {
  target: string;
  prompt: string;
  outputLastMessage: string;
  model?: string;
  effort?: string;
  resumeSessionId?: string;
}): string[] {
  if (input.resumeSessionId) {
    return [
      'exec',
      'resume',
      ...codexModelArgs(input.model),
      ...codexEffortArgs(input.effort),
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      '--output-last-message',
      input.outputLastMessage,
      '--skip-git-repo-check',
      input.resumeSessionId,
      input.prompt
    ];
  }
  return [
    'exec',
    ...codexModelArgs(input.model),
    ...codexEffortArgs(input.effort),
    '--sandbox',
    'danger-full-access',
    '--json',
    '--output-last-message',
    input.outputLastMessage,
    '-C',
    input.target,
    '--skip-git-repo-check',
    input.prompt
  ];
}

function codexModelArgs(model: string | undefined): string[] {
  const normalized = model?.trim();
  if (!normalized || normalized === 'default') return [];
  return ['--model', normalized];
}

function codexEffortArgs(effort: string | undefined): string[] {
  const normalized = effort?.trim();
  if (!normalized || normalized === 'default') return [];
  return ['-c', `model_reasoning_effort=${JSON.stringify(normalized)}`];
}

export function buildPlanDiffArgs(input: {
  newText: string;
  currentPlan: string;
  goalText: string;
  sessionId: string;
  effort?: string;
  model?: string;
  systemPrompt: string;
  safetyText?: string;
}): string[] {
  return [
    '-p',
    `New requirement: ${input.newText}\n\nCurrent GOAL.md:\n${input.goalText}\n\nCurrent PLAN.md:\n${input.currentPlan}`,
    '--resume',
    input.sessionId,
    '--output-format',
    'stream-json',
    '--verbose',
    ...plannerModelArgs(input.model),
    ...plannerEffortArgs(input.effort),
    '--permission-mode',
    'plan',
    '--dangerously-skip-permissions',
    '--append-system-prompt',
    appendSafety(input.systemPrompt, input.safetyText ?? '')
  ];
}

function appendClarificationAnswer(goalText: string, resume: PlannerClarificationResume): string {
  return `${goalText}\n\n## Planner Clarification Answer\n\nQuestion: ${resume.question ?? '(not recorded)'}\n\nAnswer: ${resume.answer}\n`;
}

async function persistPlannerRaw(paths: RunPaths, label: string, result: { stdout: string; all: string }): Promise<void> {
  await atomicWriteFile(join(paths.artifacts, `planner-${label}.stdout.jsonl`), result.stdout);
  await atomicWriteFile(join(paths.artifacts, `planner-${label}.all.log`), result.all);
}

async function readTextIfExists(path: string): Promise<string> {
  return (await exists(path)) ? readFile(path, 'utf8') : '';
}

async function runCodexInitialPlanner(
  paths: RunPaths,
  goalText: string,
  config: WiCiConfig,
  systemPrompt: string,
  safetyText: string,
  resume?: PlannerClarificationResume,
  previousError?: unknown
): Promise<PlannerInvocationResult | null> {
  const command = 'codex';
  if (!(await commandExists(command))) return null;
  const label = resume ? 'initial-resume-codex' : 'initial-codex';
  const prompt = buildCodexInitialPlannerPrompt({ goalText, systemPrompt, safetyText, resume, previousError });
  const resumeSessionId = previousError ? undefined : resume?.sessionId;
  return runCodexPlannerProcess(paths, command, label, prompt, {
    model: codexPlannerModel(config),
    effort: codexPlannerEffort(config),
    sessionId: resumeSessionId && resumeSessionId !== 'stub-planner' ? resumeSessionId : undefined
  });
}

async function runCodexPlanDiff(
  paths: RunPaths,
  goalText: string,
  currentPlan: string,
  newText: string,
  plannerSessionId: string | undefined,
  config: WiCiConfig,
  systemPrompt: string,
  safetyText: string,
  previousError?: unknown
): Promise<PlannerInvocationResult | null> {
  const command = 'codex';
  if (!(await commandExists(command))) return null;
  const prompt = buildCodexPlanDiffPrompt({ goalText, currentPlan, newText, systemPrompt, safetyText, previousError });
  return runCodexPlannerProcess(paths, command, `diff-codex-${Date.now()}`, prompt, {
    model: codexPlannerModel(config),
    effort: codexPlannerEffort(config),
    sessionId: plannerSessionId && plannerSessionId !== 'stub-planner' ? plannerSessionId : undefined
  });
}

async function runCodexPlannerProcess(
  paths: RunPaths,
  command: string,
  label: string,
  prompt: string,
  runtime: { model?: string; effort?: string; sessionId?: string }
): Promise<PlannerInvocationResult | null> {
  const outputLastMessage = join(paths.artifacts, `${label}.last-message.md`);
  const result = await runClaudeStreamProcess(
    command,
    buildCodexPlannerArgs({
      target: paths.target,
      prompt,
      outputLastMessage,
      model: runtime.model,
      effort: runtime.effort,
      resumeSessionId: runtime.sessionId
    }),
    {
      cwd: paths.target,
      idleTimeoutMs: PLANNER_IDLE_TIMEOUT_MS,
      hardTimeoutMs: PLANNER_HARD_TIMEOUT_MS
    }
  );
  await persistPlannerRaw(paths, label, result);
  if (result.timeoutReason || result.exitCode !== 0) {
    if (result.timeoutReason) throw new Error(`Codex planner timed out (${result.timeoutReason})`);
    throw new Error(`Codex planner exited with code ${result.exitCode ?? `signal ${result.signal}`}`);
  }
  const finalMessage = (await readTextIfExists(outputLastMessage)) || codexPlannerTextFromJsonLines(result.stdout);
  const response = parseCodexPlannerResponse(finalMessage, extractCodexSessionId(result.stdout) ?? runtime.sessionId);
  if (!response) throw new Error('Codex planner output did not contain markdown planner artifacts');
  if (response.kind === 'question') {
    return {
      ok: false,
      sessionId: response.question.session_id,
      stdout: result.all ?? result.stdout,
      error: 'Planner requested clarification',
      needsInput: response.question
    };
  }
  await materializePlannerOutput(paths, response.output);
  return { ok: true, sessionId: response.output.session_id, stdout: result.all ?? result.stdout };
}

function buildCodexInitialPlannerPrompt(input: {
  goalText: string;
  systemPrompt: string;
  safetyText: string;
  resume?: PlannerClarificationResume;
  previousError?: unknown;
}): string {
  const goalText = input.resume ? appendClarificationAnswer(input.goalText, input.resume) : input.goalText;
  return [
    appendSafety(input.systemPrompt, input.safetyText),
    '',
    'Run as the Thinkless planner through Codex. Return markdown planner artifacts exactly as the planner prompt requests.',
    input.previousError ? `\nClaude planner was unavailable or failed; continue with Codex fallback. Failure: ${errorMessage(input.previousError)}` : '',
    '',
    `Plan for goal:\n${goalText}`
  ].join('\n');
}

function buildCodexPlanDiffPrompt(input: {
  goalText: string;
  currentPlan: string;
  newText: string;
  systemPrompt: string;
  safetyText: string;
  previousError?: unknown;
}): string {
  return [
    appendSafety(input.systemPrompt, input.safetyText),
    '',
    'Run as the Thinkless planner-diff agent through Codex. Return markdown planner artifacts exactly as the planner-diff prompt requests.',
    input.previousError ? `\nClaude planner diff was unavailable or failed; continue with Codex fallback. Failure: ${errorMessage(input.previousError)}` : '',
    '',
    `New requirement: ${input.newText}`,
    `\nCurrent GOAL.md:\n${input.goalText}`,
    `\nCurrent PLAN.md:\n${input.currentPlan}`
  ].join('\n');
}

function codexPlannerModel(config: WiCiConfig): string {
  return config.tools.planner.model?.trim() || 'gpt-5.5';
}

function codexPlannerEffort(config: WiCiConfig): string {
  return config.tools.planner.effort?.trim() || 'xhigh';
}

function parseCodexPlannerResponse(text: string, sessionId?: string): PlannerResponse | null {
  const question = plannerMarkdownQuestionFromText(text, sessionId);
  if (question) return { kind: 'question', question };
  const output = plannerMarkdownOutputFromText(text, sessionId);
  return output ? { kind: 'plan', output } : null;
}

function codexPlannerTextFromJsonLines(raw: string): string {
  const lines = raw.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of [...lines].reverse()) {
    const record = parseJsonRecord(line);
    if (!record) continue;
    const item = recordValue(recordValue(record.params)?.item) ?? recordValue(record.item) ?? record;
    const text = stringValue(item.text) ?? stringValue(item.message) ?? stringValue(record.message);
    if (text) return text;
  }
  return raw;
}

function extractCodexSessionId(raw: string): string | undefined {
  for (const line of raw.split(/\r?\n/)) {
    const record = parseJsonRecord(line.trim());
    if (!record) continue;
    const direct =
      stringValue(record.session_id) ??
      stringValue(record.sessionId) ??
      stringValue(record.thread_id) ??
      stringValue(record.threadId) ??
      stringValue(record.conversation_id);
    if (direct) return direct;
    const params = recordValue(record.params);
    const fromParams = stringValue(params?.threadId) ?? stringValue(params?.thread_id) ?? stringValue(recordValue(params?.thread)?.id);
    if (fromParams) return fromParams;
  }
  return undefined;
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runPlannerProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    onProgress?: (progress: PlannerUsageProgress) => Promise<void>;
    onRetry?: (retry: PlannerRetryProgress) => Promise<void>;
  }
): Promise<{ stdout: string; all: string }> {
  for (let attempt = 1; ; attempt += 1) {
    let progressChain = Promise.resolve();
    let lastUsageSignature = '';
    const emitProgress = (line: string) => {
      const progress = plannerProgressFromLine(line);
      if (!progress || !options.onProgress) return;
      const signature = JSON.stringify(progress);
      if (signature === lastUsageSignature) return;
      lastUsageSignature = signature;
      progressChain = progressChain.then(() => options.onProgress?.(progress)).then(() => undefined);
    };

    const result = await runClaudeStreamProcess(command, args, {
      cwd: options.cwd,
      idleTimeoutMs: PLANNER_IDLE_TIMEOUT_MS,
      hardTimeoutMs: PLANNER_HARD_TIMEOUT_MS,
      onLine: emitProgress
    });
    await progressChain;

    const stderr = result.stderr;
    if (result.timeoutReason === 'hard') {
      throw new Error(`Planner exceeded hard timeout after ${Math.round(PLANNER_HARD_TIMEOUT_MS / 1000)}s without producing PLAN.md artifacts`);
    }
    if (result.timeoutReason === 'idle') {
      throw new Error(`Planner timed out after ${Math.round(PLANNER_IDLE_TIMEOUT_MS / 1000)}s without planner output`);
    }
    if (result.exitCode !== 0) {
      const detail = summarizePlannerFailure(result.stdout, stderr);
      const combined = `${result.stdout}\n${stderr}\n${detail}`;
      if (isTransientNetworkFailure(combined)) {
        const retry = { attempt, delayMs: transientRetryDelayMs(), reason: transientFailureReason(combined) };
        await options.onRetry?.(retry);
        await delay(retry.delayMs);
        continue;
      }
      throw new Error(`Planner exited with code ${result.exitCode ?? `signal ${result.signal}`}${detail ? `: ${detail}` : ''}`);
    }
    return { stdout: result.stdout, all: result.all };
  }
}

function summarizePlannerFailure(stdout: string, stderr: string): string {
  const stderrText = stderr.trim();
  try {
    const parsed = parseClaudeJsonOutput(stdout);
    for (const item of [...parsed].reverse()) {
      if (!isClaudeEnvelope(item)) continue;
      if (typeof item.result === 'string' && item.result.trim()) return item.result.trim().slice(0, 1000);
      const text = textFromClaudeMessage(item);
      if (text) return text.slice(0, 1000);
      const error = stringField(item, 'error');
      if (error) return error.slice(0, 1000);
    }
  } catch {
    // Fall through to raw stream summary.
  }
  return (stderrText || stdout.trim()).slice(0, 1000);
}

function textFromClaudeMessage(item: unknown): string | null {
  if (!item || typeof item !== 'object' || !('message' in item)) return null;
  const message = (item as { message?: unknown }).message;
  if (!message || typeof message !== 'object' || !('content' in message)) return null;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const type = stringField(part, 'type');
    const text = stringField(part, 'text');
    if (type === 'text' && text?.trim()) return text.trim();
  }
  return null;
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || !(key in value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.trim() ? field.trim() : null;
}

export function plannerProgressFromLine(line: string): PlannerUsageProgress | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isClaudeEnvelope(parsed)) return null;
    const usage = parsed.message?.usage ?? parsed.usage;
    if (!usage) return null;
    return {
      eventType: parsed.type,
      sessionId: parsed.session_id,
      totalCostUsd: parsed.total_cost_usd,
      usage
    };
  } catch {
    return null;
  }
}

function plannerOutputFromCandidate(candidate: unknown): PlannerOutput | null {
  if (!isClaudeEnvelope(candidate) || candidate.result === undefined || candidate.result === null) return null;
  if (typeof candidate.result !== 'string') return null;
  return plannerMarkdownOutputFromText(candidate.result, candidate.session_id);
}

function plannerQuestionFromCandidate(candidate: unknown): PlannerQuestion | null {
  if (!isClaudeEnvelope(candidate) || candidate.result === undefined || candidate.result === null) return null;
  if (typeof candidate.result !== 'string') return null;
  return plannerMarkdownQuestionFromText(candidate.result, candidate.session_id);
}

function plannerMarkdownOutputFromText(text: string, sessionId?: string): PlannerOutput | null {
  const goalMarkdown = extractMarkdownArtifact(text, 'GOAL.md');
  const planMarkdown = extractMarkdownArtifact(text, 'PLAN.md');
  if (!planMarkdown) return null;
  const checksSh = extractMarkdownArtifact(text, '.opt/checks.sh') ?? extractMarkdownArtifact(text, 'checks.sh');
  const measureSh = extractMarkdownArtifact(text, '.opt/measure.sh') ?? extractMarkdownArtifact(text, 'measure.sh');
  return {
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(goalMarkdown ? { goalMarkdown } : {}),
    planMarkdown,
    ...(checksSh ? { checksSh } : {}),
    ...(measureSh ? { measureSh } : {})
  };
}

function plannerMarkdownQuestionFromText(text: string, sessionId?: string): PlannerQuestion | null {
  const question = extractMarkdownArtifact(text, 'CLARIFY') ?? extractMarkdownArtifact(text, 'QUESTION');
  if (!question) return null;
  return {
    ...(sessionId ? { session_id: sessionId } : {}),
    question: question.trim()
  };
}

function extractMarkdownArtifact(text: string, label: string): string | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const headingIndex = lines.findIndex((line) => markdownHeadingLabel(line) === label.toLowerCase());
  if (headingIndex < 0) return undefined;

  const bodyEnd = nextPlannerArtifactHeadingIndex(lines, headingIndex + 1);
  const body = lines.slice(headingIndex + 1, bodyEnd);
  const content = unwrapOuterFence(body).join('\n').trim();
  return content || undefined;
}

const PLANNER_ARTIFACT_HEADINGS = new Set(['goal.md', 'plan.md', '.opt/checks.sh', 'checks.sh', '.opt/measure.sh', 'measure.sh', 'question', 'clarify']);

function nextPlannerArtifactHeadingIndex(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    const label = markdownHeadingLabel(lines[index] ?? '');
    if (label && PLANNER_ARTIFACT_HEADINGS.has(label)) return index;
  }
  return lines.length;
}

function unwrapOuterFence(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim() === '') start += 1;
  while (end > start && (lines[end - 1] ?? '').trim() === '') end -= 1;
  if (end - start < 2) return lines.slice(start, end);
  if (!/^\s*```[A-Za-z0-9_-]*\s*$/.test(lines[start] ?? '')) return lines.slice(start, end);
  if (!/^\s*```\s*$/.test(lines[end - 1] ?? '')) return lines.slice(start, end);
  return lines.slice(start + 1, end - 1);
}

function markdownHeadingLabel(line: string): string | null {
  const match = /^#{1,6}\s+(.+?)\s*$/.exec(line.trim());
  return match ? match[1].replace(/`/g, '').trim().toLowerCase() : null;
}

async function applyPlannerPlanUpdate(paths: RunPaths, raw: string): Promise<void> {
  const response = extractPlannerResponse(raw);
  if (response.kind === 'question') {
    throw new Error(`Planner requested clarification during plan update: ${response.question.question}`);
  }
  await materializePlannerOutput(paths, response.output);
}

async function readPlannerGoalText(paths: RunPaths, goal: GoalFile): Promise<string> {
  return (await exists(paths.goalDoc)) ? readFile(paths.goalDoc, 'utf8') : requirementText(goal);
}

async function materializePlannerOutput(paths: RunPaths, output: PlannerOutput): Promise<void> {
  if (!output.planMarkdown) {
    throw new Error('Planner output missing PLAN.md artifact');
  }
  await atomicWriteFile(paths.plan, ensureExecutableChecklist(output.planMarkdown));
  if (output.measureSh) await atomicWriteFile(paths.measure, ensureScript(output.measureSh), 0o755);
  if (output.checksSh) await atomicWriteFile(paths.checks, ensureScript(output.checksSh), 0o755);
  if (output.goalMarkdown) await atomicWriteFile(paths.goalDoc, ensureTrailingNewline(output.goalMarkdown));
  if (output.measureSh) await chmod(paths.measure, 0o755);
  if (output.checksSh) await chmod(paths.checks, 0o755);
}

function ensureExecutableChecklist(planMarkdown: string): string {
  return ensureTrailingNewline(planMarkdown);
}

async function materializeStubPlan(paths: RunPaths, goal: GoalFile): Promise<void> {
  const selectedGoal = {
    ...goal,
    metric:
      isPlannerSelectedMetricName(goal.metric.name)
        ? {
            name: 'fixture runtime',
            direction: 'minimize' as const,
            target: null,
            unit: 'ms'
          }
        : goal.metric
  };
  const metricName = primaryMetricName(selectedGoal);
  const plan = `# WiCi Execution Plan

Goal: ${requirementText(goal) || 'Execute the requested goal and validate it.'}

- [ ] S1 Replace avoidable quadratic hot-path work with a linear implementation
  - Action: inspect the fixture hot path and remove nested scans or redundant recomputation.
  - Validation: ./.opt/checks.sh && ./.opt/measure.sh
- [ ] S2 Re-run measurement and commit only if ${metricName} improves beyond the configured noise gate
  - Action: validate the optimized path against the planner-selected fixture runtime check.
  - Validation: ./.opt/checks.sh && ./.opt/measure.sh
`;

  const checks = `#!/usr/bin/env bash
set -euo pipefail
node test.mjs
`;

  const measure = `#!/usr/bin/env bash
set -euo pipefail
node measure.mjs
`;

  await atomicWriteFile(paths.plan, plan);
  await atomicWriteFile(paths.measure, checksExecutable(measure), 0o755);
  await atomicWriteFile(paths.checks, checksExecutable(checks), 0o755);
  const manifest = await writeBenchmarkManifest(paths, selectedGoal, {
    tool: 'node',
    command: './.opt/measure.sh',
    metric: selectedGoal.metric.name,
    direction: selectedGoal.metric.direction,
    target: selectedGoal.metric.target ?? null,
    unit: selectedGoal.metric.unit,
    min_reps: 5,
    warmup_discarded: 2,
    reason: `Fixture target uses a deterministic Node workload through .opt/measure.sh; it emits WiCi ${metricName} samples for the planner-selected validation.`
  });
  await saveGoalFiles(paths, {
    ...selectedGoal,
    metric: {
      name: manifest.metric,
      direction: manifest.direction,
      target: manifest.target ?? null,
      unit: manifest.unit
    }
  });
  await chmod(paths.measure, 0o755);
  await chmod(paths.checks, 0o755);
}

function ensureScript(script: string): string {
  const text = ensureTrailingNewline(script);
  return text.startsWith('#!') ? text : `#!/usr/bin/env bash\nset -euo pipefail\n${text}`;
}

function checksExecutable(script: string): string {
  return ensureTrailingNewline(script);
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

export async function lockEvalScripts(paths: RunPaths): Promise<EvalSha256> {
  const hashes = await evalHashes(paths);
  await makeReadOnly(paths.measure);
  await makeReadOnly(paths.checks);
  if (await exists(paths.benchmarkManifest)) await makeReadOnly(paths.benchmarkManifest);
  if (await exists(paths.acceptanceSpec)) await makeReadOnly(paths.acceptanceSpec);
  if (await exists(paths.prescreen)) await makeReadOnly(paths.prescreen);
  if (await exists(paths.validate)) await makeReadOnly(paths.validate);
  if (await exists(paths.selftestGoodPatch)) await makeReadOnly(paths.selftestGoodPatch);
  if (await exists(paths.selftestBadPatch)) await makeReadOnly(paths.selftestBadPatch);
  for (const file of Object.keys(hashes.files ?? {})) {
    await makeReadOnly(join(paths.target, file)).catch(() => undefined);
  }
  return hashes;
}

export async function unlockEvalScripts(paths: RunPaths): Promise<void> {
  if (await exists(paths.measure)) await makeWritable(paths.measure);
  if (await exists(paths.checks)) await makeWritable(paths.checks);
  if (await exists(paths.benchmarkManifest)) await makeWritable(paths.benchmarkManifest);
  if (await exists(paths.acceptanceSpec)) await makeWritable(paths.acceptanceSpec);
  if (await exists(paths.prescreen)) await makeWritable(paths.prescreen);
  if (await exists(paths.validate)) await makeWritable(paths.validate);
  if (await exists(paths.selftestGoodPatch)) await makeWritable(paths.selftestGoodPatch);
  if (await exists(paths.selftestBadPatch)) await makeWritable(paths.selftestBadPatch);
}

export async function evalHashes(paths: RunPaths): Promise<EvalSha256> {
  const guardFiles = await discoverGuardFiles(paths);
  const files: Record<string, string> = {};
  for (const file of guardFiles) {
    files[file] = await sha256File(join(paths.target, file));
  }
  return {
    measure: await sha256File(paths.measure),
    checks: await sha256File(paths.checks),
    ...((await exists(paths.benchmarkManifest)) ? { benchmark_manifest: await sha256File(paths.benchmarkManifest) } : {}),
    ...((await exists(paths.acceptanceSpec)) ? { acceptance_spec: await sha256File(paths.acceptanceSpec) } : {}),
    ...((await exists(paths.prescreen)) ? { prescreen: await sha256File(paths.prescreen) } : {}),
    ...((await exists(paths.validate)) ? { validate: await sha256File(paths.validate) } : {}),
    ...((await exists(paths.selftestGoodPatch)) ? { selftest_good_patch: await sha256File(paths.selftestGoodPatch) } : {}),
    ...((await exists(paths.selftestBadPatch)) ? { selftest_bad_patch: await sha256File(paths.selftestBadPatch) } : {}),
    files
  };
}

async function sha256File(path: string): Promise<string> {
  const raw = await readFile(path);
  return createHash('sha256').update(raw).digest('hex');
}

export async function verifyEvalHashes(paths: RunPaths, expected: EvalSha256): Promise<void> {
  const actual = await evalHashes(paths);
  if (actual.measure !== expected.measure || actual.checks !== expected.checks) {
    throw new Error(`eval_sha256 mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  if (actual.validate !== expected.validate) {
    throw new Error(`eval_sha256 mismatch for validate.sh: expected ${expected.validate ?? 'missing'}, got ${actual.validate ?? 'missing'}`);
  }
  if (actual.benchmark_manifest !== expected.benchmark_manifest) {
    throw new Error(
      `eval_sha256 mismatch for .opt/benchmark.json: expected ${expected.benchmark_manifest ?? 'missing'}, got ${actual.benchmark_manifest ?? 'missing'}`
    );
  }
  if (actual.acceptance_spec !== expected.acceptance_spec) {
    throw new Error(
      `eval_sha256 mismatch for acceptance.spec.json: expected ${expected.acceptance_spec ?? 'missing'}, got ${actual.acceptance_spec ?? 'missing'}`
    );
  }
  if (actual.prescreen !== expected.prescreen) {
    throw new Error(`eval_sha256 mismatch for prescreen.sh: expected ${expected.prescreen ?? 'missing'}, got ${actual.prescreen ?? 'missing'}`);
  }
  if (actual.selftest_good_patch !== expected.selftest_good_patch) {
    throw new Error(
      `eval_sha256 mismatch for selftest-good.patch: expected ${expected.selftest_good_patch ?? 'missing'}, got ${actual.selftest_good_patch ?? 'missing'}`
    );
  }
  if (actual.selftest_bad_patch !== expected.selftest_bad_patch) {
    throw new Error(
      `eval_sha256 mismatch for selftest-bad.patch: expected ${expected.selftest_bad_patch ?? 'missing'}, got ${actual.selftest_bad_patch ?? 'missing'}`
    );
  }
  for (const [file, hash] of Object.entries(expected.files ?? {})) {
    if (actual.files?.[file] !== hash) {
      throw new Error(`eval_sha256 mismatch for ${file}: expected ${hash}, got ${actual.files?.[file] ?? 'missing'}`);
    }
  }
}

async function readGoalForPlanner(paths: RunPaths): Promise<GoalFile> {
  return JSON.parse(await readFile(paths.goal, 'utf8')) as GoalFile;
}

async function discoverGuardFiles(paths: RunPaths): Promise<string[]> {
  const found: string[] = [];
  await walk(paths.target, found, paths.target);
  return found.sort();
}

async function walk(dir: string, found: string[], root: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.wici' || entry.name === '.opt' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, found, root);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isGuardFile(entry.name, relative(root, full))) continue;
    const info = await stat(full);
    if (info.size > 1024 * 1024) continue;
    found.push(relative(root, full));
  }
}

function isGuardFile(name: string, rel: string): boolean {
  const normalized = rel.replaceAll('\\', '/');
  return (
    /^test\.(mjs|cjs|js|ts|tsx)$/.test(name) ||
    /^spec\.(mjs|cjs|js|ts|tsx)$/.test(name) ||
    /\.(test|spec)\.(mjs|cjs|js|ts|tsx)$/.test(name) ||
    normalized.startsWith('test/') ||
    normalized.startsWith('tests/') ||
    normalized.startsWith('__tests__/')
  );
}
