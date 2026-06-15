import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TOOL_ROOT } from '../shared/paths.js';
import type { Checkpoint, GoalFile, LedgerEntry, RunEvent } from '../shared/types.js';
import { buildChatHistory } from '../tui/ChatPane.js';
import { codexDisplayLines, formatEvent, visibleEvents } from '../tui/ExecPane.js';
import { buildPlanDiffView } from '../tui/GoalPane.js';
import { costSummary, elapsedSummary, metricSummary, rollbackSummary } from '../tui/Header.js';
import { mouseScrollDelta } from '../tui/input.js';
import { viewport, wrapLines } from '../tui/viewport.js';
import { summarizePlanForChat } from '../supervisor/chatAgent.js';

const tuiRoot = join(TOOL_ROOT, 'src', 'tui');

async function main(): Promise<void> {
  const files = {
    app: await source('App.tsx'),
    chat: await source('ChatPane.tsx'),
    exec: await source('ExecPane.tsx'),
    goal: await source('GoalPane.tsx'),
    header: await source('Header.tsx'),
    input: await source('input.ts'),
    state: await source('useRunState.ts'),
    cli: await readFile(join(TOOL_ROOT, 'src', 'cli.tsx'), 'utf8')
  };

  const staticUses = Object.entries(files)
    .filter(([name]) => ['app', 'chat', 'exec', 'goal', 'header', 'state'].includes(name))
    .flatMap(([name, text]) => occurrences(text, '<Static').map((index) => ({ name, index })));
  assert(staticUses.length === 0, `TUI panes must use scrollable viewports instead of Static regions, found ${JSON.stringify(staticUses)}`);

  assert(files.app.includes('useInput') && files.app.includes('useFocusManager'), 'App must keep keyboard focus management at the top level');
  assert(files.app.includes('enableMouseReporting'), 'App must enable terminal mouse reporting for pane-local wheel scroll');
  assert(files.app.includes("focus('chat')") && files.app.includes('key.escape'), 'App must route Escape back to the Chat pane');
  assert(files.app.includes('<ChatPane') && files.app.includes('<GoalPane') && files.app.includes('<ExecPane'), 'App must render the three V1 panes');
  assert(files.app.includes('shouldAcceptInitialGoalFromChat'), 'App must route blank-run chat input to the initial supervisor goal');
  assert(files.app.includes('shouldAutoStartExistingRun'), 'App must avoid auto-restarting stopped runs while still supporting resume on attach');
  assert(files.app.includes('onInjection={() => launchSupervisor(undefined)}'), 'App must wake the supervisor after Chat writes an inbox injection');
  assert(files.app.includes("launchSupervisor(supervisor.initialGoal, 'tui_goal_option')"), 'App must keep --goal as an explicit automation shortcut');
  assert(files.app.includes("launchSupervisor(goal, 'tui_chat')"), 'App must mark blank-run Chat intake as TUI Chat source');
  assert(files.app.includes('goal={state.goal}'), 'App must pass durable goal state into Chat history');
  assertNoControlWrites('App', files.app);

  assert(files.chat.includes("useFocus({ id: 'chat'"), 'ChatPane must have a stable focus id');
  assert(files.chat.includes('isActive: interactive && isFocused'), 'ChatPane input and scroll must be gated on focus');
  assert(files.chat.includes('writeInjection'), 'ChatPane must write chat input through writeInjection');
  assert(files.chat.includes('buildChatHistory'), 'ChatPane must render persisted chat history');
  assert(files.chat.includes('viewport(') && files.chat.includes('wrapLines'), 'ChatPane must render full wrapped content through a scroll viewport');
  assert(files.chat.includes('mouseScrollDelta'), 'ChatPane must support pane-local mouse wheel scroll');
  assert(files.chat.includes('acceptInitialGoal') && files.chat.includes('onInitialGoal'), 'ChatPane must support initial goal intake before inbox injections');
  assert(files.chat.includes('onInjection?.()'), 'ChatPane must notify App after writing inbox injections');
  assert(files.chat.includes('isInitialGoalText'), 'ChatPane must distinguish initial natural-language goals from slash commands');
  assert(files.chat.includes("input.includes('\\r')") && files.chat.includes("input.includes('\\n')"), 'ChatPane must submit PTY input chunks that include a trailing newline');
  assert(files.chat.includes("kind: 'add_requirement'"), 'ChatPane must default text input to add_requirement injections');
  assert(files.chat.includes("kind: 'answer'"), 'ChatPane must support outbox answers');
  assert(files.chat.includes('latestQuestion') && files.chat.includes('planner-clarify-'), 'ChatPane must route open planner questions through answer injections');
  assert(files.chat.includes("kind: 'steer'"), 'ChatPane must support steering injections');
  assert(files.chat.includes("kind: 'abort'"), 'ChatPane must support urgent abort injections');
  assertNoControlWrites('ChatPane', files.chat);
  assert(!files.chat.includes("? `${") && !files.chat.includes("...'"), 'ChatPane must not intentionally ellipsize content');

  assert(files.goal.includes("useFocus({ id: 'goal'"), 'GoalPane must be focusable for Tab navigation');
  assert(files.goal.includes('useInput') && files.goal.includes('isActive: isFocused'), 'GoalPane scroll input must be gated on focus');
  assert(files.goal.includes('state.goalDoc'), 'GoalPane must render the user-facing GOAL.md document');
  assert(!files.goal.includes('goal?.requirements'), 'GoalPane must not use internal goal.json requirements as the primary goal UI');
  assert(files.goal.includes('buildPlanDiffView'), 'GoalPane must compute a visible PLAN diff');
  assert(files.goal.includes('GOAL / PLAN'), 'GoalPane title must be English');
  assert(files.goal.includes('viewport(') && files.goal.includes('wrapLines'), 'GoalPane must render full GOAL.md and PLAN.md through a scroll viewport');
  assert(files.goal.includes('mouseScrollDelta') && files.goal.includes("input === 'k'"), 'GoalPane must support wheel and vim-style scroll keys');
  assertNoControlWrites('GoalPane', files.goal);
  assert(!files.goal.includes("? `${") && !files.goal.includes("...'"), 'GoalPane must not intentionally ellipsize content');

  assert(files.exec.includes("useFocus({ id: 'exec'"), 'ExecPane must be focusable for scroll controls');
  assert(files.exec.includes('useInput') && files.exec.includes('isActive: isFocused'), 'ExecPane input must be gated on focus');
  for (const key of ['upArrow', 'downArrow', 'pageUp', 'pageDown', 'home', 'end']) {
    assert(files.exec.includes(`key.${key}`), `ExecPane missing ${key} scroll binding`);
  }
  assert(files.exec.includes('visibleEvents') && files.exec.includes('scrollOffset'), 'ExecPane must render an in-pane scroll viewport');
  assert(files.exec.includes('mouseScrollDelta') && files.exec.includes("input === 'k'"), 'ExecPane must support wheel and vim-style scroll keys');
  assert(files.exec.includes('codexDisplayLines') && files.exec.includes('state.codexTranscript'), 'ExecPane must render Codex transcript text fields');
  assert(files.exec.includes('EXECUTION'), 'ExecPane title must be English');
  assertNoControlWrites('ExecPane', files.exec);
  assert(!files.goal.includes('writeInjection'), 'GoalPane must not write inbox injections');
  assert(!files.exec.includes('writeInjection'), 'ExecPane must not write inbox injections');

  assert(files.header.includes('metricSummary'), 'Header must show planner-selected validation only after a goal exists');
  assert(files.header.includes('rollbackSummary'), 'Header must show git rollback/checkpoint status');
  assert(files.header.includes('costSummary'), 'Header must show cumulative run cost');
  assert(files.header.includes('elapsedSummary'), 'Header must show elapsed run time');

  assert(files.state.includes("import chokidar from 'chokidar'"), 'useRunState must use chokidar for blackboard watching');
  for (const watched of ['paths.events', 'paths.codexRun', 'paths.goal', 'paths.goalDoc', 'paths.checkpoint', 'paths.baseline', 'paths.ledger', 'paths.plan', 'paths.outbox']) {
    assert(files.state.includes(watched), `useRunState watcher missing ${watched}`);
  }
  assert(files.state.includes('paths.inbox') && files.state.includes('paths.inboxDone'), 'useRunState watcher must include persisted Chat inbox history');
  assert(files.state.includes('readInjectionHistory'), 'useRunState must read persisted Chat injection history');
  assert(files.state.includes('setTimeout') && files.state.includes('30'), 'useRunState must coalesce rapid file updates');
  assertNoFileWriteApis('useRunState', files.state);
  assertOnlyChatPaneWritesInbox(files);

  assert(files.cli.includes(".command('tui')"), 'CLI must expose the tui command');
  assert(files.cli.includes(".option('--no-supervisor'"), 'tui command must support read-only/manual launch without supervisor');
  assert(files.cli.includes(".option('--no-fullscreen'"), 'tui command must support non-fullscreen rendering for verification');
  assert(files.cli.includes('initialGoal: options.goal'), 'tui --goal must be explicit automation input, not an implicit default goal');

  verifyVisibleEvents();
  verifyTextViewport();
  verifyMouseScroll();
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
}

function verifyMouseScroll(): void {
  assert(mouseScrollDelta('\x1b[<64;20;10M') === 1, 'mouse wheel up should scroll into pane history');
  assert(mouseScrollDelta('\x1b[<65;20;10M') === -1, 'mouse wheel down should scroll toward pane tail');
  assert(mouseScrollDelta('k') === 0, 'ordinary keyboard input must not parse as mouse scroll');
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
    JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }] } })
  ]);
  const text = lines.join('\n');
  assert(text.includes('hello') && text.includes('world'), `Codex agent text should render directly:\n${text}`);
  assert(text.includes('[command] npm test'), `Codex command should render directly:\n${text}`);
  assert(text.includes('ok'), `Codex command output should render directly:\n${text}`);
  assert(text.includes('[file update] src/a.ts'), `Codex file changes should render directly:\n${text}`);
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
    }
  );
  const text = history.map((line) => line.text).join('\n');
  assert(text.includes('initial goal: Initial user request from Chat.'), `Chat history missing initial Chat goal:\n${text}`);
  assert(text.includes('requirement applied: Keep the public API stable.'), `Chat history missing applied requirement:\n${text}`);
  assert(text.includes('planner: Planner needs clarification'), `Chat history missing planner question:\n${text}`);
  assert(text.includes('answer: Use the host from the original chat.'), `Chat history missing answered text:\n${text}`);
  assert(text.includes('steer pending: Prefer the smallest safe change.'), `Chat history missing pending steer:\n${text}`);
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
