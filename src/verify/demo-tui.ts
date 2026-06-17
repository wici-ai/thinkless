import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { exists } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';

const target = resolve('fixture/demo-tui-target');

async function main(): Promise<void> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'demo', '--target', target, '--fresh', '--max-iters', '1', '--mode', 'stub', '--no-fullscreen'],
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

  await delay(1000);
  await stopChild(child);

  const paths = runPaths(target);
  assert(await exists(`${target}/package.json`), 'demo command did not create the sample target package.json');
  assert((await readFile(`${target}/src/hotpath.js`, 'utf8')).includes('uniqueSorted'), 'demo command did not create the sample hot path');
  assert(!(await exists(paths.goal)), 'fresh demo TUI must not write .wici/goal.json before Chat intake');
  assert(!(await exists(paths.goalDoc)), 'fresh demo TUI must not write GOAL.md before Chat intake');
  assert(!(await exists(paths.plan)), 'fresh demo TUI must not write PLAN.md before Chat intake');
  assert(!(await exists(paths.checkpoint)), 'fresh demo TUI must not write checkpoint.json before Chat intake');
  assert(!(await exists(paths.events)), 'fresh demo TUI must not write events.jsonl before Chat intake');

  const ui = stripAnsi(output);
  assert(ui.includes('Thinkless') && ui.includes('CHAT') && ui.includes('PLAN') && ui.includes('EXECUTION'), `demo TUI did not render the Chat plus switchable workspace layout:\n${ui}`);
  assert(!ui.includes('Reduce p99 latency while preserving correctness'), 'demo TUI must not seed the old default goal');
  assert(!ui.includes('SUPERVISOR_START'), 'demo TUI must not start the supervisor before Chat intake');

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        demo_created_target: true,
        chat_first_no_blackboard_writes: true,
        rendered_switchable_workspace: true
      },
      null,
      2
    )
  );
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
