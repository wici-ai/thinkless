import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout, useFocusManager } from 'ink';
import { basename } from 'node:path';
import { Header } from './Header.js';
import { ChatHistoryPane, ChatInputBox } from './ChatPane.js';
import { GoalPane } from './GoalPane.js';
import { ExecPane } from './ExecPane.js';
import { useRunState, type RunState } from './useRunState.js';
import { runSupervisor } from '../supervisor/index.js';
import type { RunOptions, ToolMode } from '../shared/types.js';
import { INITIAL_GOAL_REQUIRED_MESSAGE } from '../shared/messages.js';
import { readPersistedRuntimeSelection, writePersistedRuntimeSelection } from '../shared/chatSession.js';
import { runPaths } from '../shared/paths.js';
import { disablePointerInput, enableMouseReporting, parseMouseInput } from './input.js';
import { traceInkInput } from './inputTrace.js';
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
  resumeOnOpen?: boolean;
}

export function App({
  target,
  interactive = true,
  supervisor = { enabled: false },
  mouseReporting = false
}: {
  target: string;
  interactive?: boolean;
  supervisor?: TuiSupervisorOptions;
  mouseReporting?: boolean;
}) {
  const state = useRunState(target);
  const { stdout } = useStdout();
  const { focus, focusNext, focusPrevious } = useFocusManager();
  const height = stdout.rows || 32;
  const width = stdout.columns || 120;
  const inputContentWidth = Math.max(24, width - 4);
  const workspaceContentWidth = Math.max(32, width - 4);
  const workspaceViewportHeight = Math.max(4, height - 9);
  const chatViewportHeight = Math.max(4, height - 10);
  const startedRef = useRef(false);
  const pendingSupervisorLaunchRef = useRef<{ goal?: string; goalSource?: RunOptions['goalSource']; planningContext?: string } | null>(null);
  const pendingWorkspaceFocusRef = useRef(false);
  const [started, setStarted] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(supervisor.initialGoal ? 'execution' : 'chat');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatLocalStatus, setChatLocalStatus] = useState<string | null>(null);
  const [runtimeSelection, setRuntimeSelection] = useState(defaultRuntimeSelection);
  const [runtimeHydrated, setRuntimeHydrated] = useState(false);
  const [runtimeSelectorOpen, setRuntimeSelectorOpen] = useState(false);
  const [runtimeField, setRuntimeField] = useState<RuntimeField>('agent');
  const [mouseReportingEnabled, setMouseReportingEnabled] = useState(mouseReporting);
  const runtimePane = runtimePaneFromWorkspace(workspaceTab);
  const runtimeSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    const paths = runPaths(target);
    setRuntimeHydrated(false);
    void readPersistedRuntimeSelection(paths).then((persisted) => {
      if (!alive) return;
      const next = persisted ?? defaultRuntimeSelection();
      runtimeSignatureRef.current = JSON.stringify(next);
      setRuntimeSelection(next);
      setRuntimeHydrated(true);
    }).catch((error: unknown) => {
      if (!alive) return;
      runtimeSignatureRef.current = JSON.stringify(defaultRuntimeSelection());
      setRuntimeHydrated(true);
      setChatLocalStatus(`runtime restore failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => {
      alive = false;
    };
  }, [target]);

  useEffect(() => {
    if (!runtimeHydrated) return;
    const signature = JSON.stringify(runtimeSelection);
    if (signature === runtimeSignatureRef.current) return;
    runtimeSignatureRef.current = signature;
    void writePersistedRuntimeSelection(runPaths(target), runtimeSelection).catch((error: unknown) => {
      setChatLocalStatus(`runtime save failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [runtimeHydrated, runtimeSelection, target]);

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
    if (!runtimeHydrated || !supervisor.enabled || !supervisor.initialGoal) return;
    launchSupervisor(supervisor.initialGoal, 'tui_goal_option');
  }, [launchSupervisor, runtimeHydrated, supervisor.enabled, supervisor.initialGoal]);

  useEffect(() => {
    if (!runtimeHydrated || !supervisor.enabled || supervisor.initialGoal || !supervisor.resumeOnOpen || !shouldAutoStartExistingRun(state, true)) return;
    launchSupervisor(undefined);
  }, [launchSupervisor, runtimeHydrated, state.goal, state.checkpoint?.supervisor_state, supervisor.enabled, supervisor.initialGoal, supervisor.resumeOnOpen]);

  useEffect(() => {
    if (!interactive) return;
    if (!mouseReportingEnabled) {
      disablePointerInput(stdout);
      return undefined;
    }
    return enableMouseReporting(stdout);
  }, [interactive, mouseReportingEnabled, stdout]);

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
    traceInkInput('app', input, key as unknown as Record<string, unknown>);
    if (isMouseModeToggle(input, key)) {
      setMouseReportingEnabled((current) => !current);
      return;
    }
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
    const mouse = mouseReportingEnabled ? parseMouseInput(input) : null;
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
          <Box height={1} justifyContent="space-between">
            <WorkspaceTabs active={workspaceTab} />
            <Text color={runtimeSelectorOpen ? 'yellow' : 'gray'} bold={runtimeSelectorOpen} wrap="truncate-end">
              {formatRuntimeSelectorLine(runtimeSelection, runtimePane, runtimeSelectorOpen ? runtimeField : null)} mouse={mouseReportingEnabled ? 'scroll' : 'select'}
            </Text>
          </Box>
          {workspaceTab === 'chat' ? (
            <ChatHistoryPane
              interactive={interactive}
              outbox={state.outbox}
              injections={state.injections}
              goal={state.goal}
              supervisorState={state.checkpoint?.supervisor_state}
              chat={state.chat}
              contentWidth={workspaceContentWidth}
              viewportHeight={chatViewportHeight}
              active={workspaceTab === 'chat' && !runtimeSelectorOpen}
              showTitle={false}
              systemLine={startError}
              localStatus={chatLocalStatus}
              activityStatus={buildActivityStatus(state)}
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
        hasExistingRun={Boolean(state.goal)}
        onPlanningRequested={(goal, planningContext) => launchSupervisor(goal, 'tui_chat', planningContext)}
        onInjection={() => launchSupervisor(undefined)}
        onResumeRequested={() => launchSupervisor(undefined)}
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

function isMouseModeToggle(input: string, key: { ctrl?: boolean }): boolean {
  return input === '\x0f' || (key.ctrl === true && input.toLowerCase() === 'o');
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

function WorkspaceTabs({ active }: { active: WorkspaceTab }) {
  return (
    <Box flexShrink={0}>
      {WORKSPACE_TABS.map((tab, index) => (
        <React.Fragment key={tab}>
          <Text color={tab === active ? workspaceColor(tab) : 'gray'} bold={tab === active}>
            {workspaceTabPill(tab, tab === active)}
          </Text>
          {index < WORKSPACE_TABS.length - 1 ? <Text color="gray">  </Text> : null}
        </React.Fragment>
      ))}
    </Box>
  );
}

function workspaceTabPill(tab: WorkspaceTab, active: boolean): string {
  const label = workspaceTabLabel(tab);
  return active ? `[${label}]` : ` ${label} `;
}

function workspaceTabLabel(tab: WorkspaceTab): string {
  if (tab === 'chat') return 'CHAT';
  if (tab === 'plan') return 'PLAN';
  if (tab === 'execution') return 'EXECUTION';
  return tab;
}

export function shouldAutoStartExistingRun(state: ReturnType<typeof useRunState>, explicitResume = false): boolean {
  if (!state.goal) return false;
  if (!explicitResume) return false;
  const supervisorState = state.checkpoint?.supervisor_state;
  if (supervisorState === 'FAILED') return false;
  return true;
}

export function buildActivityStatus(state: RunState): string | null {
  const checkpoint = state.checkpoint;
  if (!checkpoint || checkpoint.supervisor_state === 'STOP' || checkpoint.supervisor_state === 'FAILED') return null;
  const latest = [...state.events].reverse();
  const latestEvent = latest[0];
  if (latestEvent?.type === 'PLAN_RETRY_WAIT' || latestEvent?.type === 'EXECUTE_RETRY_WAIT') {
    return `waiting: ${shortEventMessage(latestEvent)}`;
  }
  if (checkpoint.supervisor_state === 'PLAN') {
    const event = latest.find((item) => item.type.startsWith('PLAN_'));
    return event ? `planner ${eventAge(event.ts)}: ${shortEventMessage(event)}` : 'planner is updating PLAN.md';
  }
  if (checkpoint.supervisor_state === 'EXECUTE') {
    const event = latest.find((item) => item.type.startsWith('EXECUTE_'));
    const step = checkpoint.next_step ? ` ${checkpoint.next_step}` : '';
    const appStatus = formatExecutorAppStatus(checkpoint.sessions.executorApp);
    if (appStatus) {
      const suffix = event ? `: ${shortEventMessage(event)}` : '';
      return `executor${step} ${appStatus}${suffix}`;
    }
    return event ? `executor${step} ${eventAge(event.ts)}: ${shortEventMessage(event)}` : `executor${step} is running`;
  }
  if (!latestEvent) return checkpoint.supervisor_state.toLowerCase();
  return `${checkpoint.supervisor_state.toLowerCase()} ${eventAge(latestEvent.ts)}: ${shortEventMessage(latestEvent)}`;
}

function formatExecutorAppStatus(session: NonNullable<RunState['checkpoint']>['sessions']['executorApp'] | undefined): string | null {
  if (!session) return null;
  const phase = session.phase ?? (session.activeTurnId ? 'running' : 'idle');
  const workspace = session.workspace ? ` in ${basename(session.workspace) || session.workspace}` : '';
  const lastActivity = session.lastActivityAt ?? session.updatedAt;
  const active = phase === 'running' || phase === 'starting';
  const state = active ? `active ${phase}` : phase;
  const idle = lastActivity ? `, last activity ${eventAge(lastActivity)}` : '';
  const event = session.lastEventType ? `, ${session.lastEventType}` : '';
  return `${state}${workspace}${idle}${event}`;
}

function shortEventMessage(event: RunState['events'][number]): string {
  const text = event.message.replace(/\s+/g, ' ').trim();
  return truncate(text, 180);
}

function eventAge(ts: string): string {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return 'recently';
  const seconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
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
  if (state.goal || state.checkpoint || state.goalDoc.trim() || state.plan.trim() || state.ledger.length > 0) return true;
  if (state.outbox.some((message) => !isInitialGoalRequiredText(message.text))) return true;
  return state.events.some((event) => !isInitialGoalRequiredText(event.message));
}

function isInitialGoalRequiredText(text: string | undefined): boolean {
  return Boolean(text?.includes(INITIAL_GOAL_REQUIRED_MESSAGE));
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}
