import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, useInput, useStdout, useFocusManager } from 'ink';
import { Header } from './Header.js';
import { ChatPane } from './ChatPane.js';
import { GoalPane } from './GoalPane.js';
import { ExecPane } from './ExecPane.js';
import { useRunState } from './useRunState.js';
import { runSupervisor } from '../supervisor/index.js';
import type { RunOptions, ToolMode } from '../shared/types.js';
import { enableMouseReporting, parseMouseInput } from './input.js';
import { appendSupervisorError } from './supervisorLog.js';

const CHAT_PANE_WIDTH = 0.4;
const GOAL_PANE_WIDTH = 0.3;
const CHAT_PANE_PERCENT = `${Math.round(CHAT_PANE_WIDTH * 100)}%`;
const GOAL_PANE_PERCENT = `${Math.round(GOAL_PANE_WIDTH * 100)}%`;

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
  const width = stdout.columns || 120;
  const paneHeight = Math.max(6, height - 4);
  const chatPaneColumns = Math.floor(width * CHAT_PANE_WIDTH);
  const goalPaneColumns = Math.floor(width * GOAL_PANE_WIDTH);
  const chatContentWidth = Math.max(24, chatPaneColumns - 4);
  const goalContentWidth = Math.max(20, goalPaneColumns - 4);
  const execContentWidth = Math.max(24, width - chatPaneColumns - goalPaneColumns - 8);
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
        const message = error instanceof Error ? error.message : String(error);
        setStartError(`Supervisor error: ${message}`);
        void appendSupervisorError(target, error);
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

  useEffect(() => {
    if (!interactive) return;
    return enableMouseReporting(stdout);
  }, [interactive, stdout]);

  useInput((input, key) => {
    const mouse = parseMouseInput(input);
    if (mouse && !mouse.released) {
      if (mouse.x <= chatPaneColumns) focus('chat');
      else if (mouse.x <= chatPaneColumns + goalPaneColumns) focus('goal');
      else focus('exec');
      return;
    }
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
        <Box width={CHAT_PANE_PERCENT} borderStyle="round" borderColor="cyan">
          <ChatPane
            target={target}
            interactive={interactive}
            outbox={state.outbox}
            injections={state.injections}
            goal={state.goal}
            supervisorState={state.checkpoint?.supervisor_state}
            goalDoc={state.goalDoc}
            plan={state.plan}
            events={state.events}
            chat={state.chat}
            mode={supervisor.mode}
            contentWidth={chatContentWidth}
            viewportHeight={Math.max(3, paneHeight - 3)}
            acceptInitialGoal={acceptInitialGoal}
            onInitialGoal={(goal) => launchSupervisor(goal, 'tui_chat')}
            onInjection={() => launchSupervisor(undefined)}
            systemLine={startError}
          />
        </Box>
        <Box width={GOAL_PANE_PERCENT} borderStyle="round" borderColor="magenta">
          <GoalPane state={state} contentWidth={goalContentWidth} viewportHeight={Math.max(4, paneHeight - 2)} />
        </Box>
        <Box flexGrow={1} borderStyle="round" borderColor="green">
          <ExecPane state={state} contentWidth={execContentWidth} viewportHeight={Math.max(4, paneHeight - 3)} />
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
