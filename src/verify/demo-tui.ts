import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { exists } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';

const target = resolve('fixture/demo-tui-target');

async function main(): Promise<void> {
  const bareOutput = await runBareThinkless();
  const bareUi = stripAnsi(bareOutput);
  assert(bareUi.includes('Thinkless') && bareUi.includes('CHAT') && bareUi.includes('PLAN') && bareUi.includes('EXECUTION'), `bare thinkless command did not render the TUI:\n${bareUi}`);
  assert(!/required option|missing required|Usage:/i.test(bareUi), `bare thinkless command should not require a subcommand or --target:\n${bareUi}`);

  const output = await runDemo(['--fresh']);

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

  await mkdir(paths.wici, { recursive: true });
  await writeFile(
    paths.chatSession,
    `${JSON.stringify(
      {
        sessions: { codex: { session_id: 'preserve-demo-session', updated_at: '2026-06-18T00:00:00.000Z' } }
      },
      null,
      2
    )}\n`
  );
  await writeFile(paths.runtimeSelection, `${JSON.stringify({ chat: { agent: 'codex', model: 'gpt-5.5', effort: 'high' } }, null, 2)}\n`);
  const reopenedOutput = await runDemo([]);
  const session = await readFile(paths.chatSession, 'utf8');
  assert(session.includes('preserve-demo-session'), 'demo without --fresh must preserve existing .wici chat session context');
  const reopenedUi = stripAnsi(reopenedOutput);
  assert(reopenedUi.includes('CHAT agent=codex') && reopenedUi.includes('effort=high') && reopenedUi.includes('model=gpt-5.5'), `demo without --fresh must restore persisted Chat runtime:\n${reopenedUi}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        demo_created_target: true,
        bare_command_opens_tui: true,
        chat_first_no_blackboard_writes: true,
        rendered_switchable_workspace: true,
        non_fresh_preserves_chat_session: true,
        non_fresh_restores_chat_runtime: true
      },
      null,
      2
    )
  );
}

async function runBareThinkless(): Promise<string> {
  return runCli([]);
}

async function runDemo(extraArgs: string[]): Promise<string> {
  return runCli(['demo', '--target', target, ...extraArgs, '--max-iters', '1', '--mode', 'stub', '--no-fullscreen']);
}

async function runCli(args: string[]): Promise<string> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', ...args],
    {
      cwd: resolve('.'),
      env: { ...process.env, FORCE_COLOR: '0', TERM: 'xterm-256color', WICI_TUI_RENDER_ONCE: '1', WICI_TUI_RENDER_ONCE_DELAY_MS: '700' },
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

  await waitForExit(child, 5000);
  await stopChild(child);
  return output;
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

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    delay(timeoutMs).then(() => undefined)
  ]);
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
