import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout, useFocusManager } from 'ink';
import { Header } from './Header.js';
import { ChatHistoryPane, ChatInputBox } from './ChatPane.js';
import { GoalPane } from './GoalPane.js';
import { ExecPane } from './ExecPane.js';
import { useRunState } from './useRunState.js';
import { runSupervisor } from '../supervisor/index.js';
import type { RunOptions, ToolMode } from '../shared/types.js';
import { enableMouseReporting, parseMouseInput } from './input.js';
import { appendSupervisorError } from './supervisorLog.js';
import {
  cycleRuntimeValue,
  defaultRuntimeSelection,
  formatRuntimeSelectorLine,
  nextRuntimeField,
  previousRuntimeField,
  runtimePaneFromWorkspace,
  type RuntimeField
} from './runtimeSettings.js';

type WorkspaceTab = 'chat' | 'plan' | 'execution';
const WORKSPACE_TABS: WorkspaceTab[] = ['chat', 'plan', 'execution'];

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
  const inputContentWidth = Math.max(24, width - 4);
  const workspaceContentWidth = Math.max(32, width - 4);
  const workspaceViewportHeight = Math.max(4, height - 8);
  const startedRef = useRef(false);
  const pendingSupervisorLaunchRef = useRef<{ goal?: string; goalSource?: RunOptions['goalSource']; planningContext?: string } | null>(null);
  const pendingWorkspaceFocusRef = useRef(false);
  const [started, setStarted] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(supervisor.initialGoal ? 'execution' : 'chat');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatLocalStatus, setChatLocalStatus] = useState<string | null>(null);
  const [runtimeSelection, setRuntimeSelection] = useState(defaultRuntimeSelection);
  const [runtimeSelectorOpen, setRuntimeSelectorOpen] = useState(false);
  const [runtimeField, setRuntimeField] = useState<RuntimeField>('agent');
  const runtimePane = runtimePaneFromWorkspace(workspaceTab);

  const launchSupervisor = useCallback(
    (goal?: string, goalSource?: RunOptions['goalSource'], planningContext?: string) => {
      if (!supervisor.enabled) return;
      if (startedRef.current) {
        pendingSupervisorLaunchRef.current = { goal, goalSource, planningContext };
        return;
      }
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
        lockMode: supervisor.lockMode,
        runtime: runtimeSelection,
        planningContext
      };
      void runSupervisor(options).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setStartError(`Supervisor error: ${message}`);
        void appendSupervisorError(target, error);
      }).finally(() => {
        startedRef.current = false;
        setStarted(false);
        const pending = pendingSupervisorLaunchRef.current;
        pendingSupervisorLaunchRef.current = null;
        if (pending) setTimeout(() => launchSupervisor(pending.goal, pending.goalSource, pending.planningContext), 0);
      });
    },
    [runtimeSelection, target, supervisor.enabled, supervisor.lockMode, supervisor.maxIters, supervisor.mode, supervisor.resumeIteration]
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

  useEffect(() => {
    if (!pendingWorkspaceFocusRef.current) return;
    pendingWorkspaceFocusRef.current = false;
    focus(workspaceFocusId(workspaceTab));
  }, [focus, workspaceTab]);

  const selectWorkspaceTab = useCallback(
    (tab: WorkspaceTab, shouldFocus = true) => {
      if (shouldFocus) pendingWorkspaceFocusRef.current = true;
      setWorkspaceTab(tab);
      if (workspaceTab === tab && shouldFocus) {
        pendingWorkspaceFocusRef.current = false;
        focus(workspaceFocusId(tab));
      }
    },
    [focus, workspaceTab]
  );

  useInput((input, key) => {
    if (isRuntimeSelectorToggle(input, key)) {
      setRuntimeSelectorOpen((current) => !current);
      return;
    }
    if (runtimeSelectorOpen) {
      if (key.leftArrow) {
        setRuntimeField((current) => previousRuntimeField(current));
      } else if (key.rightArrow) {
        setRuntimeField((current) => nextRuntimeField(current));
      } else if (key.upArrow) {
        setRuntimeSelection((current) => cycleRuntimeValue(current, runtimePane, runtimeField, 1));
      } else if (key.downArrow) {
        setRuntimeSelection((current) => cycleRuntimeValue(current, runtimePane, runtimeField, -1));
      } else if (key.return || key.escape) {
        setRuntimeSelectorOpen(false);
      }
      return;
    }
    const mouse = parseMouseInput(input);
    if (mouse && !mouse.released) {
      focus(workspaceFocusId(workspaceTab));
      return;
    }
    if (key.leftArrow) selectWorkspaceTab(previousWorkspaceTab(workspaceTab));
    else if (key.rightArrow) selectWorkspaceTab(nextWorkspaceTab(workspaceTab));
    else if (key.escape) focus('chat-input');
    else if (key.tab && key.shift) focusPrevious();
    else if (key.tab) focusNext();
  }, { isActive: interactive });

  const blankRunChat = shouldUseChatAgentForBlankRun({
    supervisorEnabled: supervisor.enabled,
    supervisorStarted: started,
    state
  });

  return (
    <Box flexDirection="column" height={height}>
      <Header state={state} />
      <Box flexGrow={1} borderStyle="round" borderColor={workspaceColor(workspaceTab)}>
        <Box flexDirection="column" height="100%" paddingX={1}>
          <Text color={runtimeSelectorOpen ? 'yellow' : 'gray'} bold={runtimeSelectorOpen}>
            {`CHAT / PLAN / EXECUTION  ${formatRuntimeSelectorLine(runtimeSelection, runtimePane, runtimeSelectorOpen ? runtimeField : null)}`}
          </Text>
          {workspaceTab === 'chat' ? (
            <ChatHistoryPane
              interactive={interactive}
              outbox={state.outbox}
              injections={state.injections}
            goal={state.goal}
              supervisorState={state.checkpoint?.supervisor_state}
              chat={state.chat}
              contentWidth={workspaceContentWidth}
              viewportHeight={workspaceViewportHeight}
              active={workspaceTab === 'chat' && !runtimeSelectorOpen}
              showTitle={false}
              systemLine={startError}
              localStatus={chatLocalStatus}
              busy={chatBusy}
            />
          ) : workspaceTab === 'plan' ? (
            <GoalPane state={state} contentWidth={workspaceContentWidth} viewportHeight={workspaceViewportHeight} showTitle={false} active={interactive && !runtimeSelectorOpen} />
          ) : (
            <ExecPane state={state} contentWidth={workspaceContentWidth} viewportHeight={workspaceViewportHeight} showTitle={false} active={interactive && !runtimeSelectorOpen} />
          )}
        </Box>
      </Box>
      <ChatInputBox
        target={target}
        interactive={interactive}
        outbox={state.outbox}
        goalDoc={state.goalDoc}
        plan={state.plan}
        events={state.events}
        chat={state.chat}
        mode={supervisor.mode}
        runtime={runtimeSelection}
        contentWidth={inputContentWidth}
        inputPaused={runtimeSelectorOpen}
        blankRun={blankRunChat}
        onPlanningRequested={(goal, planningContext) => launchSupervisor(goal, 'tui_chat', planningContext)}
        onInjection={() => launchSupervisor(undefined)}
        onRuntimeChange={setRuntimeSelection}
        onBusyChange={setChatBusy}
        onLocalStatus={setChatLocalStatus}
      />
    </Box>
  );
}

function isRuntimeSelectorToggle(input: string, key: { ctrl?: boolean }): boolean {
  return input === '\x12' || (key.ctrl === true && input.toLowerCase() === 'r');
}

function workspaceFocusId(tab: WorkspaceTab): 'chat-history' | 'goal' | 'exec' {
  if (tab === 'chat') return 'chat-history';
  return tab === 'plan' ? 'goal' : 'exec';
}

function previousWorkspaceTab(tab: WorkspaceTab): WorkspaceTab {
  const index = WORKSPACE_TABS.indexOf(tab);
  return WORKSPACE_TABS[(index + WORKSPACE_TABS.length - 1) % WORKSPACE_TABS.length];
}

function nextWorkspaceTab(tab: WorkspaceTab): WorkspaceTab {
  const index = WORKSPACE_TABS.indexOf(tab);
  return WORKSPACE_TABS[(index + 1) % WORKSPACE_TABS.length];
}

function workspaceColor(tab: WorkspaceTab): 'cyan' | 'magenta' | 'green' {
  if (tab === 'chat') return 'cyan';
  return tab === 'plan' ? 'magenta' : 'green';
}

export function shouldAutoStartExistingRun(state: ReturnType<typeof useRunState>): boolean {
  if (!state.goal) return false;
  const supervisorState = state.checkpoint?.supervisor_state;
  if (supervisorState === 'STOP' || supervisorState === 'FAILED') return false;
  return true;
}

export function shouldUseChatAgentForBlankRun(input: {
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
