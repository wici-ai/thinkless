import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';

const target = resolve('fixture/tui-live-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure(target);
  await git(['add', 'measure.mjs']);
  await git(['commit', '-m', 'test: make tui live measure deterministic']);
  const paths = runPaths(target);

  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/cli.tsx',
      'tui',
      '--target',
      target,
      '--goal',
      'Run the live TUI over one accepted optimization',
      '--max-iters',
      '1',
      '--mode',
      'stub',
      '--no-fullscreen'
    ],
    {
      cwd: resolve('.'),
      env: { ...process.env, FORCE_COLOR: '0', TERM: 'xterm-256color' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  try {
    await waitForEvent(paths.events, 'STOP', 20_000);
    await delay(500);
  } finally {
    await stopChild(child);
  }

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'SUPERVISOR_START'), 'live TUI supervisor did not start');
  assert(events.some((event) => event.type === 'EXECUTE_START'), 'live TUI did not show an execution start event');
  assert(events.some((event) => event.type === 'EXECUTE_DONE' && (event.data as { mode?: string } | undefined)?.mode === 'direct'), 'live TUI did not show direct execution completion');
  assert(events.some((event) => event.type === 'GIT_COMMIT' && (event.data as { mode?: string } | undefined)?.mode === 'direct'), 'live TUI did not create a direct execution checkpoint');
  assert(events.some((event) => event.type === 'STOP' && event.message === 'Reached max_iters=1'), 'live TUI did not stop at max_iters=1');

  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(checkpoint.supervisor_state === 'STOP', `expected STOP checkpoint, got ${checkpoint.supervisor_state}`);
  assert(checkpoint.iter === 1, `expected one live TUI iteration, got ${checkpoint.iter}`);
  assert(checkpoint.goal_source === 'tui_goal_option', `TUI --goal shortcut should not be recorded as Chat-first source: ${checkpoint.goal_source}`);

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 1, `expected one live TUI ledger row, got ${ledger.length}`);
  assert(ledger[0].status === 'keep', `expected accepted live TUI row, got ${ledger[0].status}`);

  const ui = stripAnsi(output);
  assert(ui.includes('SUPERVISOR_START') && ui.includes('EXECUTE_START') && ui.includes('EXECUTE_DONE'), `live TUI output missing direct execution stream:\n${ui.slice(-5000)}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `live TUI target worktree dirty:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        events: events.length,
        ledger_rows: ledger.length,
        rendered_live_stream: true,
        direct_execution_stream: true,
        goal_source: checkpoint.goal_source,
        stopped: checkpoint.supervisor_state
      },
      null,
      2
    )
  );
}

async function writeDeterministicMeasure(root: string): Promise<void> {
  await writeFile(
    `${root}/measure.mjs`,
    `import { readFileSync } from 'node:fs';

const source = readFileSync('./src/hotpath.js', 'utf8');
const optimized = source.includes('new Set');
const samples = optimized ? [10, 10, 10, 10, 10, 10, 10] : [100, 100, 100, 100, 100, 100, 100];
const p50 = samples[3];
const p95 = samples[6];
const p99 = samples[6];
console.log(\`METRIC p50=\${p50} p95=\${p95} p99=\${p99} unit=ms n=\${samples.length} warmup_discarded=2 samples=\${samples.join(',')}\`);
`
  );
}

async function waitForEvent(path: string, type: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const events = await readJsonLines<RunEvent>(path).catch(() => []);
    if (events.some((event) => event.type === type)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for event ${type}`);
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    delay(1000).then(() => false)
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B[=>]/g, '');
}

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
