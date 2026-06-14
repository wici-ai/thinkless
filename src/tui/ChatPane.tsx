import React, { useState } from 'react';
import { Box, Text, useFocus } from 'ink';
import TextInput from 'ink-text-input';
import { runPaths } from '../shared/paths.js';
import { writeInjection } from '../supervisor/inbox.js';
import type { OutboxMessage } from '../shared/types.js';

export function ChatPane({ target, interactive = true, outbox = [] }: { target: string; interactive?: boolean; outbox?: OutboxMessage[] }) {
  const { isFocused } = useFocus({ autoFocus: true, isActive: interactive });
  const [value, setValue] = useState('');
  const [lines, setLines] = useState<string[]>([]);

  const submit = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    setValue('');
    const paths = runPaths(target);
    const latestQuestion = [...outbox].reverse().find((message) => message.kind === 'question' && message.reply_key && !message.answered);
    const injection =
      text.startsWith('/abort ')
        ? await writeInjection(paths, { kind: 'abort', text: text.slice('/abort '.length), priority: 'urgent' })
        : text.startsWith('/drop ')
          ? await writeInjection(paths, { kind: 'drop_requirement', text: text.slice('/drop '.length), priority: 'normal' })
          : text.startsWith('/answer ')
            ? await writeAnswer(paths, text.slice('/answer '.length), latestQuestion?.reply_key)
          : text.startsWith('/steer ')
            ? await writeInjection(paths, { kind: 'steer', text: text.slice('/steer '.length), priority: 'normal' })
            : await writeInjection(paths, { kind: 'add_requirement', text, priority: 'normal' });
    setLines((prev) => [...prev.slice(-8), `${injection.kind}: ${text}`]);
  };

  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      <Text bold color={isFocused ? 'cyan' : 'white'}>
        CHAT
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        {outbox.slice(-5).map((message) => (
          <Text key={message.id} color={message.kind === 'error' ? 'red' : message.kind === 'stop_verdict' ? 'yellow' : 'cyan'}>
            {message.kind}{message.answered ? ' answered' : ''}: {message.text.length > 52 ? `${message.text.slice(0, 49)}...` : message.text}
          </Text>
        ))}
        {lines.map((line, index) => (
          <Text key={`${index}-${line}`} color="gray">
            {line}
          </Text>
        ))}
      </Box>
      <Box>
        <Text color={isFocused ? 'cyan' : 'gray'}>{'>'} </Text>
        {isFocused && interactive ? <TextInput value={value} onChange={setValue} onSubmit={submit} /> : <Text color="gray">{value || ' '}</Text>}
      </Box>
    </Box>
  );
}

async function writeAnswer(paths: ReturnType<typeof runPaths>, raw: string, fallbackReplyKey: string | undefined) {
  const [first, ...rest] = raw.trim().split(/\s+/);
  const replyTo = first === 'lock-eval' || first?.startsWith('stop-') || first?.startsWith('q-') || first?.startsWith('out-') ? first : fallbackReplyKey;
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
