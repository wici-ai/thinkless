import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendJsonLine, atomicWriteJson, ensureDir, readJsonFileMaybe } from '../shared/atomic.js';
import { commandExists } from '../shared/commands.js';
import { applyRuntimeSelection, loadConfig } from '../shared/config.js';
import { promptPath, type RunPaths } from '../shared/paths.js';
import type { ChatLogEntry, RunEvent, RuntimeSelection, ToolMode } from '../shared/types.js';
import { runtimeAgentFromCommand } from '../shared/runtime.js';
import { INITIAL_GOAL_REQUIRED_MESSAGE } from '../shared/messages.js';
import { appendSafety, formatSafetyForPrompt } from './safety.js';
import { isClaudeEnvelope, parseClaudeJsonOutput } from './claudeOutput.js';
import { runClaudeStreamProcess } from './claudeProcess.js';
import { writeInjection } from './inbox.js';

const CHAT_IDLE_TIMEOUT_MS = 2 * 60_000;
const CHAT_HARD_TIMEOUT_MS = 5 * 60_000;
const RECENT_EVENT_LINES = 12;
const CHAT_PLAN_MAX_CHARS = 6_000;
const CHAT_GOAL_MAX_CHARS = 4_000;
const CHAT_EVENT_MESSAGE_MAX_CHARS = 240;

export interface ChatUpdate {
  kind: 'add_requirement' | 'steer';
  text: string;
}

export interface ChatTurnContext {
  paths: RunPaths;
  userText: string;
  goalDoc: string;
  plan: string;
  recentEvents: RunEvent[];
  mode?: ToolMode;
  runtime?: RuntimeSelection;
  writeUpdate?: boolean;
}

export interface ChatTurnResult {
  reply: string;
  update?: ChatUpdate;
  /** true when the conversational agent was unavailable and we fell back to a plain requirement injection. */
  degraded: boolean;
}

/**
 * Run one Chat turn. The Chat agent is a conversational Claude session that
 * answers freely and, only when it judges the conversation has established a
 * concrete change, returns an UPDATE which we route through the normal inbox
 * hot-reload (add_requirement/steer → applyInjections → runPlanDiff). When no
 * real `claude` is available (stub mode / missing CLI / failure), we degrade to
 * a local blackboard answer for questions, and only queue non-question messages
 * as requirements. This function never throws.
 */
export async function runChatTurn(ctx: ChatTurnContext): Promise<ChatTurnResult> {
  await appendChat(ctx.paths, { ts: timestamp(), role: 'user', text: ctx.userText });
  const result = await conversationTurn(ctx);
  if (result.update && ctx.writeUpdate !== false) {
    await writeInjection(ctx.paths, { kind: result.update.kind, text: result.update.text, priority: 'normal' });
  }
  await appendChat(ctx.paths, {
    ts: timestamp(),
    role: 'assistant',
    text: result.reply,
    ...(result.update ? { update: result.update } : {})
  });
  return result;
}

async function conversationTurn(ctx: ChatTurnContext): Promise<ChatTurnResult> {
  try {
    const config = applyRuntimeSelection(await loadConfig(ctx.mode), ctx.runtime);
    if (config.tools.mode === 'stub') return buildFallbackChatTurn(ctx, 'Chat agent is unavailable in stub mode.');
    const chatTool = config.tools.chat ?? { command: config.tools.planner.command, model: undefined, effort: 'default' };
    const command = chatTool.command ?? config.tools.planner.command;
    const agent = runtimeAgentFromCommand(command, 'claude');
    const label = agent === 'codex' ? 'Codex Chat' : 'Claude Chat';
    if (!(await commandExists(command))) return buildFallbackChatTurn(ctx, `${label} command not found: ${command}.`);

    const systemPrompt = await readFile(promptPath('chat'), 'utf8');
    const safetyText = formatSafetyForPrompt(config);
    const userPrompt = buildChatPrompt(ctx);
    const sessionId = await readChatSession(ctx.paths, agent);
    if (agent === 'codex') return await runCodexChatTurn(ctx, command, { model: chatTool.model, effort: chatTool.effort, systemPrompt, safetyText, userPrompt, sessionId });

    let result = await runClaudeStreamProcess(command, buildChatArgs({ userPrompt, systemPrompt, safetyText, sessionId, model: chatTool.model, effort: chatTool.effort }), {
      cwd: ctx.paths.target,
      idleTimeoutMs: CHAT_IDLE_TIMEOUT_MS,
      hardTimeoutMs: CHAT_HARD_TIMEOUT_MS
    });
    // A stale/rejected resume session is common; retry once as a fresh session.
    if (sessionId && (result.exitCode !== 0 || result.timeoutReason)) {
      result = await runClaudeStreamProcess(command, buildChatArgs({ userPrompt, systemPrompt, safetyText, model: chatTool.model, effort: chatTool.effort }), {
        cwd: ctx.paths.target,
        idleTimeoutMs: CHAT_IDLE_TIMEOUT_MS,
        hardTimeoutMs: CHAT_HARD_TIMEOUT_MS
      });
    }
    if (result.timeoutReason || result.exitCode !== 0) return buildFallbackChatTurn(ctx, result.timeoutReason ? `${label} timed out: ${result.timeoutReason}.` : `${label} exited with code ${result.exitCode}.`);

    const parsed = parseChatResponse(result.stdout);
    if (!parsed || !parsed.reply.trim()) return buildFallbackChatTurn(ctx, `${label} returned no usable reply.`);
    if (parsed.sessionId) await writeChatSession(ctx.paths, agent, parsed.sessionId);
    // Respect the agent's judgment: a reply with no UPDATE is pure conversation.
    return { reply: parsed.reply, update: parsed.update, degraded: false };
  } catch (error) {
    return buildFallbackChatTurn(ctx, error instanceof Error ? error.message : String(error));
  }
}

async function runCodexChatTurn(
  ctx: ChatTurnContext,
  command: string,
  input: {
    model?: string;
    effort?: string;
    systemPrompt: string;
    safetyText?: string;
    userPrompt: string;
    sessionId?: string;
  }
): Promise<ChatTurnResult> {
  await ensureDir(ctx.paths.artifacts);
  const outputLastMessage = join(ctx.paths.artifacts, `chat-codex-${Date.now()}.txt`);
  let result = await runCodexChatProcess(ctx, command, input, outputLastMessage, input.sessionId);
  if (input.sessionId && (result.timeoutReason || result.exitCode !== 0)) {
    result = await runCodexChatProcess(ctx, command, input, outputLastMessage, undefined);
  }
  if (result.timeoutReason || result.exitCode !== 0) {
    return buildFallbackChatTurn(ctx, result.timeoutReason ? `Codex Chat timed out: ${result.timeoutReason}.` : `Codex Chat exited with code ${result.exitCode}.`);
  }

  const finalMessage = await readTextMaybe(outputLastMessage);
  const parsed = parseChatFinalMessage(finalMessage) ?? parseCodexChatResponse(result.stdout);
  if (!parsed || !parsed.reply.trim()) return buildFallbackChatTurn(ctx, 'Codex Chat returned no usable reply.');
  const sessionId = parsed.sessionId ?? extractCodexSessionId(result.stdout) ?? input.sessionId;
  if (sessionId) await writeChatSession(ctx.paths, 'codex', sessionId);
  return { reply: parsed.reply, update: parsed.update, degraded: false };
}

function runCodexChatProcess(
  ctx: ChatTurnContext,
  command: string,
  input: {
    model?: string;
    effort?: string;
    systemPrompt: string;
    safetyText?: string;
    userPrompt: string;
  },
  outputLastMessage: string,
  sessionId: string | undefined
): ReturnType<typeof runClaudeStreamProcess> {
  return runClaudeStreamProcess(
    command,
    buildCodexChatArgs({
      target: ctx.paths.target,
      prompt: buildCodexChatPrompt(input),
      outputLastMessage,
      model: input.model,
      effort: input.effort,
      resumeSessionId: sessionId
    }),
    {
      cwd: ctx.paths.target,
      idleTimeoutMs: CHAT_IDLE_TIMEOUT_MS,
      hardTimeoutMs: CHAT_HARD_TIMEOUT_MS
    }
  );
}

export function buildFallbackChatTurn(ctx: ChatTurnContext, reason = 'Chat agent unavailable.'): ChatTurnResult {
  if (isLikelyQuestion(ctx.userText)) {
    return {
      reply: buildFallbackStatusReply(ctx, reason),
      degraded: true
    };
  }
  if (isBlankRunContext(ctx) && isLikelyContextGatheringOnly(ctx.userText)) {
    return {
      reply: `Chat agent is currently unavailable (${reason}). I did not start the planner because this looks like a request to inspect or discuss the codebase first, not a concrete execution goal yet.`,
      degraded: true
    };
  }
  if (isBlankRunContext(ctx) && !isLikelyPlanningRequest(ctx.userText)) {
    return {
      reply: `Chat agent is currently unavailable (${reason}). I kept this as conversation and did not start the planner. Ask for a plan or give a concrete build/fix/execute request when ready.`,
      degraded: true
    };
  }
  return {
    reply: `Chat agent is currently unavailable (${reason}). I queued your message as a new requirement so the supervisor can process it when it resumes.`,
    update: { kind: 'add_requirement', text: ctx.userText },
    degraded: true
  };
}

export function shouldStartPlannerFromBlankChat(userText: string, update: ChatUpdate | undefined): boolean {
  if (!update) return false;
  if (isLikelyContextGatheringOnly(userText)) return false;
  if (isLikelyQuestion(userText) && !hasConcreteActionIntent(userText) && !hasConcreteActionIntent(update.text)) return false;
  return hasConcreteActionIntent(userText) || hasConcreteActionIntent(update.text);
}

function hasConcreteActionIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return /(plan|goal|requirement|execute|start|run|implement|build|create|add|remove|delete|change|update|fix|repair|optimi[sz]e|test|verify|deploy|ship|commit|push|规划|计划|制定|执行|开始|启动|运行|实现|开发|构建|创建|新增|添加|删除|移除|修改|更新|修复|优化|测试|验证|部署|发布|提交|推送|完成|做到|要求|目标)/i.test(normalized);
}

function buildFallbackStatusReply(ctx: ChatTurnContext, reason: string): string {
  const planStep = currentPlanStep(ctx.plan);
  const lastEvent = ctx.recentEvents.at(-1);
  const recent = ctx.recentEvents
    .slice(-5)
    .map((event) => `- ${event.ts.slice(11, 19)} ${event.type}: ${truncateForChat(event.message, 180)}`)
    .join('\n') || '- no recent events';
  return [
    `Chat agent is degraded right now (${reason}), so this is a local blackboard summary.`,
    '',
    planStep ? `Current plan step: ${planStep}` : 'Current plan step: not found in PLAN.md.',
    lastEvent ? `Latest event: ${lastEvent.type} — ${truncateForChat(lastEvent.message, 220)}` : 'Latest event: none recorded.',
    '',
    'Recent events:',
    recent
  ].join('\n');
}

function currentPlanStep(plan: string): string | undefined {
  const active = plan.split('\n').find((line) => /^\s*-\s+\[>\]\s+S\d+/i.test(line));
  if (active) return active.trim();
  const pending = plan.split('\n').find((line) => /^\s*-\s+\[\s\]\s+S\d+/i.test(line));
  return pending?.trim();
}

function isBlankRunContext(ctx: ChatTurnContext): boolean {
  return !ctx.goalDoc.trim() && !ctx.plan.trim() && ctx.recentEvents.every((event) => isInitialGoalRequiredText(event.message));
}

function isInitialGoalRequiredText(text: string | undefined): boolean {
  return Boolean(text?.includes(INITIAL_GOAL_REQUIRED_MESSAGE));
}

function isLikelyQuestion(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (/[?？]$/.test(normalized)) return true;
  return /(进展|状态|怎么样|咋回事|怎么回事|为什么|为何|吗|么|是否|是不是|有没有|哪里|多少|何时|什么时候|how|what|why|status|progress|running|stuck|error)/i.test(normalized);
}

function isLikelyContextGatheringOnly(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  const wantsInspection = /(阅读|读一下|看一下|看看|了解|熟悉|分析一下|先看|inspect|read|explore|understand|look over|take a look)/i.test(normalized);
  if (!wantsInspection) return false;
  const asksForPlanOrExecution = /(plan|规划|计划|制定计划|执行|开始|start|run|implement|build|fix|optimi[sz]e|修复|实现|开发|优化)/i.test(normalized);
  return !asksForPlanOrExecution || /(暂时|先别|别开始|不要开始|不要计划|不要执行|先不要|先不用|before planning|before starting)/i.test(normalized);
}

function isLikelyPlanningRequest(text: string): boolean {
  return hasConcreteActionIntent(text);
}

export function buildChatArgs(input: {
  userPrompt: string;
  systemPrompt: string;
  safetyText?: string;
  sessionId?: string;
  model?: string;
  effort?: string;
}): string[] {
  return [
    '-p',
    input.userPrompt,
    ...(input.sessionId ? ['--resume', input.sessionId] : []),
    '--output-format',
    'stream-json',
    '--verbose',
    ...claudeModelArgs(input.model),
    ...claudeEffortArgs(input.effort),
    '--dangerously-skip-permissions',
    '--append-system-prompt',
    appendSafety(input.systemPrompt, input.safetyText ?? '')
  ];
}

export function buildCodexChatArgs(input: {
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
      '--sandbox',
      'danger-full-access',
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

function buildCodexChatPrompt(input: { systemPrompt: string; safetyText?: string; userPrompt: string }): string {
  return [
    appendSafety(input.systemPrompt, input.safetyText ?? ''),
    '',
    'You are running as the Chat agent through Codex exec with Chat-level permissions. Handle lightweight direct work: short inspection, bounded read-only SSH or remote code review, and small self-contained local edits are allowed. UPDATE is a planner/executor handoff, not a status note. Do not emit UPDATE just because a lightweight direct task is blocked by auth, network, sandbox, missing tools, or environment limits; explain the blocker in REPLY. Do not commit, push, deploy, run destructive commands, or start long benchmark/debug loops yourself; emit UPDATE only when planner/executor should take over.',
    '',
    input.userPrompt
  ].join('\n');
}

function claudeModelArgs(model: string | undefined): string[] {
  const normalized = model?.trim();
  if (!normalized || normalized === 'default') return [];
  return ['--model', normalized];
}

function claudeEffortArgs(effort: string | undefined): string[] {
  const normalized = effort?.trim();
  if (!normalized || normalized === 'default') return [];
  return ['--effort', normalized];
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

export function buildChatPrompt(ctx: ChatTurnContext): string {
  const events =
    ctx.recentEvents
      .slice(-RECENT_EVENT_LINES)
      .map((event) => `${event.ts.slice(11, 19)} ${event.type} ${truncateForChat(event.message, CHAT_EVENT_MESSAGE_MAX_CHARS)}`)
      .join('\n') || '(no run events yet)';
  return [
    `User message:\n${ctx.userText}`,
    `\nCurrent GOAL.md:\n${truncateForChat(ctx.goalDoc.trim(), CHAT_GOAL_MAX_CHARS) || '(none yet)'}`,
    `\nCurrent PLAN.md summary:\n${summarizePlanForChat(ctx.plan)}`,
    `\nRecent run events:\n${events}`
  ].join('\n');
}

export function summarizePlanForChat(plan: string, maxChars = CHAT_PLAN_MAX_CHARS): string {
  const trimmed = plan.trim();
  if (!trimmed) return '(none yet)';
  if (trimmed.length <= maxChars) return trimmed;

  const lines = trimmed.split('\n');
  const summary: string[] = [];
  let inStep = false;
  let stepDetailLines = 0;

  for (const line of lines) {
    if (/^#/.test(line)) {
      summary.push(line);
      inStep = false;
      stepDetailLines = 0;
      continue;
    }
    if (/^\s*- \[[ x>!]\]\s+S\d+/i.test(line)) {
      summary.push(line);
      inStep = true;
      stepDetailLines = 0;
      continue;
    }
    if (inStep && /^\s+(Action|Validation|Rollback|Setup\/prereqs):/i.test(line) && stepDetailLines < 2) {
      summary.push(line);
      stepDetailLines += 1;
      continue;
    }
    if (!inStep && summary.length < 24 && line.trim()) {
      summary.push(truncateForChat(line, 320));
    }
  }

  const compact = summary.join('\n').trim();
  return truncateForChat(compact || trimmed, maxChars);
}

function truncateForChat(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 80)).trimEnd()}\n[truncated ${text.length - maxChars} chars; inspect files directly for exact contents]`;
}

interface ParsedChat {
  reply: string;
  update?: ChatUpdate;
  sessionId?: string;
}

export function parseChatResponse(raw: string): ParsedChat | null {
  let parsed: unknown[];
  try {
    parsed = parseClaudeJsonOutput(raw);
  } catch {
    return null;
  }
  for (const item of [...parsed].reverse()) {
    if (!isClaudeEnvelope(item) || typeof item.result !== 'string') continue;
    const chat = parseChatFinalMessage(item.result, item.session_id);
    if (chat) return chat;
  }
  return null;
}

function parseCodexChatResponse(raw: string): ParsedChat | null {
  const lines = raw.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of [...lines].reverse()) {
    const record = parseJsonRecord(line);
    if (!record) continue;
    const item = recordValue(recordValue(record.params)?.item) ?? recordValue(record.item) ?? record;
    const kind = stringValue(item.type) ?? stringValue(record.type) ?? stringValue(record.method);
    if (kind !== 'agentMessage' && kind !== 'agent_message' && kind !== 'message') continue;
    const text = stringValue(item.text) ?? stringValue(item.message);
    const parsed = text ? parseChatFinalMessage(text) : null;
    if (parsed) return parsed;
  }
  return null;
}

export function extractCodexSessionId(raw: string): string | undefined {
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

    const thread = recordValue(record.thread);
    const fromThread = stringValue(thread?.id) ?? stringValue(thread?.sessionId) ?? stringValue(thread?.session_id);
    if (fromThread) return fromThread;
  }
  return undefined;
}

function parseChatFinalMessage(text: string, sessionId?: string): ParsedChat | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const reply = extractSection(trimmed, 'REPLY') ?? trimmed;
  const update = parseUpdate(extractSection(trimmed, 'UPDATE'));
  return { reply: reply.trim(), update, sessionId };
}

function parseUpdate(raw: string | undefined): ChatUpdate | undefined {
  if (!raw) return undefined;
  let kind: ChatUpdate['kind'] = 'add_requirement';
  const body: string[] = [];
  for (const line of raw.split('\n')) {
    const match = /^\s*kind\s*:\s*(requirement|add_requirement|steer)\s*$/i.exec(line);
    if (match) {
      kind = /steer/i.test(match[1]) ? 'steer' : 'add_requirement';
      continue;
    }
    body.push(line);
  }
  const text = body.join('\n').trim();
  return text ? { kind, text } : undefined;
}

function extractSection(text: string, label: 'REPLY' | 'UPDATE'): string | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => new RegExp(`^#{1,6}\\s+${label}\\s*$`, 'i').test(line.trim()));
  if (start < 0) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,6}\s+(REPLY|UPDATE)\b/i.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  const body = stripOuterFence(lines.slice(start + 1, end)).join('\n').trim();
  return body || undefined;
}

function stripOuterFence(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim() === '') start += 1;
  while (end > start && (lines[end - 1] ?? '').trim() === '') end -= 1;
  if (end - start < 2) return lines.slice(start, end);
  if (!/^\s*```[A-Za-z0-9_-]*\s*$/.test(lines[start] ?? '')) return lines.slice(start, end);
  if (!/^\s*```\s*$/.test(lines[end - 1] ?? '')) return lines.slice(start, end);
  return lines.slice(start + 1, end - 1);
}

async function readTextMaybe(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return recordValue(parsed);
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

type ChatSessionAgent = 'claude' | 'codex';

interface ChatSessionFile {
  session_id?: string;
  updated_at?: string;
  sessions?: Partial<Record<ChatSessionAgent, { session_id?: string; updated_at?: string }>>;
}

async function readChatSession(paths: RunPaths, agent: ChatSessionAgent): Promise<string | undefined> {
  const data = await readJsonFileMaybe<ChatSessionFile>(paths.chatSession);
  return data?.sessions?.[agent]?.session_id ?? (agent === 'claude' ? data?.session_id : undefined);
}

async function writeChatSession(paths: RunPaths, agent: ChatSessionAgent, sessionId: string): Promise<void> {
  const current = (await readJsonFileMaybe<ChatSessionFile>(paths.chatSession)) ?? {};
  const updatedAt = timestamp();
  await atomicWriteJson(paths.chatSession, {
    ...current,
    ...(agent === 'claude' ? { session_id: sessionId } : {}),
    updated_at: updatedAt,
    sessions: {
      ...(current.sessions ?? {}),
      [agent]: { session_id: sessionId, updated_at: updatedAt }
    }
  });
}

async function appendChat(paths: RunPaths, entry: ChatLogEntry): Promise<void> {
  await appendJsonLine(paths.chat, entry);
}

function timestamp(): string {
  return new Date().toISOString();
}
