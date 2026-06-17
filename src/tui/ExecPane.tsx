import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useFocus, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { RunEvent } from '../shared/types.js';
import type { RunState } from './useRunState.js';
import { isMouseInput, mouseScrollDelta } from './input.js';
import { PAGE_SIZE, scrollBy, wrappedViewport } from './viewport.js';

const VISIBLE_EVENTS = 18;
const MAX_FIELD_CHARS = 1_200;
const MAX_OUTPUT_LINES_PER_EVENT = 12;

export const ExecPane = React.memo(function ExecPane({
  state,
  contentWidth = 48,
  viewportHeight = VISIBLE_EVENTS,
  showTitle = true,
  active
}: {
  state: RunState;
  contentWidth?: number;
  viewportHeight?: number;
  showTitle?: boolean;
  active?: boolean;
}) {
  const { isFocused } = useFocus({ id: 'exec' });
  const isActive = active ?? isFocused;
  const [scrollOffset, setScrollOffset] = useState(0);
  const rawLines = useMemo(() => codexDisplayLines(state.codexTranscript), [state.codexTranscript]);
  const fallbackLines = useMemo(() => state.events.map(formatEvent), [state.events]);
  const sourceLines = rawLines.length > 0 ? rawLines : fallbackLines;
  const view = useMemo(() => wrappedViewport(sourceLines, contentWidth, scrollOffset, viewportHeight), [contentWidth, scrollOffset, sourceLines, viewportHeight]);
  const hasRun = Boolean(state.checkpoint || state.events.length > 0);
  const running = Boolean(state.checkpoint && state.checkpoint.supervisor_state !== 'STOP' && state.checkpoint.supervisor_state !== 'FAILED');

  useEffect(() => {
    setScrollOffset((current) => Math.min(current, view.maxScroll));
  }, [view.maxScroll]);

  useInput((input, key) => {
    const wheel = mouseScrollDelta(input);
    if (wheel !== 0) setScrollOffset((current) => scrollBy(current, wheel, view.maxScroll));
    else if (isMouseInput(input)) return;
    else if (key.upArrow) setScrollOffset((current) => scrollBy(current, 1, view.maxScroll));
    else if (key.downArrow) setScrollOffset((current) => scrollBy(current, -1, view.maxScroll));
    else if (key.pageUp) setScrollOffset((current) => scrollBy(current, PAGE_SIZE, view.maxScroll));
    else if (key.pageDown) setScrollOffset((current) => scrollBy(current, -PAGE_SIZE, view.maxScroll));
    else if (key.home) setScrollOffset(view.maxScroll);
    else if (key.end) setScrollOffset(0);
  }, { isActive });

  return (
    <Box flexDirection="column" height="100%">
      {showTitle ? (
        <Text bold color={isActive ? 'greenBright' : 'green'}>
          EXECUTION
        </Text>
      ) : null}
      <Box flexDirection="column" height={viewportHeight} overflow="hidden">
        {view.lines.map((line, index) => (
          <Text key={`${view.start + index}-${line}`} color={execLineColor(line)}>
            {line || ' '}
          </Text>
        ))}
      </Box>
      {hasRun ? (
        <Box>
          {running ? (
            <Text color="cyan">
              <Spinner type="dots" /> running
            </Text>
          ) : (
            <Text color="gray">idle</Text>
          )}
          <Text color={scrollOffset > 0 ? 'yellow' : 'gray'}>
            {' '}
            {view.end}/{view.total || 0}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
});

export function codexDisplayLines(rawLines: string[]): string[] {
  const completedCommandIds = new Set<string>();
  for (const raw of rawLines) {
    const parsed = parseJsonRecord(raw.trim());
    const event = parsed ? eventName(parsed) : '';
    const item = parsed ? recordValue(recordValue(parsed.params)?.item) ?? recordValue(parsed.item) : null;
    const itemType = stringValue(item?.type);
    const itemId = stringValue(item?.id);
    if ((event === 'item/completed' || event === 'item.completed') && itemId && (itemType === 'commandExecution' || itemType === 'command_execution')) {
      completedCommandIds.add(itemId);
    }
  }
  return rawLines.flatMap((line) => displayCodexRecord(line, completedCommandIds)).filter((line) => line.length > 0);
}

function displayCodexRecord(raw: string, completedCommandIds: Set<string>): string[] {
  const text = raw.trim();
  if (!text) return [];
  const parsed = parseJsonRecord(text);
  if (!parsed) return displayPartialCodexRecord(text);
  const event = eventName(parsed);
  const item = recordValue(recordValue(parsed.params)?.item) ?? recordValue(parsed.item);
  const source = item ?? parsed;
  const itemType = stringValue(source.type);
  const kind = itemType ?? event;
  const itemId = stringValue(source.id) ?? stringValue(recordValue(parsed.params)?.itemId);

  if (event === 'item/agentMessage/delta') return [];
  if (event === 'item/commandExecution/outputDelta') {
    if (itemId && completedCommandIds.has(itemId)) return [];
    return limitOutputLines(outputLines(stringValue(recordValue(parsed.params)?.delta) ?? ''));
  }
  if ((event === 'item/started' || event === 'item.started') && itemId && completedCommandIds.has(itemId) && (kind === 'commandExecution' || kind === 'command_execution')) {
    return [];
  }
  if (kind === 'agentMessage' || kind === 'agent_message' || kind === 'message') {
    return displayAgentMessage(stringValue(source.text) ?? stringValue(source.message));
  }
  if (kind === 'commandExecution' || kind === 'command_execution') {
    return displayCommand(source);
  }
  if (kind === 'fileChange' || kind === 'file_change') {
    return displayFileChanges(source);
  }
  if (event === 'turn/diff/updated' || event === 'turn.diff.updated') {
    return displayDiff(stringValue(recordValue(parsed.params)?.diff) ?? stringValue(parsed.diff));
  }
  if (event === 'thread/tokenUsage/updated') {
    return displayTokenUsage(recordValue(recordValue(parsed.params)?.tokenUsage));
  }
  if (event === 'turn/completed' || event === 'turn.completed') {
    return displayTurnCompleted(parsed);
  }
  if (event === 'turn/failed' || event === 'turn.failed' || event === 'error') {
    return [`error: ${clip(errorText(parsed))}`];
  }
  if (kind === 'reasoning') {
    return displayReasoning(source);
  }
  if (event === 'account/rateLimits/updated') return [];
  if (event === 'item/started' || event === 'item.started') return [];
  return event ? [`${event}`] : [clip(text)];
}

function displayAgentMessage(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  const structured = parseJsonRecord(text);
  if (structured) {
    const notes = stringValue(structured.notes);
    const next = stringValue(structured.next);
    const changed = Array.isArray(structured.changed_files)
      ? structured.changed_files.filter((file): file is string => typeof file === 'string')
      : [];
    return [
      ...(notes ? outputLines(`codex: ${notes}`) : []),
      ...(next ? outputLines(`next: ${next}`) : []),
      ...(changed.length > 0 ? [`files: ${changed.join(', ')}`] : [])
    ];
  }
  return outputLines(text).map((line, index) => (index === 0 ? `codex: ${line}` : `       ${line}`));
}

function displayCommand(record: Record<string, unknown>): string[] {
  const command = stringValue(record.command);
  const output = stringValue(record.aggregatedOutput) ?? stringValue(record.aggregated_output) ?? stringValue(record.output);
  const exitCode = numberValue(record.exitCode) ?? numberValue(record.exit_code);
  const status = stringValue(record.status);
  const lines: string[] = [];
  if (command) lines.push(...displayCommandText(command));
  if (output?.trim()) lines.push(...limitOutputLines(outputLines(output)));
  if (exitCode !== undefined) lines.push(`exit ${exitCode}`);
  else if (status && status !== 'completed') lines.push(status);
  return lines;
}

function displayCommandText(command: string): string[] {
  const lines = outputLines(command);
  const formatted = lines.map((line, index) => (index === 0 ? `$ ${line}` : `  ${line}`));
  return limitOutputLines(formatted);
}

function displayFileChanges(record: Record<string, unknown>): string[] {
  const changes = Array.isArray(record.changes) ? record.changes : [];
  return changes.flatMap((change) => {
    const item = recordValue(change);
    if (!item) return [];
    const path = stringValue(item.path);
    const kind = stringValue(item.kind) ?? 'change';
    return path ? [`file ${kind}: ${path}`] : [];
  });
}

function displayDiff(diff: string | undefined): string[] {
  if (!diff?.trim()) return [];
  const files = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2]);
  if (files.length > 0) return [`diff: ${files.slice(0, 4).join(', ')}${files.length > 4 ? ` (+${files.length - 4})` : ''}`];
  return [`diff: ${clip(diff.replace(/\s+/g, ' '))}`];
}

function displayTokenUsage(tokenUsage: Record<string, unknown> | null): string[] {
  const total = recordValue(tokenUsage?.total);
  const totalTokens = numberValue(total?.totalTokens) ?? numberValue(total?.total_tokens);
  const input = numberValue(total?.inputTokens) ?? numberValue(total?.input_tokens);
  const output = numberValue(total?.outputTokens) ?? numberValue(total?.output_tokens);
  const parts = [
    totalTokens !== undefined ? `total=${formatUsageNumber(totalTokens)}` : '',
    input !== undefined ? `in=${formatUsageNumber(input)}` : '',
    output !== undefined ? `out=${formatUsageNumber(output)}` : ''
  ].filter(Boolean);
  return parts.length > 0 ? [`tokens: ${parts.join(' ')}`] : [];
}

function displayTurnCompleted(record: Record<string, unknown>): string[] {
  const usage = recordValue(record.usage) ?? recordValue(recordValue(record.data)?.usage);
  if (!usage) return ['turn completed'];
  const total = numberValue(usage.total_tokens) ?? numberValue(usage.totalTokens);
  const input = numberValue(usage.input_tokens) ?? numberValue(usage.inputTokens);
  const output = numberValue(usage.output_tokens) ?? numberValue(usage.outputTokens);
  const parts = [
    total !== undefined ? `total=${formatUsageNumber(total)}` : '',
    input !== undefined ? `in=${formatUsageNumber(input)}` : '',
    output !== undefined ? `out=${formatUsageNumber(output)}` : ''
  ].filter(Boolean);
  return [`turn completed${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`];
}

function displayReasoning(record: Record<string, unknown>): string[] {
  const summary = Array.isArray(record.summary) ? record.summary : [];
  const lines = summary
    .map((entry) => stringValue(entry) ?? stringValue(recordValue(entry)?.text))
    .filter((entry): entry is string => Boolean(entry?.trim()));
  return lines.length > 0 ? limitOutputLines(lines.map((line) => `reasoning: ${line}`)) : [];
}

function displayPartialCodexRecord(raw: string): string[] {
  const method = regexJsonString(raw, 'method') ?? regexJsonString(raw, 'type') ?? regexJsonString(raw, 'event') ?? regexJsonString(raw, 'name');
  const itemType = regexJsonString(raw, 'type');
  const command = regexJsonString(raw, 'command');
  const output = regexJsonString(raw, 'aggregatedOutput') ?? regexJsonString(raw, 'aggregated_output') ?? regexJsonString(raw, 'output');
  const text = regexJsonString(raw, 'text') ?? regexJsonString(raw, 'message');
  const diff = regexJsonString(raw, 'diff');
  const lines: string[] = [];
  if (itemType === 'agentMessage' || itemType === 'agent_message') lines.push(...displayAgentMessage(text));
  if (command) lines.push(...displayCommandText(command));
  if (output) lines.push(...limitOutputLines(outputLines(output)));
  if (diff) lines.push(...displayDiff(diff));
  if (lines.length > 0) return lines;
  if (method) return [`${method}${raw.includes('[truncated') || raw.includes('[tail clipped]') ? ' (truncated)' : ''}`];
  return [clip(raw.replace(/^\[tail clipped\]\s*/, ''))];
}

function outputLines(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => clip(line))
    .filter((line) => line.length > 0);
}

function limitOutputLines(lines: string[]): string[] {
  if (lines.length <= MAX_OUTPUT_LINES_PER_EVENT) return lines;
  return [...lines.slice(0, MAX_OUTPUT_LINES_PER_EVENT), `... ${lines.length - MAX_OUTPUT_LINES_PER_EVENT} more output lines`];
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    return recordValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

function eventName(record: Record<string, unknown>): string {
  return stringValue(record.method) ?? stringValue(record.type) ?? stringValue(record.event) ?? stringValue(record.name) ?? '';
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function regexJsonString(raw: string, key: string): string | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(raw);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

function errorText(record: Record<string, unknown>): string {
  const error = recordValue(record.error) ?? recordValue(recordValue(record.params)?.error);
  return stringValue(error?.message) ?? stringValue(record.message) ?? stringValue(recordValue(record.params)?.message) ?? 'unknown error';
}

function clip(text: string, limit = MAX_FIELD_CHARS): string {
  const normalized = text.replace(/\t/g, '  ');
  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 3))}...` : normalized;
}

export function visibleEvents(events: RunEvent[], scrollOffset: number, size: number): { events: RunEvent[]; start: number; end: number } {
  if (events.length === 0 || size <= 0) return { events: [], start: 0, end: 0 };
  const clampedOffset = Math.min(Math.max(0, scrollOffset), Math.max(0, events.length - size));
  const end = Math.max(0, events.length - clampedOffset);
  const start = Math.max(0, end - size);
  return {
    events: events.slice(start, end),
    start,
    end
  };
}

export function formatEvent(event: RunEvent): string {
  const time = event.ts.slice(11, 19);
  const usage = usageSuffix(event);
  return `${time} ${event.type} ${event.message}${usage}`;
}

function usageSuffix(event: RunEvent): string {
  if (/tokens?\b|tok\b|\bin=\d+|\bout=\d+/i.test(event.message)) return '';
  const usage = usageRecord(event.data);
  if (!usage) return '';
  const input = numberField(usage, 'tokens_input') ?? numberField(usage, 'input_tokens');
  const output = numberField(usage, 'tokens_output') ?? numberField(usage, 'output_tokens');
  const total = numberField(usage, 'total_tokens');
  const usd = numberField(usage, 'usd') ?? numberField(usage, 'total_cost_usd') ?? numberField(usage, 'cost_usd');
  const parts: string[] = [];
  if (total !== undefined) parts.push(`total=${formatUsageNumber(total)}`);
  if (input !== undefined) parts.push(`in=${formatUsageNumber(input)}`);
  if (output !== undefined) parts.push(`out=${formatUsageNumber(output)}`);
  if (usd !== undefined) parts.push(`$${usd.toFixed(usd < 1 ? 4 : 2)}`);
  return parts.length > 0 ? ` tok ${parts.join(' ')}` : '';
}

function usageRecord(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const usage = record.usage;
  if (usage && typeof usage === 'object' && !Array.isArray(usage)) return usage as Record<string, unknown>;
  return record;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatUsageNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function colorFor(event: RunEvent): string {
  if (event.level === 'error') return 'red';
  if (event.level === 'warn') return 'yellow';
  if (event.type === 'COMMIT') return 'green';
  if (event.type === 'EXECUTE_START' || event.type === 'EXECUTE_PROGRESS' || event.type === 'PLAN_USAGE') return 'cyan';
  return 'white';
}

function execLineColor(line: string): string {
  if (line.startsWith('error:') || /^exit [1-9]/.test(line)) return 'red';
  if (line.startsWith('codex:') || line.startsWith('next:')) return 'cyanBright';
  if (line.startsWith('$ ')) return 'cyan';
  if (line.startsWith('exit 0') || line.startsWith('turn completed')) return 'green';
  if (line.startsWith('file ') || line.startsWith('diff:')) return 'magenta';
  if (line.startsWith('tokens:') || line.endsWith('(truncated)')) return 'gray';
  return 'white';
}
