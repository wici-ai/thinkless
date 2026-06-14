import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TOOL_ROOT } from '../shared/paths.js';

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
  assert(files.app.includes('<ChatPane') && files.app.includes('<GoalPane') && files.app.includes('<ExecPane'), 'App must render the three V1 panes');

  assert(files.chat.includes('writeInjection'), 'ChatPane must write chat input through writeInjection');
  assert(files.chat.includes("kind: 'add_requirement'"), 'ChatPane must default text input to add_requirement injections');
  assert(files.chat.includes("kind: 'answer'"), 'ChatPane must support outbox answers');
  assert(files.chat.includes("kind: 'steer'"), 'ChatPane must support steering injections');
  assert(files.chat.includes("kind: 'abort'"), 'ChatPane must support urgent abort injections');
  assertNoControlWrites('ChatPane', files.chat);

  assertNoControlWrites('GoalPane', files.goal);
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

  console.log(
    JSON.stringify(
      {
        ok: true,
        single_static_owner: 'ExecPane',
        chat_writes_only_inbox: true,
        goal_and_exec_read_only: true,
        watcher_covers_blackboard: true
      },
      null,
      2
    )
  );
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
