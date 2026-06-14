import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import { readOutbox } from '../supervisor/outbox.js';
import type { OutboxMessage } from '../shared/types.js';

const target = resolve('fixture/outbox-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);

  const result = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Write stop reason to outbox', '--max-iters', '1', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(result.exitCode === 0, `outbox verifier supervisor run failed:\n${result.all}`);

  const messages = await readOutbox(paths, 10);
  assert(messages.some((message) => message.kind === 'info' && message.text === 'Reached max_iters=1'), `missing max_iters outbox message: ${format(messages)}`);

  const rawEvents = await readFile(paths.events, 'utf8');
  assert(rawEvents.includes('Reached max_iters=1'), 'events log missing max_iters stop event');

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after outbox run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        outbox_messages: messages.length,
        stop_message_written: true
      },
      null,
      2
    )
  );
}

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function format(messages: OutboxMessage[]): string {
  return JSON.stringify(messages.map((message) => ({ kind: message.kind, text: message.text })));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
