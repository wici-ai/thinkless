import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, useInput, useStdout, useFocusManager } from 'ink';
import { Header } from './Header.js';
import { ChatPane } from './ChatPane.js';
import { GoalPane } from './GoalPane.js';
import { ExecPane } from './ExecPane.js';
import { useRunState } from './useRunState.js';
import { runSupervisor } from '../supervisor/index.js';
import type { RunOptions, ToolMode } from '../shared/types.js';

export interface TuiSupervisorOptions {
  enabled: boolean;
  initialGoal?: string;
  maxIters?: number;
  resumeIteration?: number;
  mode?: ToolMode;
  lockMode?: 'auto' | 'manual';
}

export function App({
  target,
  interactive = true,
  supervisor = { enabled: false }
}: {
  target: string;
  interactive?: boolean;
  supervisor?: TuiSupervisorOptions;
}) {
  const state = useRunState(target);
  const { stdout } = useStdout();
  const { focus, focusNext, focusPrevious } = useFocusManager();
  const height = stdout.rows || 32;
  const startedRef = useRef(false);
  const [started, setStarted] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const launchSupervisor = useCallback(
    (goal?: string, goalSource?: RunOptions['goalSource']) => {
      if (!supervisor.enabled || startedRef.current) return;
      startedRef.current = true;
      setStarted(true);
      setStartError(null);
      const options: RunOptions = {
        target,
        goal,
        goalSource,
        maxIters: supervisor.maxIters,
        resumeIteration: supervisor.resumeIteration,
        mode: supervisor.mode,
        lockMode: supervisor.lockMode
      };
      void runSupervisor(options).catch((error: unknown) => {
        setStartError(error instanceof Error ? error.message : String(error));
      }).finally(() => {
        startedRef.current = false;
        setStarted(false);
      });
    },
    [target, supervisor.enabled, supervisor.lockMode, supervisor.maxIters, supervisor.mode, supervisor.resumeIteration]
  );

  useEffect(() => {
    if (!supervisor.enabled || !supervisor.initialGoal) return;
    launchSupervisor(supervisor.initialGoal, 'tui_goal_option');
  }, [launchSupervisor, supervisor.enabled, supervisor.initialGoal]);

  useEffect(() => {
    if (!supervisor.enabled || supervisor.initialGoal || !shouldAutoStartExistingRun(state)) return;
    launchSupervisor(undefined);
  }, [launchSupervisor, state.goal, state.checkpoint?.supervisor_state, supervisor.enabled, supervisor.initialGoal]);

  useInput((_input, key) => {
    if (key.escape) focus('chat');
    else if (key.tab && key.shift) focusPrevious();
    else if (key.tab) focusNext();
  }, { isActive: interactive });

  const acceptInitialGoal = shouldAcceptInitialGoalFromChat({
    supervisorEnabled: supervisor.enabled,
    supervisorStarted: started,
    state
  });

  return (
    <Box flexDirection="column" height={height}>
      <Header state={state} />
      <Box flexGrow={1}>
        <Box width="28%" borderStyle="round" borderColor="cyan">
          <ChatPane
            target={target}
            interactive={interactive}
            outbox={state.outbox}
            injections={state.injections}
            goal={state.goal}
            goalDoc={state.goalDoc}
            plan={state.plan}
            events={state.events}
            chat={state.chat}
            mode={supervisor.mode}
            acceptInitialGoal={acceptInitialGoal}
            onInitialGoal={(goal) => launchSupervisor(goal, 'tui_chat')}
            onInjection={() => launchSupervisor(undefined)}
            systemLine={startError}
          />
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

export function shouldAutoStartExistingRun(state: ReturnType<typeof useRunState>): boolean {
  if (!state.goal) return false;
  const supervisorState = state.checkpoint?.supervisor_state;
  if (supervisorState === 'STOP' || supervisorState === 'FAILED') return false;
  return true;
}

export function shouldAcceptInitialGoalFromChat(input: {
  supervisorEnabled: boolean;
  supervisorStarted: boolean;
  state: ReturnType<typeof useRunState>;
}): boolean {
  if (!input.supervisorEnabled || input.supervisorStarted) return false;
  return !hasRunBlackboard(input.state);
}

function hasRunBlackboard(state: ReturnType<typeof useRunState>): boolean {
  return Boolean(
    state.goal ||
      state.checkpoint ||
      state.events.length > 0 ||
      state.goalDoc.trim() ||
      state.plan.trim() ||
      state.ledger.length > 0 ||
      state.outbox.length > 0
  );
}
