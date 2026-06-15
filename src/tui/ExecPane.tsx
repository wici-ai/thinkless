import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useFocus, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { RunEvent } from '../shared/types.js';
import type { RunState } from './useRunState.js';
import { mouseScrollDelta } from './input.js';
import { PAGE_SIZE, scrollBy, viewport, wrapLines } from './viewport.js';

const VISIBLE_EVENTS = 18;

export const ExecPane = React.memo(function ExecPane({
  state,
  contentWidth = 48,
  viewportHeight = VISIBLE_EVENTS
}: {
  state: RunState;
  contentWidth?: number;
  viewportHeight?: number;
}) {
  const { isFocused } = useFocus({ id: 'exec' });
  const [scrollOffset, setScrollOffset] = useState(0);
  const rawLines = useMemo(() => codexDisplayLines(state.codexTranscript), [state.codexTranscript]);
  const fallbackLines = useMemo(() => state.events.map(formatEvent), [state.events]);
  const sourceLines = rawLines.length > 0 ? rawLines : fallbackLines;
  const displayLines = useMemo(() => wrapLines(sourceLines, contentWidth), [contentWidth, sourceLines]);
  const view = viewport(displayLines, scrollOffset, viewportHeight);
  const hasRun = Boolean(state.checkpoint || state.events.length > 0);
  const running = Boolean(state.checkpoint && state.checkpoint.supervisor_state !== 'STOP' && state.checkpoint.supervisor_state !== 'FAILED');

  useEffect(() => {
    setScrollOffset((current) => Math.min(current, view.maxScroll));
  }, [view.maxScroll]);

  useInput((input, key) => {
    const wheel = mouseScrollDelta(input);
    if (wheel !== 0) setScrollOffset((current) => scrollBy(current, wheel, view.maxScroll));
    else if (key.upArrow || input === 'k') setScrollOffset((current) => scrollBy(current, 1, view.maxScroll));
    else if (key.downArrow || input === 'j') setScrollOffset((current) => scrollBy(current, -1, view.maxScroll));
    else if (key.pageUp || input === 'u') setScrollOffset((current) => scrollBy(current, PAGE_SIZE, view.maxScroll));
    else if (key.pageDown || input === 'd') setScrollOffset((current) => scrollBy(current, -PAGE_SIZE, view.maxScroll));
    else if (key.home || input === 'g') setScrollOffset(view.maxScroll);
    else if (key.end || input === 'G') setScrollOffset(0);
  }, { isActive: isFocused });

  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      <Text bold color={isFocused ? 'greenBright' : 'green'}>
        EXECUTION
      </Text>
      <Box flexDirection="column" flexGrow={1}>
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
            {view.end}/{displayLines.length || 0}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
});

export function codexDisplayLines(rawLines: string[]): string[] {
  const output: string[] = [];
  for (const raw of rawLines) {
    const parsed = parseJson(raw);
    if (!parsed) {
      output.push(raw);
      continue;
    }
    output.push(...displayLinesFromRecord(parsed, raw));
  }
  return output.filter((line) => line.length > 0);
}

function displayLinesFromRecord(record: Record<string, unknown>, raw: string): string[] {
  const type = stringValue(record.type) ?? stringValue(record.event) ?? stringValue(record.name);
  const item = recordValue(record.item);
  const source = item ?? record;
  const itemType = stringValue(source.type);
  const lines: string[] = [];

  const command = stringValue(source.command);
  if (command) lines.push(`[command] ${command}`);

  const query = stringValue(source.query);
  if (query) lines.push(`[web] ${query}`);

  const text = stringValue(source.text) ?? stringValue(source.message);
  if (text) lines.push(...text.split(/\r?\n/));

  const output = stringValue(source.aggregated_output) ?? stringValue(source.output);
  if (output) lines.push(...output.replace(/\s+$/, '').split(/\r?\n/));

  const changes = Array.isArray(source.changes) ? source.changes : undefined;
  if (changes) {
    for (const change of changes) {
      const changeRecord = recordValue(change);
      if (!changeRecord) continue;
      const path = stringValue(changeRecord.path);
      const kind = stringValue(changeRecord.kind);
      if (path) lines.push(`[file ${kind ?? 'change'}] ${path}`);
    }
  }

  const exitCode = source.exit_code;
  if (typeof exitCode === 'number') lines.push(`[exit] ${exitCode}`);

  if (lines.length > 0) return lines;
  if (type === 'turn.completed') return ['[turn.completed]'];
  if (type || itemType) return [`[${type ?? itemType}] ${raw}`];
  return [raw];
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return recordValue(parsed);
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
  if (line.startsWith('[command]')) return 'cyan';
  if (line.startsWith('[exit] 0')) return 'green';
  if (line.startsWith('[exit]')) return 'yellow';
  if (line.startsWith('[file')) return 'magenta';
  if (line.startsWith('[web]')) return 'blue';
  return 'white';
}
