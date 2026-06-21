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
  chat = [],
  contentWidth = 32,
  viewportHeight = 12,
  active = true,
  systemLine,
  localStatus,
  activityStatus,
  busy = false,
  showTitle = true
}: {
  interactive?: boolean;
  outbox?: OutboxMessage[];
  injections?: Injection[];
  goal?: GoalFile | null;
  supervisorState?: string;
  chat?: ChatLogEntry[];
  contentWidth?: number;
  viewportHeight?: number;
  systemLine?: string | null;
  localStatus?: string | null;
  activityStatus?: string | null;
  busy?: boolean;
  active?: boolean;
  showTitle?: boolean;
}) {
  const { isFocused } = useFocus({ id: 'chat-history', isActive: interactive && active });
  const isActive = active || isFocused;
  const history = buildChatHistory(outbox, injections, goal, chat);
  const goalSummary = currentGoalSummary(goal);
  const activeOutbox = outbox.filter((message) => isActiveOutboxMessage(message, supervisorState, goal));
  const sourceLines = [
    ...history,
    ...buildActiveOutboxLines(activeOutbox),
    ...(systemLine ? blockLines('system', systemLine, 'red', `system-${systemLine}`) : []),
    ...(localStatus ? blockLines('queued command', localStatus, 'yellow', `local-${localStatus}`) : []),
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
  onBusyChange,
  onLocalStatus
}: {
  target: string;
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
  onLocalStatus?: (text: string | null) => void;
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

    const runtimeCommand = parseRuntimeCommand(text, runtime);
    if (runtimeCommand) {
      onRuntimeChange?.(runtimeCommand.next);
      onLocalStatus?.(runtimeCommand.status);
      return;
    }

    const paths = runPaths(target);
    const latestQuestion = [...outbox].reverse().find((message) => message.kind === 'question' && message.reply_key && !message.answered);

    if (text === '/resume' || text.startsWith('/resume ')) {
      if (hasExistingRun) {
        onLocalStatus?.('resume: continuing the existing Thinkless run');
        onResumeRequested?.();
      } else {
        onLocalStatus?.(`resume: no existing run in this workspace; exit and run thinkless resume --target ${target}`);
      }
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
      onLocalStatus?.(`${injection.kind}: ${text}`);
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
            onLocalStatus?.('conversation only: planner not started');
            return;
          }
          const planningContext = buildBlankRunPlanningContext(chat, text, result);
          onLocalStatus?.(`planning: ${result.update.text}`);
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
        onLocalStatus?.(`planning: ${text}`);
        onPlanningRequested(text, planningContext);
      } else if (blankRun) {
        onLocalStatus?.('conversation only: planner not started');
      } else {
        await writeInjection(paths, { kind: 'add_requirement', text, priority: 'normal' });
        onLocalStatus?.(`add_requirement: ${text}`);
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
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      <ChatHistoryPane
        interactive={interactive}
        outbox={outbox}
        injections={injections}
        goal={goal}
        supervisorState={supervisorState}
        chat={chat}
        contentWidth={contentWidth}
        viewportHeight={viewportHeight}
        active
        systemLine={systemLine}
        localStatus={localStatus}
        activityStatus={activityStatus}
        busy={busy}
      />
      <ChatInputBox
        target={target}
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
        onLocalStatus={setLocalStatus}
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
    const text = entry.text.trim();
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

function isActiveOutboxMessage(message: OutboxMessage, supervisorState: string | undefined, goal: GoalFile | null): boolean {
  if (message.answered) return false;
  if (message.kind === 'question') return true;
  if (message.kind !== 'error') return false;
  if (!goal && message.text.includes(INITIAL_GOAL_REQUIRED_MESSAGE)) return false;
  return supervisorState !== 'STOP' && supervisorState !== 'FAILED';
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
