import React, { useRef, useState } from 'react';
import { Box, Text, useFocus, useInput } from 'ink';
import { runPaths } from '../shared/paths.js';
import { writeInjection } from '../supervisor/inbox.js';
import { runChatTurn } from '../supervisor/chatAgent.js';
import type { ChatLogEntry, GoalFile, Injection, OutboxMessage, RunEvent, ToolMode } from '../shared/types.js';

export function ChatPane({
  target,
  interactive = true,
  outbox = [],
  injections = [],
  goal = null,
  goalDoc = '',
  plan = '',
  events = [],
  chat = [],
  mode,
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
  goalDoc?: string;
  plan?: string;
  events?: RunEvent[];
  chat?: ChatLogEntry[];
  mode?: ToolMode;
  acceptInitialGoal?: boolean;
  onInitialGoal?: (text: string) => void;
  onInjection?: () => void;
  systemLine?: string | null;
}) {
  const { isFocused } = useFocus({ id: 'chat', autoFocus: true, isActive: interactive });
  const [value, setValue] = useState('');
  const valueRef = useRef('');
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const history = buildChatHistory(outbox, injections, goal, chat);

  const setInputValue = (next: string) => {
    valueRef.current = next;
    setValue(next);
  };

  const submit = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    setInputValue('');
    if (acceptInitialGoal && onInitialGoal && isInitialGoalText(text)) {
      onInitialGoal(text);
      setLines((prev) => [...prev.slice(-8), `goal: ${text}`]);
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
      setLines((prev) => [...prev.slice(-8), `${injection.kind}: ${text}`]);
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
  }, { isActive: interactive });

  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      <Text bold color={isFocused ? 'cyan' : 'white'}>
        CHAT
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        {history.map((line) => (
          <Text key={line.id} color={line.color}>
            {line.text}
          </Text>
        ))}
        {outbox.filter((message) => !message.answered).slice(-5).map((message) => (
          <Text key={message.id} color={message.kind === 'error' ? 'red' : message.kind === 'stop_verdict' ? 'yellow' : 'cyan'}>
            {message.kind}{message.answered ? ' answered' : ''}: {message.text.length > 52 ? `${message.text.slice(0, 49)}...` : message.text}
          </Text>
        ))}
        {systemLine ? <Text color="red">{systemLine.length > 52 ? `${systemLine.slice(0, 49)}...` : systemLine}</Text> : null}
        {lines.map((line, index) => (
          <Text key={`${index}-${line}`} color="gray">
            {line}
          </Text>
        ))}
        {busy ? <Text color="cyan">· chatting…</Text> : null}
      </Box>
      <Box>
        <Text color={isFocused ? 'cyan' : 'gray'}>{'>'} </Text>
        <Text color={isFocused && interactive ? 'white' : 'gray'}>{value || ' '}</Text>
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
  color: string;
}

export function buildChatHistory(
  outbox: OutboxMessage[],
  injections: Injection[],
  goal: GoalFile | null = null,
  chat: ChatLogEntry[] = [],
  limit = 12
): ChatHistoryLine[] {
  const initialGoalLines = (goal?.requirements ?? [])
    .filter((requirement) => requirement.source === 'initial')
    .map((requirement): ChatHistoryLine => ({
      id: `${goal?.run_id ?? 'goal'}-${requirement.id}`,
      ts: '0000-00-00T00:00:00.000Z',
      text: clip(`initial goal: ${requirement.text}`),
      color: 'gray'
    }));
  const chatLines = chat.flatMap((entry, index): ChatHistoryLine[] => {
    const text = entry.text.trim();
    if (!text) return [];
    return [
      {
        id: `chat-${index}-${entry.role}`,
        ts: entry.ts,
        text: clip(`${entry.role === 'user' ? 'you' : 'claude'}: ${text}`),
        color: entry.role === 'user' ? 'white' : 'cyanBright'
      }
    ];
  });
  const questionLines = outbox
    .filter((message) => message.answered && message.answer_text)
    .flatMap((message): ChatHistoryLine[] => [
      {
        id: `${message.id}-q`,
        ts: message.ts,
        text: clip(`planner: ${message.text}`),
        color: message.kind === 'error' ? 'red' : 'cyan'
      },
      {
        id: `${message.id}-a`,
        ts: message.answered_at ?? message.ts,
        text: clip(`answer: ${message.answer_text ?? ''}`),
        color: 'gray'
      }
    ]);
  const injectionLines = injections.map((injection): ChatHistoryLine => ({
    id: injection.id,
    ts: injection.ts,
    text: clip(`${labelForInjection(injection)}: ${injection.text}`),
    color: injection.priority === 'urgent' ? 'yellow' : 'gray'
  }));
  return [...initialGoalLines, ...questionLines, ...injectionLines, ...chatLines]
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id))
    .slice(-limit);
}

function labelForInjection(injection: Injection): string {
  if (injection.kind === 'add_requirement') return injection.applied ? 'requirement applied' : 'requirement pending';
  if (injection.kind === 'steer') return injection.applied ? 'steer applied' : 'steer pending';
  if (injection.kind === 'answer') return injection.applied ? 'answer applied' : 'answer pending';
  if (injection.kind === 'drop_requirement') return injection.applied ? 'drop applied' : 'drop pending';
  return injection.priority === 'urgent' ? 'abort requested' : 'abort';
}

function clip(text: string): string {
  return text.length > 72 ? `${text.slice(0, 69)}...` : text;
}
