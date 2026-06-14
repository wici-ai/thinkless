import React from 'react';
import { Box, Text } from 'ink';
import type { RunState } from './useRunState.js';

export function Header({ state }: { state: RunState }) {
  const checkpoint = state.checkpoint;
  const baseline = state.baseline;
  const last = state.events.at(-1);
  const p99 = baseline ? `${baseline.best_metric.p99.toFixed(2)}${baseline.best_metric.unit}` : 'pending';
  const iter = checkpoint?.iter ?? 0;
  const status = checkpoint?.supervisor_state ?? 'BOOT';

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text bold>WiCi</Text>
      <Text color={status === 'FAILED' ? 'red' : status === 'STOP' ? 'green' : 'cyan'}>{status}</Text>
      <Text>iter {iter}</Text>
      <Text>best p99 {p99}</Text>
      <Text color={last?.level === 'error' ? 'red' : last?.level === 'warn' ? 'yellow' : 'gray'}>{last?.type ?? 'idle'}</Text>
    </Box>
  );
}
