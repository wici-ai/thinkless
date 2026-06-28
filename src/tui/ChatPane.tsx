import React, { useRef, useState } from 'react';
import { Box, Text, useFocus, useInput } from 'ink';
import { runPaths } from '../shared/paths.js';
import { writeInjection } from '../supervisor/inbox.js';
import { runChatTurn, shouldStartPlannerFromBlankChat, type ChatTurnResult } from '../supervisor/chatAgent.js';
import type { ChatLogEntry, GoalFile, Injection, OutboxMessage, RunEvent, RuntimeSelection, ToolMode } from '../shared/types.js';
import { INITIAL_GOAL_REQUIRED_MESSAGE } from '../shared/messages.js';
import { isMouseInput, mouseScrollDelta } from './input.js';
import { scrollBy, scrollDeltaForInput, wrapLines, wrappedViewport } from './viewport.js';
import { defaultRuntimeSelection, parseRuntimeCommand } from './runtimeSettings.js';
import { appendDictationText, parseDictationRequest, runDictationCommand } from './dictation.js';

type ChatColor = 'white' | 'gray' | 'cyan' | 'cyanBright' | 'green' | 'yellow' | 'red' | 'magenta';
const PLANNING_CONTEXT_MAX_ENTRIES = 14;
const PLANNING_CONTEXT_MAX_CHARS = 10_000;

interface ChatContextProps {
  outbox?: OutboxMessage[];
  injections?: Injection[];
  goal?: GoalFile | null;
  supervisorState?: string;
  goalDoc?: string;
  plan?: string;
  events?: RunEvent[];
  chat?: ChatLogEntry[];
  mode?: ToolMode;
  runtime?: RuntimeSelection;
  activityStatus?: string | null;
}

export function ChatHistoryPane({
  interactive = true,
  outbox = [],
  injections = [],
  goal = null,
  supervisorState,
  events = [],
  chat = [],
  contentWidth = 32,
  viewportHeight = 12,
  active = true,
  systemLine,
  activityStatus,
  busy = false,
  showTitle = true
}: {
  interactive?: boolean;
  outbox?: OutboxMessage[];
  injections?: Injection[];
  goal?: GoalFile | null;
  supervisorState?: string;
  events?: RunEvent[];
  chat?: ChatLogEntry[];
  contentWidth?: number;
  viewportHeight?: number;
  systemLine?: string | null;
  activityStatus?: string | null;
  busy?: boolean;
  active?: boolean;
  showTitle?: boolean;
}) {
  const { isFocused } = useFocus({ id: 'chat-history', isActive: interactive && active });
  const isActive = active || isFocused;
  const history = buildChatHistory(outbox, injections, goal, chat);
  const goalSummary = currentGoalSummary(goal);
  const activeOutbox = outbox.filter((message) => isActiveOutboxMessage(message, supervisorState, goal, events));
  const sourceLines = [
    ...history,
    ...buildActiveOutboxLines(activeOutbox),
    ...(systemLine ? blockLines('system', systemLine, 'red', `system-${systemLine}`) : []),
    ...(activityStatus ? blockLines('activity', activityStatus, 'cyan', `activity-${activityStatus}`) : []),
    ...(busy ? [{ id: 'busy', ts: timestampSortKey(), text: 'Assistant is thinking...', color: 'yellow' as ChatColor, bold: true }] : [])
  ];
  const [scrollOffset, setScrollOffset] = useState(0);
  const view = wrappedViewport(
    sourceLines,
    contentWidth,
    scrollOffset,
    viewportHeight,
    (line) => line.text,
    (line, text, wrapIndex) => ({ ...line, id: `${line.id}-wrap-${wrapIndex}`, text })
  );

  useInput((input, key) => {
    if (!interactive || !active) return;
    const wheel = mouseScrollDelta(input);
    if (wheel !== 0) {
      setScrollOffset((current) => scrollBy(current, wheel, view.maxScroll));
      return;
    }
    if (isMouseInput(input)) return;
    const keyboardScroll = scrollDeltaForInput(input, key);
    if (keyboardScroll === 'home') {
      setScrollOffset(view.maxScroll);
    } else if (keyboardScroll === 'end') {
      setScrollOffset(0);
    } else if (keyboardScroll !== null) {
      setScrollOffset((current) => scrollBy(current, keyboardScroll, view.maxScroll));
    }
  }, { isActive: interactive && active });

  return (
    <Box flexDirection="column" height="100%">
      {showTitle ? (
        <Text bold color={isActive ? 'cyan' : 'white'}>
          CHAT
        </Text>
      ) : null}
      <Text color="cyan">{goalSummary}</Text>
      <Box flexDirection="column" height={viewportHeight} overflow="hidden">
        {view.lines.map((line, index) => (
          <Text key={`${view.start + index}-${line.id}`} color={line.color} bold={line.bold}>
            {line.text || ' '}
          </Text>
        ))}
      </Box>
      <Text color={scrollOffset > 0 ? 'yellow' : 'gray'}>
        {view.end}/{view.total || 0}
      </Text>
    </Box>
  );
}

export function ChatInputBox({
  target,
  sessionDir,
  interactive = true,
  outbox = [],
  goalDoc = '',
  plan = '',
  events = [],
  chat = [],
  mode,
  runtime = defaultRuntimeSelection(),
  contentWidth = 80,
  inputPaused = false,
  blankRun = false,
  hasExistingRun = false,
  onPlanningRequested,
  onInjection,
  onResumeRequested,
  onRuntimeChange,
  onBusyChange
}: {
  target: string;
  sessionDir?: string;
  interactive?: boolean;
  outbox?: OutboxMessage[];
  goalDoc?: string;
  plan?: string;
  events?: RunEvent[];
  chat?: ChatLogEntry[];
  mode?: ToolMode;
  runtime?: RuntimeSelection;
  contentWidth?: number;
  inputPaused?: boolean;
  blankRun?: boolean;
  hasExistingRun?: boolean;
  onPlanningRequested?: (text: string, planningContext?: string) => void;
  onInjection?: () => void;
  onResumeRequested?: () => void;
  onRuntimeChange?: (runtime: RuntimeSelection) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { isFocused } = useFocus({ id: 'chat-input', autoFocus: true, isActive: interactive });
  const [value, setValue] = useState('');
  const valueRef = useRef('');
  const [busy, setBusyState] = useState(false);

  const setBusy = (next: boolean) => {
    setBusyState(next);
    onBusyChange?.(next);
  };

  const setInputValue = (next: string) => {
    valueRef.current = next;
    setValue(next);
  };

  const submit = async (raw: string) => {
    if (busy) return;
    const text = raw.trim();
    if (!text) return;
    setInputValue('');

    const dictationRequest = parseDictationRequest(text);
    if (dictationRequest) {
      if (!dictationRequest.command) {
        setInputValue(text);
        return;
      }
      setBusy(true);
      try {
        const result = await runDictationCommand(dictationRequest.command);
        const next = appendDictationText(valueRef.current, result.text);
        setInputValue(next);
        if (dictationRequest.submit && next.trim()) {
          setBusy(false);
          await submit(next);
        }
      } catch {
        // Keep failed dictation attempts local to the input flow; the chat pane no
        // longer has a transient status area for command progress.
        setInputValue(text);
      } finally {
        setBusy(false);
      }
      return;
    }

    const runtimeCommand = parseRuntimeCommand(text, runtime);
    if (runtimeCommand) {
      onRuntimeChange?.(runtimeCommand.next);
      return;
    }

    const paths = runPaths(target, sessionDir);
    const latestQuestion = hasExistingRun
      ? [...outbox].reverse().find((message) => message.kind === 'question' && message.reply_key && !message.answered)
      : undefined;

    if (text === '/resume' || text.startsWith('/resume ')) {
      onResumeRequested?.();
      return;
    }

    if (text === '/pause' || text.startsWith('/pause ')) {
      if (!hasExistingRun) {
        return;
      }
      await writeInjection(paths, { kind: 'abort', text: pauseControlReason(text), priority: 'urgent' });
      onInjection?.();
      return;
    }

    if (text === '/replan' || text.startsWith('/replan ')) {
      if (!hasExistingRun) {
        return;
      }
      await writeInjection(paths, { kind: 'steer', text: replanControlText(text), priority: 'normal' });
      onInjection?.();
      return;
    }

    if (isStopControlText(text)) {
      if (!hasExistingRun) {
        return;
      }
      const reason = stopControlReason(text);
      const injection = await writeInjection(paths, { kind: 'abort', text: reason, priority: 'urgent' });
      onInjection?.();
      return;
    }

    // Explicit control input: slash commands and answers to an open planner
    // question bypass the conversational agent and go straight to the inbox.
    const isSlash = text.startsWith('/abort ') || text.startsWith('/drop ') || text.startsWith('/answer ') || text.startsWith('/steer ');
    if (isSlash || latestQuestion) {
      const injection =
        text.startsWith('/abort ')
          ? await writeInjection(paths, { kind: 'abort', text: text.slice('/abort '.length), priority: 'urgent' })
          : text.startsWith('/drop ')
            ? await writeInjection(paths, { kind: 'drop_requirement', text: text.slice('/drop '.length), priority: 'normal' })
            : text.startsWith('/answer ')
              ? await writeAnswer(paths, text.slice('/answer '.length), latestQuestion?.reply_key)
            : text.startsWith('/steer ')
              ? await writeInjection(paths, { kind: 'steer', text: text.slice('/steer '.length), priority: 'normal' })
            : await writeAnswer(paths, text, latestQuestion!.reply_key);
      onInjection?.();
      return;
    }

    // Ordinary conversation: the Chat agent replies and decides on its own
    // judgment whether this turn warrants a goal/plan update (hot reload).
    setBusy(true);
    try {
      const result = await runChatTurn({ paths, userText: text, goalDoc, plan, recentEvents: events, mode, runtime, writeUpdate: !blankRun });
      if (result.update) {
        if (blankRun && onPlanningRequested) {
          // Trust real Chat-agent UPDATE decisions; only guard local degraded fallback.
          if (result.degraded && !shouldStartPlannerFromBlankChat(text, result.update)) {
            return;
          }
          const planningContext = buildBlankRunPlanningContext(chat, text, result);
          onPlanningRequested(result.update.text, planningContext);
        } else {
          onInjection?.();
        }
      }
    } catch {
      // Defensive fallback: never drop the user's message if the agent errors.
      const fallbackUpdate = { kind: 'add_requirement' as const, text };
      if (blankRun && onPlanningRequested && shouldStartPlannerFromBlankChat(text, fallbackUpdate)) {
        const planningContext = buildBlankRunPlanningContext(chat, text, { reply: '', update: fallbackUpdate, degraded: true });
        onPlanningRequested(text, planningContext);
      } else if (blankRun) {
        return;
      } else {
        await writeInjection(paths, { kind: 'add_requirement', text, priority: 'normal' });
        onInjection?.();
      }
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    if (!interactive || inputPaused) return;
    if (isMouseInput(input)) return;
    if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.home || key.end) return;
    if (input.includes('\r') || input.includes('\n')) {
      const [before, ...rest] = input.split(/\r?\n/);
      const next = valueRef.current + before;
      const remainder = rest.join('\n');
      setInputValue(remainder);
      void submit(next);
      return;
    }
    if (key.return || input === '\r' || input === '\n') {
      void submit(valueRef.current);
      return;
    }
    if (key.backspace || key.delete) {
      setInputValue(valueRef.current.slice(0, -1));
      return;
    }
    if (key.escape || key.tab || key.ctrl || key.meta) return;
    if (input) {
      setInputValue(valueRef.current + input);
    }
  }, { isActive: interactive && !inputPaused });

  return (
    <Box flexDirection="column" height={4} flexShrink={0} borderStyle="round" borderColor={isFocused || interactive ? 'cyan' : 'gray'} paddingX={1}>
      <Text color={isFocused || interactive ? 'cyan' : 'gray'} bold>
        YOU
      </Text>
      {wrapLines([value || ' '], Math.max(1, contentWidth - 2)).slice(-3).map((line, index) => (
        <Text key={`input-${index}-${line}`} color={interactive ? 'white' : 'gray'}>
          {line || ' '}
        </Text>
      ))}
    </Box>
  );
}

export function ChatPane({
  target,
  sessionDir,
  interactive = true,
  outbox = [],
  injections = [],
  goal = null,
  supervisorState,
  goalDoc = '',
  plan = '',
  events = [],
  chat = [],
  mode,
  runtime,
  activityStatus,
  contentWidth = 32,
  viewportHeight = 12,
  inputPaused = false,
  blankRun = false,
  onPlanningRequested,
  onInjection,
  onResumeRequested,
  systemLine
}: ChatContextProps & {
  target: string;
  sessionDir?: string;
  interactive?: boolean;
  contentWidth?: number;
  viewportHeight?: number;
  inputPaused?: boolean;
  blankRun?: boolean;
  onPlanningRequested?: (text: string, planningContext?: string) => void;
  onInjection?: () => void;
  onResumeRequested?: () => void;
  systemLine?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      <ChatHistoryPane
        interactive={interactive}
        outbox={outbox}
        injections={injections}
        goal={goal}
        supervisorState={supervisorState}
        events={events}
        chat={chat}
        contentWidth={contentWidth}
        viewportHeight={viewportHeight}
        active
        systemLine={systemLine}
        activityStatus={activityStatus}
        busy={busy}
      />
      <ChatInputBox
        target={target}
        sessionDir={sessionDir}
        interactive={interactive}
        outbox={outbox}
        goalDoc={goalDoc}
        plan={plan}
        events={events}
        chat={chat}
        mode={mode}
        runtime={runtime}
        contentWidth={contentWidth}
        inputPaused={inputPaused}
        blankRun={blankRun}
        hasExistingRun={Boolean(goal)}
        onPlanningRequested={onPlanningRequested}
        onInjection={onInjection}
        onResumeRequested={onResumeRequested}
        onBusyChange={setBusy}
      />
    </Box>
  );
}

export function buildBlankRunPlanningContext(chat: ChatLogEntry[], userText: string, result: ChatTurnResult): string {
  const entries = chat.slice(-PLANNING_CONTEXT_MAX_ENTRIES);
  const contextEntries = [...entries];
  if (!lastUserEntryMatches(contextEntries, userText)) {
    contextEntries.push({ ts: timestampSortKey(), role: 'user', text: userText });
  }
  if (result.reply.trim() || result.update) {
    contextEntries.push({
      ts: timestampSortKey(),
      role: 'assistant',
      text: result.reply.trim() || '(planner update emitted without a conversational reply)',
      ...(result.update ? { update: result.update } : {})
    });
  }
  const text = contextEntries
    .slice(-PLANNING_CONTEXT_MAX_ENTRIES)
    .map((entry) => {
      const label = entry.role.toUpperCase();
      const update = entry.update ? `\n${label} UPDATE (${entry.update.kind}): ${entry.update.text.trim()}` : '';
      return `${label}: ${entry.text.trim()}${update}`;
    })
    .filter((line) => line.trim().length > 0)
    .join('\n\n');
  return truncate(text, PLANNING_CONTEXT_MAX_CHARS);
}

function lastUserEntryMatches(entries: ChatLogEntry[], userText: string): boolean {
  const lastUser = [...entries].reverse().find((entry) => entry.role === 'user');
  return lastUser?.text.trim() === userText.trim();
}

async function writeAnswer(paths: ReturnType<typeof runPaths>, raw: string, fallbackReplyKey: string | undefined) {
  const [first, ...rest] = raw.trim().split(/\s+/);
  const replyTo =
    first === 'lock-eval' || first?.startsWith('planner-clarify-') || first?.startsWith('stop-') || first?.startsWith('q-') || first?.startsWith('out-')
      ? first
      : fallbackReplyKey;
  const answerText = replyTo === first ? rest.join(' ') : raw.trim();
  if (!replyTo) {
    return writeInjection(paths, {
      kind: 'steer',
      text: `Answer without open question: ${raw.trim()}`,
      priority: 'normal'
    });
  }
  return writeInjection(paths, {
    kind: 'answer',
    text: answerText,
    reply_to: replyTo,
    priority: 'normal'
  });
}

interface ChatHistoryLine {
  id: string;
  ts: string;
  text: string;
  color: ChatColor;
  bold?: boolean;
}

export function buildChatHistory(
  outbox: OutboxMessage[],
  injections: Injection[],
  goal: GoalFile | null = null,
  chat: ChatLogEntry[] = [],
  limit = Number.POSITIVE_INFINITY
): ChatHistoryLine[] {
  const injectionStatus = new Map<string, string>();
  for (const injection of injections) {
    injectionStatus.set(`${injection.kind}:${injection.text}`, injection.applied ? 'applied' : 'queued');
  }
  const chatLines = chat.flatMap((entry, index): ChatHistoryLine[] => {
    const text = formatChatHistoryText(entry).trim();
    if (!text) return [];
    const label = entry.role === 'user' ? 'you' : 'assistant';
    const color: ChatColor = entry.role === 'user' ? 'green' : 'cyanBright';
    const bodyColor: ChatColor = entry.role === 'user' ? 'white' : 'cyanBright';
    const blocks = blockLines(label, text, color, `chat-${index}-${entry.role}`, entry.ts, bodyColor);
    if (entry.update) {
      const status = injectionStatus.get(`${entry.update.kind}:${entry.update.text}`) ?? 'queued';
      blocks.push(...blockLines(`update ${status}`, entry.update.text, status === 'applied' ? 'green' : 'yellow', `chat-${index}-${entry.role}-update`, entry.ts));
    }
    blocks.push({
      id: `chat-${index}-${entry.role}-gap`,
      ts: entry.ts,
      text: '',
      color: 'gray'
    });
    return blocks;
  });
  const questionLines = outbox
    .filter((message) => message.answered && message.answer_text)
    .flatMap((message): ChatHistoryLine[] => [
      { id: `${message.id}-gap`, ts: message.ts, text: '', color: 'gray' },
      ...blockLines(message.kind === 'error' ? 'error' : 'question', message.text, message.kind === 'error' ? 'red' : 'magenta', `${message.id}-q`, message.ts),
      ...blockLines('answer', message.answer_text ?? '', 'green', `${message.id}-a`, message.answered_at ?? message.ts, 'white')
    ]);
  const sorted = [...questionLines, ...chatLines].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  return Number.isFinite(limit) ? sorted.slice(-limit) : sorted;
}

export function currentGoalSummary(goal: GoalFile | null): string {
  if (!goal) return 'Current goal: none';
  const active = goal.requirements.filter((requirement) => requirement.status === 'active');
  const first = active[0]?.text.trim() || 'no active requirement';
  const suffix = active.length > 1 ? ` (+${active.length - 1})` : '';
  return `Current goal v${goal.version}: ${truncate(first, 96)}${suffix}`;
}

function buildActiveOutboxLines(outbox: OutboxMessage[]): ChatHistoryLine[] {
  return outbox
    .slice(-5)
    .flatMap((message) => blockLines(message.kind, message.text, message.kind === 'error' ? 'red' : 'magenta', `active-${message.id}`, message.ts));
}

function isActiveOutboxMessage(message: OutboxMessage, supervisorState: string | undefined, goal: GoalFile | null, events: RunEvent[] = []): boolean {
  if (message.answered) return false;
  if (message.kind === 'question') return true;
  if (message.kind !== 'error') return false;
  if (!goal && message.text.includes(INITIAL_GOAL_REQUIRED_MESSAGE)) return false;
  if (supervisorState === 'STOP' || supervisorState === 'FAILED') return false;
  const newerProgress = [...events].reverse().find((event) => event.ts > message.ts && event.type !== 'FAILED');
  return !newerProgress;
}

function formatChatHistoryText(entry: ChatLogEntry): string {
  if (entry.role !== 'assistant') return entry.text;
  const receipt = parseExecutorReceipt(entry.text);
  if (!receipt) return entry.text;
  return [
    `Step done: ${receipt.stepDone ? 'yes' : 'no'}`,
    `Tests: ${receipt.testsPass ? 'pass' : 'fail'}`,
    receipt.notes ? `Notes: ${receipt.notes}` : '',
    receipt.changedFiles.length > 0 ? `Changed files: ${receipt.changedFiles.join(', ')}` : 'Changed files: none',
    receipt.next ? `Next: ${receipt.next}` : ''
  ].filter(Boolean).join('\n');
}

function parseExecutorReceipt(text: string): { stepDone: boolean; testsPass: boolean; notes: string; changedFiles: string[]; next: string | null } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.step_done !== 'boolean' || typeof parsed.tests_pass !== 'boolean' || typeof parsed.notes !== 'string') return null;
    return {
      stepDone: parsed.step_done,
      testsPass: parsed.tests_pass,
      notes: parsed.notes,
      changedFiles: Array.isArray(parsed.changed_files) ? parsed.changed_files.filter((item): item is string => typeof item === 'string') : [],
      next: typeof parsed.next === 'string' ? parsed.next : null
    };
  } catch {
    return null;
  }
}

function blockLines(
  label: string,
  text: string,
  headerColor: ChatColor,
  id: string,
  ts = timestampSortKey(),
  bodyColor: ChatColor = 'white'
): ChatHistoryLine[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return [
    { id: `${id}-00-gap`, ts, text: '', color: 'gray' },
    { id: `${id}-01-label`, ts, text: label.toUpperCase(), color: headerColor, bold: true },
    ...lines.map((line, index): ChatHistoryLine => ({
      id: `${id}-02-body-${index.toString().padStart(4, '0')}`,
      ts,
      text: `  ${line}`,
      color: bodyColor
    }))
  ];
}

function timestampSortKey(): string {
  return new Date().toISOString();
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

export function isStopControlText(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return false;
  if (/(不要|别|不用|不必|无需)\s*(停|停止|暂停|终止|取消|stop|abort|cancel|halt|pause)/i.test(normalized)) return false;
  if (/(stop|abort|cancel|halt|pause)\s+(policy|word|words|reason|verdict|question|prompt|test|tests)\b/i.test(normalized)) return false;
  if (/[?？]/.test(normalized) || /(为什么|为何|怎么|如何|是否|吗|么|how|why|what|whether)/i.test(normalized)) return false;
  return (
    /^\/?(stop|abort|cancel|halt|pause|quit)( now| please| this run| current run| the run| execution| planner| executor)?[.!。！]*$/i.test(normalized) ||
    /^(停|停止|暂停|终止|取消|别跑了|不要跑了|先停|先暂停|停一下|暂停一下|停掉|中止)(吧|一下|当前任务|当前执行|执行|这个任务|这次运行|planner|executor|执行器|规划器)?[.!。！]*$/i.test(normalized)
  );
}

function stopControlReason(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith('/') ? trimmed.slice(1).trim() || 'stop requested from Chat' : trimmed || 'stop requested from Chat';
}

function pauseControlReason(text: string): string {
  const raw = text.trim().slice('/pause'.length).trim();
  return raw
    ? `Pause requested from Chat: ${raw}`
    : 'Pause requested from Chat: stop the active executor at the next safe/preemptible point, preserve GOAL.md/PLAN.md/checkpoint state, and allow later /resume.';
}

function replanControlText(text: string): string {
  const raw = text.trim().slice('/replan'.length).trim();
  return [
    'Manual /replan requested from Chat.',
    raw ? `Operator reason: ${raw}` : 'Operator reason: review current progress and repair the plan before continuing.',
    'Run planner-diff before more ordinary executor turns.',
    'Perform a bottleneck review: re-read GOAL.md, PLAN.md, ASSUMPTIONS.md, recent ledger, events, lessons, and context.',
    'If the current executor loop is repeating the same blocker, same evidence, status-only receipt, or shallow external-plan wrapper, close or repair the ineffective step.',
    'Update PLAN.md with the current bottleneck, ruled-out paths, and exactly one next high-value executable technical step; update GOAL.md only if the active completion contract or stop boundary needs repair.',
    'Do not ask for human side probes when the next step can be derived from existing artifacts, remote state, or a bounded Codex discovery step.'
  ].join('\n');
}
