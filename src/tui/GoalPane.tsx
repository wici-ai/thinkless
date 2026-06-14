import React from 'react';
import { Box, Text, useFocus } from 'ink';
import type { RunState } from './useRunState.js';

export function GoalPane({ state }: { state: RunState }) {
  const { isFocused } = useFocus({ id: 'goal' });
  const goal = state.goal;
  const planLines = state.plan.split('\n').filter(Boolean).slice(0, 34);

  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      <Text bold color={isFocused ? 'magentaBright' : 'magenta'}>
        热 GOAL {goal ? `v${goal.version}` : ''}
      </Text>
      <Box flexDirection="column">
        {(goal?.requirements ?? []).slice(-5).map((req) => (
          <Text key={req.id} color={req.status === 'active' ? 'white' : 'gray'}>
            {req.id} {req.status}: {req.text}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {planLines.map((line, index) => (
          <Text key={`${index}-${line}`} color={line.includes('[>]') ? 'cyan' : line.includes('[x]') ? 'green' : line.includes('[!]') ? 'yellow' : 'white'}>
            {line.length > 72 ? `${line.slice(0, 69)}...` : line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
