import React, { useRef, useState } from 'react';
import { Box, Text, useFocus, useInput } from 'ink';
import { runPaths } from '../shared/paths.js';
import { writeInjection } from '../supervisor/inbox.js';
import { runChatTurn } from '../supervisor/chatAgent.js';
import type { ChatLogEntry, GoalFile, Injection, OutboxMessage, RunEvent, ToolMode } from '../shared/types.js';
import { isMouseInput, mouseScrollDelta } from './input.js';
import { PAGE_SIZE, scrollBy, wrapLines, wrappedViewport } from './viewport.js';

type ChatColor = 'white' | 'gray' | 'cyan' | 'cyanBright' | 'green' | 'yellow' | 'red' | 'magenta';

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
  contentWidth = 32,
  viewportHeight = 12,
  acceptInitialGoal = false,
  onInitialGoal,
  onInjection,
  systemLine
}: {
  target: string;
  interactive?: boolean;
  outbox?: OutboxMessage[];
  injections?: Injection[];
  goal?: GoalFile | null;
  supervisorState?: string;
  goalDoc?: string;
  plan?: string;
  events?: RunEvent[];
  chat?: ChatLogEntry[];
  mode?: ToolMode;
  contentWidth?: number;
  viewportHeight?: number;
  acceptInitialGoal?: boolean;
  onInitialGoal?: (text: string) => void;
  onInjection?: () => void;
  systemLine?: string | null;
}) {
  const { isFocused } = useFocus({ id: 'chat', autoFocus: true, isActive: interactive });
  const [value, setValue] = useState('');
  const valueRef = useRef('');
  const [localLines, setLocalLines] = useState<ChatHistoryLine[]>([]);
  const [busy, setBusy] = useState(false);
  const history = buildChatHistory(outbox, injections, goal, chat);
  const goalSummary = currentGoalSummary(goal);
  const activeOutbox = outbox.filter((message) => isActiveOutboxMessage(message, supervisorState));
  const sourceLines = [
    ...history,
    ...buildActiveOutboxLines(activeOutbox),
    ...(systemLine ? blockLines('system', systemLine, 'red', `system-${systemLine}`) : []),
    ...localLines,
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

  const setInputValue = (next: string) => {
    valueRef.current = next;
    setValue(next);
  };

  const submit = async (raw: string) => {
    if (busy) return;
    const text = raw.trim();
    if (!text) return;
    setInputValue('');
    if (acceptInitialGoal && onInitialGoal && isInitialGoalText(text)) {
      onInitialGoal(text);
      return;
    }
    const paths = runPaths(target);
    const latestQuestion = [...outbox].reverse().find((message) => message.kind === 'question' && message.reply_key && !message.answered);

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
      setLocalLines((prev) => [
        ...prev.slice(-12),
        ...blockLines('queued command', `${injection.kind}: ${text}`, 'yellow', `local-${Date.now()}`)
      ]);
      onInjection?.();
      return;
    }

    // Ordinary conversation: the Chat agent replies and decides on its own
    // judgment whether this turn warrants a goal/plan update (hot reload).
    setBusy(true);
    try {
      const result = await runChatTurn({ paths, userText: text, goalDoc, plan, recentEvents: events, mode });
      if (result.update) onInjection?.();
    } catch {
      // Defensive fallback: never drop the user's message if the agent errors.
      await writeInjection(paths, { kind: 'add_requirement', text, priority: 'normal' });
      onInjection?.();
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    if (!interactive) return;
    const wheel = mouseScrollDelta(input);
    if (wheel !== 0) {
      setScrollOffset((current) => scrollBy(current, wheel, view.maxScroll));
      return;
    }
    if (isMouseInput(input)) return;
    if (key.upArrow || input === 'k') {
      setScrollOffset((current) => scrollBy(current, 1, view.maxScroll));
      return;
    }
    if (key.downArrow || input === 'j') {
      setScrollOffset((current) => scrollBy(current, -1, view.maxScroll));
      return;
    }
    if (key.pageUp || input === 'u') {
      setScrollOffset((current) => scrollBy(current, PAGE_SIZE, view.maxScroll));
      return;
    }
    if (key.pageDown || input === 'd') {
      setScrollOffset((current) => scrollBy(current, -PAGE_SIZE, view.maxScroll));
      return;
    }
    if (key.home || input === 'g') {
      setScrollOffset(view.maxScroll);
      return;
    }
    if (key.end || input === 'G') {
      setScrollOffset(0);
      return;
    }
    if (key.return || input === '\r' || input === '\n') {
      void submit(valueRef.current);
      return;
    }
    if (input.includes('\r') || input.includes('\n')) {
      const [before, ...rest] = input.split(/\r?\n/);
      const next = valueRef.current + before;
      const remainder = rest.join('\n');
      setInputValue(remainder);
      void submit(next);
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
  }, { isActive: interactive && isFocused });

  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      <Text bold color={isFocused ? 'cyan' : 'white'}>
        CHAT
      </Text>
      <Text color="cyan">{goalSummary}</Text>
      <Box flexDirection="column" flexGrow={1}>
        {view.lines.map((line, index) => (
          <Text key={`${view.start + index}-${line.id}`} color={line.color} bold={line.bold}>
            {line.text || ' '}
          </Text>
        ))}
      </Box>
      <Text color={scrollOffset > 0 ? 'yellow' : 'gray'}>
        {view.end}/{view.total || 0}
      </Text>
      <Box flexDirection="column" borderStyle="single" borderColor={isFocused ? 'cyan' : 'gray'} paddingX={1}>
        <Text color={isFocused ? 'cyan' : 'gray'} bold>
          YOU
        </Text>
        {wrapLines([value || ' '], Math.max(1, contentWidth - 2)).slice(-3).map((line, index) => (
          <Text key={`input-${index}-${line}`} color={isFocused && interactive ? 'white' : 'gray'}>
            {line || ' '}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

export function isInitialGoalText(text: string): boolean {
  return text.trim().length > 0 && !text.trim().startsWith('/');
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

function isActiveOutboxMessage(message: OutboxMessage, supervisorState: string | undefined): boolean {
  if (message.answered) return false;
  if (message.kind === 'question') return true;
  if (message.kind !== 'error') return false;
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
