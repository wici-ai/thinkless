import React, { useEffect, useMemo, useState } from 'react';
import { Box, Static, Text, useFocus, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { RunEvent } from '../shared/types.js';
import type { RunState } from './useRunState.js';

const VISIBLE_EVENTS = 18;
const PAGE_SIZE = 8;

export function ExecPane({ state }: { state: RunState }) {
  const { isFocused } = useFocus({ id: 'exec' });
  const [scrollOffset, setScrollOffset] = useState(0);
  const maxScroll = Math.max(0, state.events.length - VISIBLE_EVENTS);
  const viewport = useMemo(() => visibleEvents(state.events, scrollOffset, VISIBLE_EVENTS), [state.events, scrollOffset]);
  const tailing = scrollOffset === 0;
  const displayedEvents = tailing ? state.events : viewport.events;
  const stable = displayedEvents.slice(0, -1);
  const live = displayedEvents.at(-1);
  const rangeStart = state.events.length === 0 ? 0 : tailing ? 1 : viewport.start + 1;
  const rangeEnd = tailing ? state.events.length : viewport.end;
  const hasRun = Boolean(state.checkpoint || state.events.length > 0);
  const running = Boolean(state.checkpoint && state.checkpoint.supervisor_state !== 'STOP' && state.checkpoint.supervisor_state !== 'FAILED');

  useEffect(() => {
    setScrollOffset((current) => Math.min(current, maxScroll));
  }, [maxScroll]);

  useInput((_input, key) => {
    if (key.upArrow) setScrollOffset((current) => Math.min(maxScroll, current + 1));
    else if (key.downArrow) setScrollOffset((current) => Math.max(0, current - 1));
    else if (key.pageUp) setScrollOffset((current) => Math.min(maxScroll, current + PAGE_SIZE));
    else if (key.pageDown) setScrollOffset((current) => Math.max(0, current - PAGE_SIZE));
    else if (key.home) setScrollOffset(maxScroll);
    else if (key.end) setScrollOffset(0);
  }, { isActive: isFocused });

  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      <Text bold color={isFocused ? 'greenBright' : 'green'}>
        事实执行
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        <Static key={tailing ? 'exec-static-tail' : `exec-static-${viewport.start}-${viewport.end}`} items={stable}>
          {(event) => (
            <Text key={event.seq ?? `${event.ts}-${event.type}`} color={colorFor(event)}>
              {formatEvent(event)}
            </Text>
          )}
        </Static>
        {live ? <Text color={colorFor(live)}>{formatEvent(live)}</Text> : null}
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
            {rangeStart}-{rangeEnd}/{state.events.length || 0}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
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

function formatEvent(event: RunEvent): string {
  const time = event.ts.slice(11, 19);
  return `${time} ${event.type} ${event.message}`;
}

function colorFor(event: RunEvent): string {
  if (event.level === 'error') return 'red';
  if (event.level === 'warn') return 'yellow';
  if (event.type === 'COMMIT') return 'green';
  if (event.type === 'EXECUTE_START') return 'cyan';
  return 'white';
}
