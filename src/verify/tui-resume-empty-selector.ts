import { access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';

const target = resolve('fixture/tui-resume-empty-selector-target');
const home = resolve('fixture/tui-resume-empty-selector-home');
const builtCli = resolve('dist/src/cli.js');

async function main(): Promise<void> {
  await requireExpect();
  await rm(target, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  await createSampleTarget(target, true);

  const result = await execa('expect', ['-c', emptySelectorExpectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      HOME: home,
      TERM: 'xterm-256color',
      WICI_PTY_TARGET: target,
      WICI_THINKLESS_BIN: builtCli
    },
    reject: false,
    all: true,
    timeout: 35_000,
    maxBuffer: 1024 * 1024 * 5
  });
  const output = stripAnsi(result.all ?? '');
  assert(result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143, `empty resume selector PTY failed with code ${result.exitCode}:\n${output}`);
  assert(output.includes('No resumable Thinkless runs found.'), `empty resume selector did not show explicit empty state:\n${output}`);
  assert(!output.includes('Scanning for resumable Thinkless runs...'), `empty resume selector stayed on loading text after scan:\n${output}`);
  assert(!output.includes('QUEUED COMMAND'), `empty resume selector should not render a queued command block:\n${output}`);
  assert(!output.includes('SUPERVISOR_START'), `empty selector should not print supervisor launch evidence:\n${output}`);
  assert(!(await exists(join(target, '.thinkless', 'events.jsonl'))), 'empty selector should not create current-session events');
  assert(!(await exists(join(target, '.thinkless2', 'events.jsonl'))), 'empty selector should not create numbered-session events');
  assert(!(await exists(join(target, '.wici', 'events.jsonl'))), 'empty selector should not create legacy-session events');

  console.log(JSON.stringify({ ok: true, target, home, emptyStateVisible: true, noLaunch: true }, null, 2));
}

function emptySelectorExpectScript(): string {
  return `
log_user 1
set timeout 25
spawn "$env(WICI_THINKLESS_BIN)" tui --target "$env(WICI_PTY_TARGET)" --max-iters 0 --mode stub --no-fullscreen
expect "CHAT"
send -- "/resume\\r"
expect "No resumable Thinkless runs found."
send -- "\\033\\[B"
sleep 1
send -- "\\033\\[A"
sleep 1
send -- "\\n"
sleep 1
send -- "\\033"
sleep 1
send -- "\\003"
expect eof
exit 0
`;
}

async function requireExpect(): Promise<void> {
  const found = await execa('command', ['-v', 'expect'], { shell: true, reject: false });
  assert(found.exitCode === 0, 'verify:tui-resume-empty-selector requires expect on PATH');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
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
