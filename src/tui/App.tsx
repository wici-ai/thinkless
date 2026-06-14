import React from 'react';
import { Box, useInput, useStdout, useFocusManager } from 'ink';
import { Header } from './Header.js';
import { ChatPane } from './ChatPane.js';
import { GoalPane } from './GoalPane.js';
import { ExecPane } from './ExecPane.js';
import { useRunState } from './useRunState.js';

export function App({ target, interactive = true }: { target: string; interactive?: boolean }) {
  const state = useRunState(target);
  const { stdout } = useStdout();
  const { focusNext, focusPrevious } = useFocusManager();
  const height = stdout.rows || 32;

  useInput((_input, key) => {
    if (key.tab && key.shift) focusPrevious();
    else if (key.tab) focusNext();
  }, { isActive: interactive });

  return (
    <Box flexDirection="column" height={height}>
      <Header state={state} />
      <Box flexGrow={1}>
        <Box width="28%" borderStyle="round" borderColor="cyan">
          <ChatPane target={target} interactive={interactive} outbox={state.outbox} />
        </Box>
        <Box width="34%" borderStyle="round" borderColor="magenta">
          <GoalPane state={state} />
        </Box>
        <Box flexGrow={1} borderStyle="round" borderColor="green">
          <ExecPane state={state} />
        </Box>
      </Box>
    </Box>
  );
}
