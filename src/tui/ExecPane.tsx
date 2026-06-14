import React from 'react';
import { Box, Static, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { RunEvent } from '../shared/types.js';
import type { RunState } from './useRunState.js';

export function ExecPane({ state }: { state: RunState }) {
  const events = state.events.slice(-200);
  const stable = events.slice(0, -1);
  const live = events.at(-1);
  const running = state.checkpoint?.supervisor_state !== 'STOP' && state.checkpoint?.supervisor_state !== 'FAILED';

  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      <Text bold color="green">
        事实执行
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        <Static items={stable}>
          {(event) => (
            <Text key={event.seq ?? `${event.ts}-${event.type}`} color={colorFor(event)}>
              {formatEvent(event)}
            </Text>
          )}
        </Static>
        {live ? <Text color={colorFor(live)}>{formatEvent(live)}</Text> : <Text color="gray">waiting for events</Text>}
      </Box>
      <Box>
        {running ? (
          <Text color="cyan">
            <Spinner type="dots" /> running
          </Text>
        ) : (
          <Text color="gray">idle</Text>
        )}
      </Box>
    </Box>
  );
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
