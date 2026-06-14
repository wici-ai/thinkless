import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TOOL_ROOT } from '../shared/paths.js';
import type { RunEvent } from '../shared/types.js';
import { visibleEvents } from '../tui/ExecPane.js';
import { buildPlanDiffView } from '../tui/GoalPane.js';

const tuiRoot = join(TOOL_ROOT, 'src', 'tui');

async function main(): Promise<void> {
  const files = {
    app: await source('App.tsx'),
    chat: await source('ChatPane.tsx'),
    exec: await source('ExecPane.tsx'),
    goal: await source('GoalPane.tsx'),
    header: await source('Header.tsx'),
    state: await source('useRunState.ts'),
    cli: await readFile(join(TOOL_ROOT, 'src', 'cli.tsx'), 'utf8')
  };

  const staticUses = Object.entries(files)
    .filter(([name]) => ['app', 'chat', 'exec', 'goal', 'header', 'state'].includes(name))
    .flatMap(([name, text]) => occurrences(text, '<Static').map((index) => ({ name, index })));
  assert(staticUses.length === 1, `TUI must have exactly one <Static>, found ${JSON.stringify(staticUses)}`);
  assert(staticUses[0].name === 'exec', `the single <Static> must live in ExecPane, found ${staticUses[0].name}`);
  assert(files.exec.includes('items={stable}'), 'ExecPane Static must render stable finished events');

  assert(files.app.includes('useInput') && files.app.includes('useFocusManager'), 'App must keep keyboard focus management at the top level');
  assert(files.app.includes("focus('chat')") && files.app.includes('key.escape'), 'App must route Escape back to the Chat pane');
  assert(files.app.includes('<ChatPane') && files.app.includes('<GoalPane') && files.app.includes('<ExecPane'), 'App must render the three V1 panes');

  assert(files.chat.includes("useFocus({ id: 'chat'"), 'ChatPane must have a stable focus id');
  assert(files.chat.includes('writeInjection'), 'ChatPane must write chat input through writeInjection');
  assert(files.chat.includes("kind: 'add_requirement'"), 'ChatPane must default text input to add_requirement injections');
  assert(files.chat.includes("kind: 'answer'"), 'ChatPane must support outbox answers');
  assert(files.chat.includes("kind: 'steer'"), 'ChatPane must support steering injections');
  assert(files.chat.includes("kind: 'abort'"), 'ChatPane must support urgent abort injections');
  assertNoControlWrites('ChatPane', files.chat);

  assert(files.goal.includes("useFocus({ id: 'goal'"), 'GoalPane must be focusable for Tab navigation');
  assert(files.goal.includes('buildPlanDiffView'), 'GoalPane must compute a visible PLAN diff');
  assert(files.goal.includes('Δ +'), 'GoalPane must render added/removed PLAN counts');
  assert(files.goal.includes("line.added ? '+ '"), 'GoalPane must mark added PLAN lines');
  assertNoControlWrites('GoalPane', files.goal);

  assert(files.exec.includes("useFocus({ id: 'exec'"), 'ExecPane must be focusable for scroll controls');
  assert(files.exec.includes('useInput') && files.exec.includes('isActive: isFocused'), 'ExecPane input must be gated on focus');
  for (const key of ['upArrow', 'downArrow', 'pageUp', 'pageDown', 'home', 'end']) {
    assert(files.exec.includes(`key.${key}`), `ExecPane missing ${key} scroll binding`);
  }
  assert(files.exec.includes('visibleEvents') && files.exec.includes('scrollOffset'), 'ExecPane must render an in-pane scroll viewport');
  assertNoControlWrites('ExecPane', files.exec);
  assert(!files.goal.includes('writeInjection'), 'GoalPane must not write inbox injections');
  assert(!files.exec.includes('writeInjection'), 'ExecPane must not write inbox injections');

  assert(files.state.includes("import chokidar from 'chokidar'"), 'useRunState must use chokidar for blackboard watching');
  for (const watched of ['paths.events', 'paths.goal', 'paths.checkpoint', 'paths.baseline', 'paths.ledger', 'paths.plan', 'paths.outbox']) {
    assert(files.state.includes(watched), `useRunState watcher missing ${watched}`);
  }
  assert(files.state.includes('setTimeout') && files.state.includes('30'), 'useRunState must coalesce rapid file updates');

  assert(files.cli.includes(".command('tui')"), 'CLI must expose the tui command');
  assert(files.cli.includes(".option('--no-supervisor'"), 'tui command must support read-only/manual launch without supervisor');
  assert(files.cli.includes(".option('--no-fullscreen'"), 'tui command must support non-fullscreen rendering for verification');

  verifyVisibleEvents();
  verifyGoalPlanDiff();

  console.log(
    JSON.stringify(
      {
        ok: true,
        single_static_owner: 'ExecPane',
        esc_focuses_chat: true,
        exec_scroll_viewport: true,
        goal_plan_diff: true,
        chat_writes_only_inbox: true,
        goal_and_exec_read_only: true,
        watcher_covers_blackboard: true
      },
      null,
      2
    )
  );
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
  for (const forbidden of [
    'atomicWriteFile',
    'atomicWriteJson',
    'appendJsonLine',
    'writeFile',
    'appendFile',
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

function verifyVisibleEvents(): void {
  const events = Array.from({ length: 10 }, (_, index) => fakeEvent(index + 1));
  assert(visibleEvents(events, 0, 4).events.map((event) => event.seq).join(',') === '7,8,9,10', 'tail viewport should show newest events');
  assert(visibleEvents(events, 2, 4).events.map((event) => event.seq).join(',') === '5,6,7,8', 'scrolled viewport should move into history');
  assert(visibleEvents(events, 999, 4).events.map((event) => event.seq).join(',') === '1,2,3,4', 'viewport should clamp at oldest events');
  assert(visibleEvents([], 0, 4).events.length === 0, 'empty viewport should be empty');
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
