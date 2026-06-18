import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TOOL_ROOT } from '../shared/paths.js';
import type { Checkpoint, GoalFile, LedgerEntry, RunEvent } from '../shared/types.js';
import { buildBlankRunPlanningContext, buildChatHistory, currentGoalSummary } from '../tui/ChatPane.js';
import { codexDisplayLines, formatEvent, visibleEvents } from '../tui/ExecPane.js';
import { buildPlanDiffView } from '../tui/GoalPane.js';
import { costSummary, elapsedSummary, metricSummary, rollbackSummary } from '../tui/Header.js';
import { disableMouseReporting, isMouseInput, mouseScrollDelta, parseMouseInput } from '../tui/input.js';
import { shouldTraceInput } from '../tui/inputTrace.js';
import { cycleRuntimeValue, defaultRuntimeSelection, formatRuntimeSelectorLine, parseRuntimeCommand } from '../tui/runtimeSettings.js';
import { scrollDeltaForInput, viewport, wrapLines, wrappedViewport } from '../tui/viewport.js';
import { buildFallbackChatTurn, shouldStartPlannerFromBlankChat, summarizePlanForChat } from '../supervisor/chatAgent.js';

const tuiRoot = join(TOOL_ROOT, 'src', 'tui');

async function main(): Promise<void> {
  const files = {
    app: await source('App.tsx'),
    chat: await source('ChatPane.tsx'),
    exec: await source('ExecPane.tsx'),
    goal: await source('GoalPane.tsx'),
    header: await source('Header.tsx'),
    input: await source('input.ts'),
    inputTrace: await source('inputTrace.ts'),
    runtime: await source('runtimeSettings.ts'),
    viewport: await source('viewport.ts'),
    state: await source('useRunState.ts'),
    chatAgent: await readFile(join(TOOL_ROOT, 'src', 'supervisor', 'chatAgent.ts'), 'utf8'),
    chatSession: await readFile(join(TOOL_ROOT, 'src', 'shared', 'chatSession.ts'), 'utf8'),
    chatPrompt: await readFile(join(TOOL_ROOT, 'prompts', 'chat.md'), 'utf8'),
    supervisor: await readFile(join(TOOL_ROOT, 'src', 'supervisor', 'index.ts'), 'utf8'),
    goalDoc: await readFile(join(TOOL_ROOT, 'src', 'supervisor', 'goalDoc.ts'), 'utf8'),
    types: await readFile(join(TOOL_ROOT, 'src', 'shared', 'types.ts'), 'utf8'),
    crashHandlers: await readFile(join(TOOL_ROOT, 'src', 'shared', 'crashHandlers.ts'), 'utf8'),
    cli: await readFile(join(TOOL_ROOT, 'src', 'cli.tsx'), 'utf8')
  };

  const staticUses = Object.entries(files)
    .filter(([name]) => ['app', 'chat', 'exec', 'goal', 'header', 'state'].includes(name))
    .flatMap(([name, text]) => occurrences(text, '<Static').map((index) => ({ name, index })));
  assert(staticUses.length === 0, `TUI panes must use scrollable viewports instead of Static regions, found ${JSON.stringify(staticUses)}`);

  assert(files.app.includes('useInput') && files.app.includes('useFocusManager'), 'App must keep keyboard focus management at the top level');
  assert(files.app.includes('enableMouseReporting'), 'App must enable terminal mouse reporting for pane-local wheel scroll');
  assert(files.input.includes("ENABLE_MOUSE_REPORTING_SEQUENCE = '\\x1b[?1007h'") && files.input.includes('DISABLE_MOUSE_REPORTING_SEQUENCE') && files.input.includes('disableMouseReporting') && files.input.includes("'SIGINT'") && !files.input.includes('?1000h') && !files.input.includes('?1002h') && !files.input.includes('?1003h'), 'TUI default scroll mode must match Codex alternate-scroll behavior without enabling mouse capture');
  assert(files.input.includes('parseSgrMouseInputs') && files.input.includes('parseUrxvtMouseInputs') && files.input.includes('parseX10MouseInputs'), 'TUI mouse parser must cover common terminal mouse encodings');
  assert(files.app.includes('parseMouseInput') && files.app.includes('workspaceFocusId(workspaceTab)'), 'App must focus the active workspace pane from mouse clicks');
  assert(files.app.includes("focus('chat-input')") && files.app.includes('key.escape'), 'App must route Escape back to the Chat input');
  assert(files.app.includes('<ChatHistoryPane') && files.app.includes('<ChatInputBox') && files.app.includes('<GoalPane') && files.app.includes('<ExecPane'), 'App must render top Chat/Plan/Execution tabs plus the bottom Chat input');
  assert(files.app.includes('workspaceTab') && files.app.includes('key.leftArrow') && files.app.includes('key.rightArrow'), 'App must switch the Plan/Execution workspace with left/right arrows');
  assert(files.app.includes('CHAT') && files.app.includes('PLAN') && files.app.includes('EXECUTION') && files.app.includes('showTitle={false}'), 'App must expose Chat/Plan/Execution as one top tabbed workspace');
  assert(files.app.includes('shouldUseChatAgentForBlankRun'), 'App must route blank-run input through the Chat agent before planning starts');
  assert(files.app.includes('shouldAutoStartExistingRun'), 'App must avoid auto-restarting stopped runs while still supporting resume on attach');
  assert(files.app.includes('onInjection={() => launchSupervisor(undefined)}'), 'App must wake the supervisor after Chat writes an inbox injection');
  assert(files.app.includes('pendingSupervisorLaunchRef') && files.app.includes('setTimeout(() => launchSupervisor'), 'App must not drop Chat wakeups that arrive while the supervisor is still exiting');
  assert(files.app.includes('runtimeSelection') && files.app.includes('formatRuntimeSelectorLine') && files.app.includes('runtimeSelectorOpen'), 'App must expose a visible per-workspace runtime selector in the TUI');
  assert(files.app.includes('readPersistedRuntimeSelection') && files.app.includes('writePersistedRuntimeSelection') && files.app.includes('runtimeHydrated'), 'App must restore persisted runtime before resuming Chat/supervisor sessions');
  assert(files.app.includes('<WorkspaceTabs active={workspaceTab} />') && files.app.includes('wrap="truncate-end"') && files.app.includes('height={1} justifyContent="space-between"'), 'App must render aligned one-line workspace tabs and a truncating runtime selector');
  assert(files.app.includes('const workspaceViewportHeight = Math.max(4, height - 9)') && files.app.includes('const chatViewportHeight = Math.max(4, height - 10)'), 'App must reserve rows for the tab line, pane footer, and bottom Chat input');
  assert(files.app.includes('isRuntimeSelectorToggle') && files.app.includes('cycleRuntimeValue') && files.app.includes('inputPaused={runtimeSelectorOpen}'), 'App must let users choose runtime fields from the TUI without typing into Chat');
  assert(files.app.includes('onRuntimeChange={setRuntimeSelection}'), 'App must still support typed runtime commands for custom values');
  assert(files.app.includes('runtime: runtimeSelection'), 'App must pass TUI runtime settings into supervisor launches');
  assert(files.app.includes('appendSupervisorError') && files.app.includes('Supervisor error:'), 'App must persist supervisor crashes without flooding the Chat transcript');
  assert(files.app.includes('buildActivityStatus(state)') && files.app.includes("type === 'EXECUTE_RETRY_WAIT'") && files.app.includes("type.startsWith('EXECUTE_')"), 'App must surface compact live supervisor activity in the Chat pane');
  assert(files.app.includes("launchSupervisor(supervisor.initialGoal, 'tui_goal_option')"), 'App must keep --goal as an explicit automation shortcut');
  assert(files.app.includes("launchSupervisor(goal, 'tui_chat', planningContext)"), 'App must mark blank-run Chat-agent planning as TUI Chat source and pass Chat context');
  assert(files.app.includes('planningContext') && files.app.includes('pendingSupervisorLaunchRef'), 'App must preserve Chat planning context across delayed supervisor launches');
  assert(files.app.includes('goal={state.goal}'), 'App must pass durable goal state into Chat history');
  assert(files.app.includes('supervisorState={state.checkpoint?.supervisor_state}'), 'App must pass terminal supervisor state into Chat so stale errors do not occupy the input pane');
  assertNoControlWrites('App', files.app);

  assert(files.chat.includes("id: 'chat-history'") && files.chat.includes("id: 'chat-input'"), 'Chat history and Chat input must have stable focus ids');
  assert(files.chat.includes('isActive: interactive && active'), 'Chat history scroll must be gated on the active top tab');
  assert(files.chat.includes('isActive: interactive })'), 'Chat input must remain active independently at the bottom');
  assert(files.chat.includes('writeInjection'), 'Chat input must write chat input through writeInjection');
  assert(files.chat.includes('buildChatHistory'), 'ChatPane must render persisted chat history');
  assert(files.chat.includes('currentGoalSummary'), 'ChatPane must keep current goal in a compact header outside transcript history');
  assert(files.chat.includes('isActiveOutboxMessage') && files.chat.includes("supervisorState !== 'STOP'") && files.chat.includes("supervisorState !== 'FAILED'"), 'ChatPane must hide stale error outbox messages after terminal run states');
  assert(files.chat.includes('wrappedViewport') && files.chat.includes('line.color') && files.chat.includes('line.bold'), 'ChatPane must preserve per-line role styling instead of guessing colors from text prefixes');
  assert(files.chat.includes('activityStatus') && files.chat.includes("blockLines('activity'"), 'ChatPane must render compact live activity without writing it into chat history');
  assert(!files.chat.includes('chatLineColor'), 'ChatPane must not color chat by fragile string-prefix guessing');
  assert(files.chat.includes('Number.POSITIVE_INFINITY'), 'ChatPane must not truncate long chat turns before the scroll viewport');
  assert(files.chat.includes('wrappedViewport') && files.chat.includes('wrapLines'), 'ChatPane must render full wrapped content through a scroll viewport');
  assert(files.chat.includes('mouseScrollDelta') && files.chat.includes('isMouseInput'), 'ChatPane must support pane-local mouse wheel scroll and ignore raw mouse escape text');
  assert(
    !files.chat.includes("input === 'd'") &&
      !files.chat.includes("input === 'g'") &&
      !files.chat.includes("input === 'j'") &&
      !files.chat.includes("input === 'k'") &&
      !files.chat.includes("input === 'u'"),
    'ChatPane must not swallow ordinary letters as scroll shortcuts'
  );
  assert(files.chat.includes('runChatTurn') && files.chat.includes('writeUpdate: !blankRun'), 'ChatPane must always let the Chat agent decide whether blank-run input should start planning');
  assert(files.chat.includes('result.degraded && !shouldStartPlannerFromBlankChat') && files.chat.includes('buildBlankRunPlanningContext'), 'ChatPane must guard only degraded blank-run planner starts and pass conversation context when planning starts');
  assert(files.chat.includes('onPlanningRequested') && files.chat.includes('blankRun'), 'ChatPane must launch planning only from a Chat-agent update on blank runs');
  assert(!files.chat.includes('acceptInitialGoal') && !files.chat.includes('onInitialGoal'), 'ChatPane must not bypass the Chat agent for first-message goal intake');
  assert(files.chat.includes('onInjection?.()'), 'ChatPane must notify App after writing inbox injections');
  assert(files.chat.includes('parseRuntimeCommand') && files.chat.includes('onRuntimeChange'), 'ChatPane must support runtime selection slash commands');
  assert(files.chat.includes('inputPaused') && files.chat.includes('isActive: interactive && !inputPaused'), 'ChatPane must pause bottom input while the runtime selector is active');
  assert(files.chat.includes("input.includes('\\r')") && files.chat.includes("input.includes('\\n')"), 'ChatPane must submit PTY input chunks that include a trailing newline');
  assert(files.chat.includes("kind: 'add_requirement'"), 'ChatPane must default text input to add_requirement injections');
  assert(files.chat.includes("kind: 'answer'"), 'ChatPane must support outbox answers');
  assert(files.chat.includes('latestQuestion') && files.chat.includes('planner-clarify-'), 'ChatPane must route open planner questions through answer injections');
  assert(files.chat.includes("kind: 'steer'"), 'ChatPane must support steering injections');
  assert(files.chat.includes("kind: 'abort'"), 'ChatPane must support urgent abort injections');
  assertNoControlWrites('ChatPane', files.chat);
  assert(!files.chat.includes('initial goal:') && !files.chat.includes('`goal: ${text}`'), 'ChatPane transcript must not repeat the initial goal as history');

  assert(files.runtime.includes('parseRuntimeCommand') && files.runtime.includes('/(agent|model|effort)'), 'runtime settings must parse agent/effort commands and reject model changes with a fixed-model status');
  assert(files.runtime.includes('formatRuntimeSelectorLine') && files.runtime.includes('cycleRuntimeValue') && files.runtime.includes('RUNTIME_FIELDS'), 'runtime settings must expose selector formatting and value cycling');
  assert(files.runtime.includes("RUNTIME_FIELDS: RuntimeField[] = ['agent', 'effort']"), 'runtime selector must expose agent and effort only');
  assert(files.runtime.includes('RUNTIME_AGENTS') && files.runtime.includes('runtimeModelForAgent'), 'runtime settings must offer claude/codex agents with fixed models');

  assert(!files.chatAgent.includes('readJsonLines<ChatLogEntry>(paths.chat)') && !files.chatAgent.includes('Recent Chat transcript'), 'Chat agent must not replay persisted Chat transcript into every prompt');
  assert(files.chatAgent.includes('resumeSessionId') && /'exec',\r?\n\s+'resume'/.test(files.chatAgent) && !files.chatAgent.includes("'--ephemeral'"), 'Codex Chat must persist and resume its own session instead of running ephemerally');
  assert(files.chatAgent.includes("'--dangerously-bypass-approvals-and-sandbox'"), 'Codex Chat resume must use flags supported by codex exec resume');
  assert(files.chatAgent.includes("'danger-full-access'") && !files.chatAgent.includes("'read-only'"), 'Codex Chat must support bounded SSH/network inspection instead of read-only-only sandboxing');
  assert(!files.chatAgent.includes("'--permission-mode',\n    'plan'"), 'Claude Chat must not be forced into planner-only mode');
  assert(!files.chatAgent.includes('normalizeChatTurn') && !files.chatAgent.includes('shouldKeepInChat'), 'Chat agent must not post-filter real UPDATE decisions');
  assert(files.chatPrompt.includes('UPDATE is a handoff, not a status note') && files.chatPrompt.includes('If a lightweight direct task fails'), 'Chat prompt must raise the source UPDATE threshold instead of filtering after the fact');
  assert(files.chatSession.includes('sessions?: Partial<Record<ChatSessionAgent') && files.chatSession.includes('paths.runtimeSelection') && files.chatSession.includes('readPersistedRuntimeSelection'), 'Chat sessions must store per-agent sessions and keep persisted TUI runtime in a separate file');
  assert(files.chatAgent.includes("writeChatSession(ctx.paths, 'codex'") && files.chatAgent.includes("agent: 'codex'"), 'Codex Chat must persist its session together with runtime metadata');
  assert(!files.chatAgent.includes('normalizeChatTurnResult'), 'Chat agent must trust real agent UPDATE decisions instead of normalizing them with local prompt hacks');
  assert(files.chatAgent.includes('shouldStartPlannerFromBlankChat') && files.chatAgent.includes('hasConcreteActionIntent'), 'Chat fallback must use a generalized action-intent guard only when the agent is degraded');
  assert(files.types.includes('planningContext?: string'), 'RunOptions must carry planningContext from TUI to supervisor');
  assert(files.supervisor.includes('planningContext') && files.supervisor.includes('Chat context before planning:'), 'Supervisor must add Chat context to the initial GOAL.md contract');
  assert(files.supervisor.includes('PLAN_RETRY_WAIT') && files.supervisor.includes('EXECUTE_RETRY_WAIT') && files.supervisor.includes('transientRetryDelayMs'), 'Supervisor must wait and retry transient planner/executor network failures');
  assert(files.goalDoc.includes('renderConstraintMarkdown'), 'GOAL.md renderer must preserve multiline Chat context constraints');

  assert(files.goal.includes("useFocus({ id: 'goal'"), 'GoalPane must be focusable for Tab navigation');
  assert(files.goal.includes('useInput') && files.goal.includes('active?: boolean') && files.goal.includes('const isActive = active ?? isFocused'), 'GoalPane scroll input must be gated on the active top tab or focus');
  assert(files.goal.includes('state.goalDoc'), 'GoalPane must render the user-facing GOAL.md document');
  assert(!files.goal.includes('goal?.requirements'), 'GoalPane must not use internal goal.json requirements as the primary goal UI');
  assert(files.goal.includes('buildPlanDiffView'), 'GoalPane must compute a visible PLAN diff');
  assert(files.goal.includes('GOAL / PLAN'), 'GoalPane title must be English');
  assert(files.goal.includes('wrappedViewport'), 'GoalPane must render full GOAL.md and PLAN.md through a lazy scroll viewport');
  assert(files.goal.includes('mouseScrollDelta') && !files.goal.includes("input === 'k'") && !files.goal.includes("input === 'g'"), 'GoalPane must support wheel scroll without swallowing ordinary letters');
  assertNoControlWrites('GoalPane', files.goal);
  assert(!files.goal.includes("? `${") && !files.goal.includes("...'"), 'GoalPane must not intentionally ellipsize content');

  assert(files.exec.includes("useFocus({ id: 'exec'"), 'ExecPane must be focusable for scroll controls');
  assert(files.exec.includes('useInput') && files.exec.includes('active?: boolean') && files.exec.includes('const isActive = active ?? isFocused'), 'ExecPane input must be gated on the active top tab or focus');
  for (const key of ['upArrow', 'downArrow', 'pageUp', 'pageDown', 'home', 'end']) {
    assert(files.exec.includes('scrollDeltaForInput') && files.viewport.includes(`${key}?: boolean`) && files.viewport.includes(`key.${key}`), `ExecPane missing ${key} scroll binding`);
  }
  assert(files.exec.includes('visibleEvents') && files.exec.includes('scrollOffset'), 'ExecPane must render an in-pane scroll viewport');
  assert(files.exec.includes('mouseScrollDelta') && !files.exec.includes("input === 'k'") && !files.exec.includes("input === 'g'"), 'ExecPane must support wheel scroll without swallowing ordinary letters');
  assert(files.exec.includes('codexDisplayLines') && files.exec.includes('displayCodexRecord') && files.exec.includes('state.codexTranscript'), 'ExecPane must render readable Codex transcript lines');
  assert(files.exec.includes('EXECUTION'), 'ExecPane title must be English');
  assertNoControlWrites('ExecPane', files.exec);
  assert(!files.goal.includes('writeInjection'), 'GoalPane must not write inbox injections');
  assert(!files.exec.includes('writeInjection'), 'ExecPane must not write inbox injections');

  assert(files.header.includes('metricSummary'), 'Header must show planner-selected validation only after a goal exists');
  assert(files.header.includes('rollbackSummary'), 'Header must show git rollback/checkpoint status');
  assert(files.header.includes('costSummary'), 'Header must show cumulative run cost');
  assert(files.header.includes('elapsedSummary'), 'Header must show elapsed run time');
  assert(files.header.includes('const summary = [') && files.header.includes('height={1} paddingX={1}') && files.header.includes('wrap="truncate-end"'), 'Header must stay one line and truncate overflow instead of wrapping into the workspace');

  assert(files.state.includes("import chokidar from 'chokidar'"), 'useRunState must use chokidar for blackboard watching');
  for (const watched of ['paths.events', 'paths.codexRun', 'paths.goal', 'paths.goalDoc', 'paths.checkpoint', 'paths.baseline', 'paths.ledger', 'paths.plan', 'paths.outbox']) {
    assert(files.state.includes(watched), `useRunState watcher missing ${watched}`);
  }
  assert(files.state.includes('paths.inbox') && files.state.includes('paths.inboxDone'), 'useRunState watcher must include persisted Chat inbox history');
  assert(files.state.includes('readInjectionHistory'), 'useRunState must read persisted Chat injection history');
  assert(files.state.includes('readInjectionDir(inboxDone, true)'), 'useRunState must treat injections moved to inbox/done as applied');
  assert(files.state.includes('readTailLinesMaybe') && files.state.includes('CODEX_RUN_MAX_LINE_CHARS'), 'useRunState must tail and cap large Codex transcript lines instead of decoding whole jsonl files into the TUI');
  assert(files.state.includes('readJsonLinesTailMaybe<RunEvent>(paths.events') && files.state.includes('readRawLinesMaybe(paths.codexRun'), 'useRunState must tail high-churn event and Codex transcript files');
  assert(files.state.includes('setTimeout') && files.state.includes('UI_REFRESH_DEBOUNCE_MS'), 'useRunState must coalesce rapid file updates');
  assertNoFileWriteApis('useRunState', files.state);
  assertOnlyChatPaneWritesInbox(files);

  assert(files.cli.includes(".command('tui')"), 'CLI must expose the tui command');
  assert(files.cli.includes(".option('--no-supervisor'"), 'tui command must support read-only/manual launch without supervisor');
  assert(files.cli.includes(".option('--no-fullscreen'"), 'tui command must support non-fullscreen rendering for verification');
  assert(files.cli.includes('initialGoal: options.goal'), 'tui --goal must be explicit automation input, not an implicit default goal');
  assert(!files.cli.includes('prodEnv'), 'CLI must not force NODE_ENV=production because that prevents Ink from rendering the TUI');
  assert(!files.cli.includes('withFullScreen'), 'CLI must not use fullscreen-ink as the default renderer because it can enter alternate screen without painting Ink output');
  assert(files.cli.includes('renderInAlternateScreen') && files.cli.includes('?1049h') && files.cli.includes('?1049l'), 'CLI fullscreen mode must manage alternate screen directly around Ink render');
  assert(files.cli.includes('ENABLE_MOUSE_REPORTING_SEQUENCE') && files.cli.includes('DISABLE_MOUSE_REPORTING_SEQUENCE'), 'CLI fullscreen mode must enable mouse reporting before Ink effects and disable it during cleanup');
  assert(files.cli.includes('installTuiInputTrace') && files.inputTrace.includes('WICI_TUI_INPUT_TRACE') && files.inputTrace.includes('tui-input.jsonl'), 'CLI must support opt-in raw TUI input tracing for terminal mouse diagnosis');
  assert(files.crashHandlers.includes('performance.clearMarks') && files.crashHandlers.includes('performance.clearMeasures'), 'TUI runtime guards must clean Node user-timing entries without switching React/Ink to production mode');

  verifyVisibleEvents();
  verifyTextViewport();
  verifyMouseScroll();
  verifyInputTraceFilter();
  verifyRuntimeSettings();
  verifyChatFallback();
  verifyChatPlannerGuard();
  verifyBlankRunPlanningContext();
  verifyChatPromptCompression();
  verifyExecEventUsage();
  verifyCodexDisplayLines();
  verifyChatHistory();
  verifyGoalPlanDiff();
  verifyHeaderSummaries();

  console.log(
    JSON.stringify(
      {
        ok: true,
        scrollable_panes: true,
        esc_focuses_chat: true,
        exec_scroll_viewport: true,
        exec_codex_transcript: true,
        goal_plan_diff: true,
        header_cost_elapsed: true,
        header_rollback_status: true,
        chat_history: true,
        chat_writes_only_inbox: true,
        goal_and_exec_read_only: true,
        watcher_covers_blackboard: true
      },
      null,
      2
    )
  );
}

function verifyTextViewport(): void {
  const wrapped = wrapLines(['abcdef'], 2);
  assert(wrapped.join('|') === 'ab|cd|ef', `wrapLines should keep text inside pane width: ${wrapped.join('|')}`);
  const view = viewport(['1', '2', '3', '4'], 1, 2);
  assert(view.lines.join(',') === '2,3', `viewport should scroll independently, got ${view.lines.join(',')}`);
  const lazy = wrappedViewport(['abcdef', 'gh'], 2, 1, 2);
  assert(lazy.lines.join('|') === 'cd|ef' && lazy.total === 4 && lazy.maxScroll === 2, `wrappedViewport should only materialize visible wrapped lines, got ${JSON.stringify(lazy)}`);
  assert(scrollDeltaForInput('k', { ctrl: false }) === null, 'ordinary letters must not scroll while typing');
  assert(scrollDeltaForInput('k', { ctrl: true }) === 1, 'Ctrl-K should scroll up as a keyboard fallback');
  assert(scrollDeltaForInput('j', { ctrl: true }) === -1, 'Ctrl-J should scroll down as a keyboard fallback');
  assert(scrollDeltaForInput('u', { ctrl: true }) === 8, 'Ctrl-U should page up as a keyboard fallback');
  assert(scrollDeltaForInput('d', { ctrl: true }) === -8, 'Ctrl-D should page down as a keyboard fallback');
}

function verifyMouseScroll(): void {
  assert(mouseScrollDelta('\x1b[<64;20;10M') === 1, 'mouse wheel up should scroll into pane history');
  assert(mouseScrollDelta('\x1b[<65;20;10M') === -1, 'mouse wheel down should scroll toward pane tail');
  assert(mouseScrollDelta('[<65;20;10M') === -1, 'mouse wheel without ESC prefix should still scroll');
  assert(mouseScrollDelta('\x1b[<64;20;10M\x1b[<64;20;9M') === 2, 'touchpad chunks can contain multiple wheel events');
  assert(mouseScrollDelta('\x1b[<68;20;10M') === 1, 'modified wheel up should still scroll');
  assert(mouseScrollDelta('\x1b[<69;20;10M') === -1, 'modified wheel down should still scroll');
  assert(mouseScrollDelta('\x1b[64;20;10M') === 1, 'URXVT wheel up should scroll');
  assert(mouseScrollDelta('\x1b[65;20;10M') === -1, 'URXVT wheel down should scroll');
  assert(mouseScrollDelta(`\x1b[M${String.fromCharCode(96)}${String.fromCharCode(52)}${String.fromCharCode(42)}`) === 1, 'legacy X10 wheel up should scroll');
  assert(mouseScrollDelta(`\x1b[M${String.fromCharCode(97)}${String.fromCharCode(52)}${String.fromCharCode(42)}`) === -1, 'legacy X10 wheel down should scroll');
  assert(isMouseInput('[<65;31;33M'), 'raw SGR mouse text without ESC should be swallowed');
  assert(isMouseInput(`\x1b[M${String.fromCharCode(96)}${String.fromCharCode(52)}${String.fromCharCode(42)}`), 'raw X10 mouse text should be swallowed');
  const click = parseMouseInput('\x1b[<0;12;4M');
  assert(click?.code === 0 && click.x === 12 && click.y === 4 && click.released === false, 'mouse click parser should expose coordinates for pane focus');
  const legacyClick = parseMouseInput(`\x1b[M${String.fromCharCode(32)}${String.fromCharCode(44)}${String.fromCharCode(36)}`);
  assert(legacyClick?.code === 0 && legacyClick.x === 12 && legacyClick.y === 4, 'legacy mouse parser should expose coordinates for pane focus');
  assert(mouseScrollDelta('k') === 0, 'ordinary keyboard input must not parse as mouse scroll');
  assert(typeof disableMouseReporting === 'function', 'disableMouseReporting must be importable for terminal cleanup');
}

function verifyInputTraceFilter(): void {
  assert(shouldTraceInput('\x1b[<64;20;10M'), 'input trace should capture SGR mouse sequences');
  assert(shouldTraceInput('\x1b[A'), 'input trace should capture cursor escape sequences');
  assert(shouldTraceInput(`\x1b[M${String.fromCharCode(96)}${String.fromCharCode(52)}${String.fromCharCode(42)}`), 'input trace should capture legacy mouse sequences');
  assert(!shouldTraceInput('ordinary chat text'), 'input trace must not capture ordinary chat text');
}

function verifyRuntimeSettings(): void {
  const defaults = defaultRuntimeSelection();
  assert(defaults.chat?.agent === 'claude' && defaults.chat.model === 'claude-opus-4-8' && defaults.chat.effort === 'high', 'Chat runtime should default to Claude claude-opus-4-8 high');
  assert(defaults.planner?.agent === 'claude' && defaults.planner.model === 'claude-opus-4-8' && defaults.planner.effort === 'high', 'PLAN runtime should default to Claude claude-opus-4-8 high');
  assert(defaults.executor?.agent === 'codex' && defaults.executor.model === 'gpt-5.5' && defaults.executor.effort === 'medium', 'EXECUTION runtime should default to Codex gpt-5.5 medium');

  const line = formatRuntimeSelectorLine(defaults, 'executor', 'agent');
  assert(line.includes('[agent=codex]') && line.includes('effort=medium') && line.includes('model=gpt-5.5'), `runtime selector line should expose fixed model outside selectable fields: ${line}`);

  const codexHigh = parseRuntimeCommand('/effort execution high', defaults);
  assert(codexHigh?.next.executor?.effort === 'high' && codexHigh.next.executor.model === 'gpt-5.5', `Codex effort command should keep fixed model: ${JSON.stringify(codexHigh)}`);

  const codexDefault = parseRuntimeCommand('/effort execution default', codexHigh.next);
  assert(codexDefault?.next.executor?.effort === 'medium' && codexDefault.next.executor.model === 'gpt-5.5', `Codex default effort should reset to medium: ${JSON.stringify(codexDefault)}`);

  const badCodexEffort = parseRuntimeCommand('/effort execution ultracode', defaults);
  assert(badCodexEffort?.status.includes('unknown effort for codex') && badCodexEffort.next.executor?.effort === 'medium', `Codex should reject Claude-only effort: ${JSON.stringify(badCodexEffort)}`);

  const plannerCodex = parseRuntimeCommand('/agent plan codex', defaults);
  assert(plannerCodex?.next.planner, `PLAN agent switch should produce a planner runtime: ${JSON.stringify(plannerCodex)}`);
  const plannerCodexRuntime = plannerCodex.next.planner;
  assert(plannerCodexRuntime.agent === 'codex' && plannerCodexRuntime.model === 'gpt-5.5' && plannerCodexRuntime.effort === 'medium', `PLAN agent switch should force Codex defaults: ${JSON.stringify(plannerCodex)}`);

  const plannerFast = parseRuntimeCommand('/effort plan fast', plannerCodex.next);
  assert(plannerFast?.next.planner, `PLAN effort switch should produce a planner runtime: ${JSON.stringify(plannerFast)}`);
  const plannerFastRuntime = plannerFast.next.planner;
  assert(plannerFastRuntime.effort === 'fast' && plannerFastRuntime.model === 'gpt-5.5', `PLAN Codex effort should accept fast: ${JSON.stringify(plannerFast)}`);

  const modelNoop = parseRuntimeCommand('/model plan anything', plannerFast.next);
  assert(modelNoop?.next === plannerFast.next && modelNoop.status.includes('model is fixed by agent'), `model command should be a no-op status response: ${JSON.stringify(modelNoop)}`);

  const chatAgentCycle = cycleRuntimeValue(defaults, 'chat', 'agent', 1);
  assert(chatAgentCycle.chat?.agent === 'codex' && chatAgentCycle.chat.model === 'gpt-5.5' && chatAgentCycle.chat.effort === 'medium', `TUI agent cycle should switch Chat to Codex defaults: ${JSON.stringify(chatAgentCycle.chat)}`);

  const chatEffortCycle = cycleRuntimeValue(defaults, 'chat', 'effort', 1);
  assert(chatEffortCycle.chat?.agent === 'claude' && chatEffortCycle.chat.effort === 'xhigh', `TUI effort cycle should follow Claude effort options: ${JSON.stringify(chatEffortCycle.chat)}`);
}

function verifyChatFallback(): void {
  const result = buildFallbackChatTurn(
    {
      paths: {} as never,
      userText: '现在进展怎么样？',
      goalDoc: '# GOAL\n\nship it',
      plan: '# PLAN\n\n- [>] S6 Tune speed\n- [ ] S7 Verify',
      recentEvents: [fakeEvent(1), { ...fakeEvent(2), type: 'EXECUTE_PROGRESS', message: 'Codex is still running S6' }]
    },
    'test fallback'
  );
  assert(result.reply.trim().length > 0, 'Chat fallback must never produce an empty assistant reply');
  assert(!result.update, `Question fallback must not queue an add_requirement update: ${JSON.stringify(result)}`);
  assert(result.reply.includes('S6 Tune speed'), `Question fallback should summarize current plan step:\n${result.reply}`);
}

function verifyChatPlannerGuard(): void {
  assert(
    !shouldStartPlannerFromBlankChat('介绍一下你自己', { kind: 'add_requirement', text: '介绍一下你自己' }),
    'blank-run degraded guard must reject non-actionable fallback turns'
  );
  assert(
    !shouldStartPlannerFromBlankChat('请先阅读当前代码库，暂时不要开始计划。', { kind: 'add_requirement', text: 'Read the current repository.' }),
    'blank-run planner guard must reject context-gathering-only turns'
  );
  assert(
    shouldStartPlannerFromBlankChat('可以，开始修复这个问题', { kind: 'add_requirement', text: 'Fix the discussed issue.' }),
    'blank-run planner guard must allow explicit start/fix turns'
  );
}

function verifyBlankRunPlanningContext(): void {
  const context = buildBlankRunPlanningContext(
    [
      { ts: '2026-06-17T10:00:00.000Z', role: 'user', text: '先读一下代码。' },
      { ts: '2026-06-17T10:00:01.000Z', role: 'assistant', text: 'TUI 现在是上方 workspace，底部 chat input。' }
    ],
    '开始按这个方向修',
    {
      reply: '我会交给 planner。',
      update: { kind: 'add_requirement', text: 'Fix the TUI Chat intake context handoff.' },
      degraded: false
    }
  );
  assert(context.includes('USER: 先读一下代码。'), `planning context missing prior user turn:\n${context}`);
  assert(context.includes('ASSISTANT: TUI 现在是上方 workspace'), `planning context missing assistant turn:\n${context}`);
  assert(context.includes('USER: 开始按这个方向修'), `planning context missing trigger turn:\n${context}`);
  assert(context.includes('ASSISTANT UPDATE (add_requirement): Fix the TUI Chat intake context handoff.'), `planning context missing update:\n${context}`);
}

function verifyChatPromptCompression(): void {
  const longPlan = [
    '# PLAN',
    'Intro '.repeat(600),
    ...Array.from({ length: 80 }, (_, index) => [
      `- [ ] S${index + 1} Step ${index + 1}`,
      `  Action: do ${index + 1}`,
      `  Validation: check ${index + 1}`,
      `  Rollback / failure signal: recover ${index + 1}`
    ]).flat()
  ].join('\n');
  const summary = summarizePlanForChat(longPlan, 2_000);
  assert(summary.length <= 2_100, `Chat plan summary should be bounded, got ${summary.length}`);
  assert(summary.includes('- [ ] S1 Step 1'), 'Chat plan summary should preserve discoverable step lines');
  assert(summary.includes('[truncated'), 'Chat plan summary should mark truncation');
}

function verifyGoalPlanDiff(): void {
  const previous = ['# Plan', '- [ ] S1 Keep duplicate', '- [ ] S1 Keep duplicate', '- [ ] S2 Old'].join('\n');
  const current = ['# Plan', '- [ ] S1 Keep duplicate', '- [ ] S3 New'].join('\n');
  const diff = buildPlanDiffView(previous, current, 10);
  assert(diff.changed === true, 'GoalPane diff should mark changed plans');
  assert(diff.added === 1, `GoalPane diff should count one added line, got ${diff.added}`);
  assert(diff.removed === 2, `GoalPane diff should count removed duplicate and old line, got ${diff.removed}`);
  assert(diff.lines.find((line) => line.text.includes('S3 New'))?.added === true, 'GoalPane diff should mark new line as added');
  assert(diff.lines.find((line) => line.text.includes('S1 Keep duplicate'))?.added === false, 'GoalPane diff should not mark retained duplicate as added');
  assert(buildPlanDiffView(current, current, 10).changed === false, 'GoalPane diff should be stable when plan is unchanged');
}

function verifyHeaderSummaries(): void {
  const goal: GoalFile = {
    run_id: 'header',
    version: 1,
    requirements: [],
    acceptance_criteria: [],
    constraints: [],
    metric: { name: 'throughput', direction: 'maximize', target: 700, unit: 'tok/s' },
    budget: { max_iters: 1, max_cost_usd: 1, deadline: null },
    stop: { tau: 0.01, K: 1, N: 1, mode: 'auto' }
  };
  assert(metricSummary(goal, 812.345, 'tok/s') === 'throughput 812.35tok/s target >=700tok/s', 'Header metric summary should include best metric and target');
  assert(metricSummary(null, undefined, undefined) === 'goal pending', 'Header metric summary should keep the blank-run intake state generic');
  assert(
    metricSummary({ ...goal, metric: { name: 'planner-selected validation', direction: 'maximize', target: null, unit: undefined } }, undefined, undefined) ===
      'validation pending',
    'Header metric summary should not render internal planner-selected validation as a best metric'
  );
  assert(costSummary([{ ...ledgerRow(), cost: { wall_ms: 1000, tokens_input: 200, tokens_output: 300 } }]) === 'cost 500 tok', 'Header cost summary should prefer token cost');
  assert(costSummary([{ ...ledgerRow(), cost: { wall_ms: 1000, usd: 0.125 } }]) === 'cost $0.1250', 'Header cost summary should prefer usd cost');
  assert(elapsedSummary([fakeEvent(1), { ...fakeEvent(2), ts: '2026-06-14T00:02:05.000Z' }]) === 'elapsed 2m5s', 'Header elapsed summary should format event span');
  assert(rollbackSummary(null) === 'rollback pending', 'Header rollback summary should keep blank intake generic');
  assert(rollbackSummary(checkpoint({ best_commit: null })) === 'rollback pending', 'Header rollback summary should not invent a rollback point');
  assert(
    rollbackSummary(checkpoint({ best_commit: '0123456789abcdef0123456789abcdef01234567' })) === 'rollback 0123456',
    'Header rollback summary should expose the current rollback checkpoint'
  );
}

function checkpoint(overrides: Partial<Checkpoint>): Checkpoint {
  return {
    supervisor_state: 'EXECUTE',
    next_step: null,
    iter: 0,
    goal_version: 1,
    plan_hash: null,
    ledger_seq: 0,
    events_seq: 0,
    sessions: {},
    drained_inbox: [],
    updated_at: '2026-06-14T00:00:00.000Z',
    ...overrides
  };
}

function ledgerRow(): LedgerEntry {
  return {
    id: 'iter-1',
    ts: '2026-06-14T00:00:00.000Z',
    iter: 1,
    step_id: 'S1',
    commit: null,
    hypothesis: 'header',
    metric: null,
    baseline: null,
    delta_pct: null,
    confidence: 'header',
    cost: {},
    guards: {},
    status: 'reject',
    reflection: 'header'
  };
}

async function source(name: string): Promise<string> {
  return readFile(join(tuiRoot, name), 'utf8');
}

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    found.push(index);
    index = text.indexOf(needle, index + needle.length);
  }
  return found;
}

function assertNoControlWrites(label: string, text: string): void {
  assertNoFileWriteApis(label, text);
  for (const forbidden of [
    'paths.goal',
    'paths.plan',
    'paths.checkpoint',
    'paths.baseline',
    'paths.ledger',
    'paths.events'
  ]) {
    assert(!text.includes(forbidden), `${label} must not write or directly mutate supervisor-owned control state via ${forbidden}`);
  }
}

function assertNoFileWriteApis(label: string, text: string): void {
  for (const forbidden of ['atomicWriteFile', 'atomicWriteJson', 'appendJsonLine', 'writeFile', 'appendFile']) {
    assert(!text.includes(forbidden), `${label} must not import or call file write API ${forbidden}`);
  }
}

function assertOnlyChatPaneWritesInbox(files: Record<string, string>): void {
  const writers = Object.entries(files)
    .filter(([name]) => ['app', 'chat', 'exec', 'goal', 'header', 'state'].includes(name))
    .filter(([, text]) => text.includes('writeInjection'))
    .map(([name]) => name);
  assert(writers.length === 1 && writers[0] === 'chat', `only ChatPane may write inbox injections, got ${JSON.stringify(writers)}`);
}

function verifyVisibleEvents(): void {
  const events = Array.from({ length: 10 }, (_, index) => fakeEvent(index + 1));
  assert(visibleEvents(events, 0, 4).events.map((event) => event.seq).join(',') === '7,8,9,10', 'tail viewport should show newest events');
  assert(visibleEvents(events, 2, 4).events.map((event) => event.seq).join(',') === '5,6,7,8', 'scrolled viewport should move into history');
  assert(visibleEvents(events, 999, 4).events.map((event) => event.seq).join(',') === '1,2,3,4', 'viewport should clamp at oldest events');
  assert(visibleEvents([], 0, 4).events.length === 0, 'empty viewport should be empty');
}

function verifyExecEventUsage(): void {
  const executor = formatEvent({
    ...fakeEvent(1),
    type: 'EXECUTE_PROGRESS',
    message: 'Codex event turn.completed',
    data: {
      usage: {
        tokens_input: 120,
        tokens_output: 34,
        usd: 0.0123
      }
    }
  });
  assert(executor.includes('tok in=120 out=34 $0.0123'), `ExecPane should render executor token usage: ${executor}`);

  const planner = formatEvent({
    ...fakeEvent(2),
    type: 'PLAN_USAGE',
    message: 'Planner stream update',
    data: {
      usage: {
        total_tokens: 456,
        input_tokens: 12,
        output_tokens: 8
      }
    }
  });
  assert(planner.includes('tok total=456 in=12 out=8'), `ExecPane should render planner token usage: ${planner}`);

  const alreadyFormatted = formatEvent({
    ...fakeEvent(3),
    type: 'PLAN_USAGE',
    message: 'Planner tokens total=456 in=12 out=8',
    data: {
      usage: {
        total_tokens: 456,
        input_tokens: 12,
        output_tokens: 8
      }
    }
  });
  assert(!alreadyFormatted.includes('tok total=456'), `ExecPane should not duplicate token usage already in message: ${alreadyFormatted}`);
}

function verifyCodexDisplayLines(): void {
  const lines = codexDisplayLines([
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hello\nworld' } }),
    JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'ok\n', exit_code: 0 } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }] } }),
    JSON.stringify({ method: 'item/completed', params: { item: { type: 'agentMessage', text: JSON.stringify({ notes: 'bench passed', next: 'write receipt', changed_files: ['PLAN.md'] }) } } })
  ]);
  const text = lines.join('\n');
  assert(text.includes('codex: hello') && text.includes('       world'), `Codex agent text should render like a transcript:\n${text}`);
  assert(text.includes('$ npm test'), `Codex command should render as a shell command:\n${text}`);
  assert(text.includes('ok') && text.includes('exit 0'), `Codex command output and exit code should render directly:\n${text}`);
  assert(text.includes('file update: src/a.ts'), `Codex file changes should render as readable file lines:\n${text}`);
  assert(text.includes('codex: bench passed') && text.includes('next: write receipt') && text.includes('files: PLAN.md'), `Structured Codex messages should render readable fields:\n${text}`);
  assert(!text.includes('"command"') && !text.includes('"method"'), `ExecPane must not dump raw JSON into the visible transcript:\n${text}`);
}

function verifyChatHistory(): void {
  const history = buildChatHistory(
    [
      {
        id: 'out-20260614000100-question',
        ts: '2026-06-14T00:01:00.000Z',
        kind: 'question',
        text: 'Planner needs clarification before producing PLAN.md. Which host?',
        reply_key: 'planner-clarify-v1',
        answered: true,
        answer_text: 'Use the host from the original chat.',
        answered_at: '2026-06-14T00:01:02.000Z'
      }
    ],
    [
      {
        id: 'inj-20260614000000-initial',
        ts: '2026-06-14T00:00:00.000Z',
        kind: 'add_requirement',
        text: 'Keep the public API stable.',
        priority: 'normal',
        applied: true
      },
      {
        id: 'inj-20260614000200-steer',
        ts: '2026-06-14T00:02:00.000Z',
        kind: 'steer',
        text: 'Prefer the smallest safe change.',
        priority: 'normal',
        applied: false
      }
    ],
    {
      run_id: 'run-chat-history',
      version: 1,
      requirements: [{ id: 'R1', text: 'Initial user request from Chat.', source: 'initial', status: 'active' }],
      acceptance_criteria: [],
      constraints: [],
      metric: { name: 'planner-selected validation', direction: 'maximize', target: null, unit: 'score' },
      budget: { max_iters: 1, max_cost_usd: 0, deadline: null },
      stop: { tau: 0.01, K: 1, N: 1, mode: 'auto' }
    },
    [
      { ts: '2026-06-14T00:00:00.000Z', role: 'user', text: 'Please keep the public API stable.' },
      {
        ts: '2026-06-14T00:00:01.000Z',
        role: 'assistant',
        text: 'I will record that requirement.',
        update: { kind: 'add_requirement', text: 'Keep the public API stable.' }
      }
    ]
  );
  const text = history.map((line) => line.text).join('\n');
  assert(!text.includes('initial goal:'), `Chat history should not repeat initial goal:\n${text}`);
  assert(text.includes('YOU\n  Please keep the public API stable.'), `Chat history missing separated user turn:\n${text}`);
  assert(text.includes('ASSISTANT\n  I will record that requirement.'), `Chat history missing separated assistant turn:\n${text}`);
  assert(text.includes('UPDATE APPLIED\n  Keep the public API stable.'), `Chat history missing attached update status:\n${text}`);
  assert(text.includes('QUESTION\n  Planner needs clarification'), `Chat history missing planner question:\n${text}`);
  assert(text.includes('ANSWER\n  Use the host from the original chat.'), `Chat history missing answered text:\n${text}`);
  assert(currentGoalSummary({
    run_id: 'run-chat-history',
    version: 1,
    requirements: [{ id: 'R1', text: 'Initial user request from Chat.', source: 'initial', status: 'active' }],
    acceptance_criteria: [],
    constraints: [],
    metric: { name: 'planner-selected validation', direction: 'maximize', target: null, unit: 'score' },
    budget: { max_iters: 1, max_cost_usd: 0, deadline: null },
    stop: { tau: 0.01, K: 1, N: 1, mode: 'auto' }
  }).startsWith('Current goal v1:'), 'ChatPane should expose compact current goal summary');
}

function fakeEvent(seq: number): RunEvent {
  return {
    seq,
    ts: '2026-06-14T00:00:00.000Z',
    type: `E${seq}`,
    level: 'info',
    message: `event ${seq}`
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
