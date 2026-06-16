import { readFile } from 'node:fs/promises';
import { execa } from 'execa';
import { appendJsonLine, atomicWriteJson, readJsonFileMaybe } from '../shared/atomic.js';
import { loadConfig } from '../shared/config.js';
import { promptPath, type RunPaths } from '../shared/paths.js';
import type { ChatLogEntry, RunEvent, ToolMode } from '../shared/types.js';
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
  if (result.update) {
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
    const config = await loadConfig(ctx.mode);
    if (config.tools.mode === 'stub') return buildFallbackChatTurn(ctx, 'Claude Chat is unavailable in stub mode.');
    const command = config.tools.planner.command;
    if (!(await commandExists(command))) return buildFallbackChatTurn(ctx, `Claude Chat command not found: ${command}.`);

    const systemPrompt = await readFile(promptPath('chat'), 'utf8');
    const safetyText = formatSafetyForPrompt(config);
    const userPrompt = buildChatPrompt(ctx);
    const sessionId = await readChatSession(ctx.paths);

    let result = await runClaudeStreamProcess(command, buildChatArgs({ userPrompt, systemPrompt, safetyText, sessionId }), {
      cwd: ctx.paths.target,
      idleTimeoutMs: CHAT_IDLE_TIMEOUT_MS,
      hardTimeoutMs: CHAT_HARD_TIMEOUT_MS
    });
    // A stale/rejected resume session is common; retry once as a fresh session.
    if (sessionId && (result.exitCode !== 0 || result.timeoutReason)) {
      result = await runClaudeStreamProcess(command, buildChatArgs({ userPrompt, systemPrompt, safetyText }), {
        cwd: ctx.paths.target,
        idleTimeoutMs: CHAT_IDLE_TIMEOUT_MS,
        hardTimeoutMs: CHAT_HARD_TIMEOUT_MS
      });
    }
    if (result.timeoutReason || result.exitCode !== 0) return buildFallbackChatTurn(ctx, result.timeoutReason ? `Claude Chat timed out: ${result.timeoutReason}.` : `Claude Chat exited with code ${result.exitCode}.`);

    const parsed = parseChatResponse(result.stdout);
    if (!parsed || !parsed.reply.trim()) return buildFallbackChatTurn(ctx, 'Claude Chat returned no usable reply.');
    if (parsed.sessionId) await writeChatSession(ctx.paths, parsed.sessionId);
    // Respect the agent's judgment: a reply with no UPDATE is pure conversation.
    return { reply: parsed.reply, update: parsed.update, degraded: false };
  } catch (error) {
    return buildFallbackChatTurn(ctx, error instanceof Error ? error.message : String(error));
  }
}

export function buildFallbackChatTurn(ctx: ChatTurnContext, reason = 'Claude Chat unavailable.'): ChatTurnResult {
  if (isLikelyQuestion(ctx.userText)) {
    return {
      reply: buildFallbackStatusReply(ctx, reason),
      degraded: true
    };
  }
  return {
    reply: `Chat agent is currently unavailable (${reason}). I queued your message as a new requirement so the supervisor can process it when it resumes.`,
    update: { kind: 'add_requirement', text: ctx.userText },
    degraded: true
  };
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

function isLikelyQuestion(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (/[?？]$/.test(normalized)) return true;
  return /(进展|状态|怎么样|咋回事|怎么回事|为什么|为何|吗|么|是否|是不是|有没有|哪里|多少|何时|什么时候|how|what|why|status|progress|running|stuck|error)/i.test(normalized);
}

export function buildChatArgs(input: { userPrompt: string; systemPrompt: string; safetyText?: string; sessionId?: string }): string[] {
  return [
    '-p',
    input.userPrompt,
    ...(input.sessionId ? ['--resume', input.sessionId] : []),
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'plan',
    '--dangerously-skip-permissions',
    '--append-system-prompt',
    appendSafety(input.systemPrompt, input.safetyText ?? '')
  ];
}

function buildChatPrompt(ctx: ChatTurnContext): string {
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
    const reply = extractSection(item.result, 'REPLY') ?? item.result.trim();
    const update = parseUpdate(extractSection(item.result, 'UPDATE'));
    return { reply, update, sessionId: item.session_id };
  }
  return null;
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

async function commandExists(command: string): Promise<boolean> {
  const result = await execa('command', ['-v', command], { shell: true, reject: false });
  return result.exitCode === 0;
}

async function readChatSession(paths: RunPaths): Promise<string | undefined> {
  const data = await readJsonFileMaybe<{ session_id?: string }>(paths.chatSession);
  return data?.session_id;
}

async function writeChatSession(paths: RunPaths, sessionId: string): Promise<void> {
  await atomicWriteJson(paths.chatSession, { session_id: sessionId, updated_at: timestamp() });
}

async function appendChat(paths: RunPaths, entry: ChatLogEntry): Promise<void> {
  await appendJsonLine(paths.chat, entry);
}

function timestamp(): string {
  return new Date().toISOString();
}
