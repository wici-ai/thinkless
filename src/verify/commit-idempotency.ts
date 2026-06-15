import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import type { BaselineFile, Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';

const target = resolve('fixture/commit-idempotency-target');
process.env.WICI_LEGACY_OPTIMIZER = '1';

async function main(): Promise<void> {
  await createSampleTarget(target, true);

  const first = spawn(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Recover idempotently after commit crash', '--max-iters', '1', '--mode', 'stub'], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      WICI_PAUSE_AFTER_EVENT: 'GIT_COMMIT:10000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const firstCommitEvent = await waitForEvent(join(target, '.wici', 'events.jsonl'), 'GIT_COMMIT', 15_000);
  const firstCommit = (firstCommitEvent.data as { commit?: string } | undefined)?.commit;
  const key = (firstCommitEvent.data as { key?: string } | undefined)?.key;
  assert(firstCommit, `GIT_COMMIT event missing commit: ${JSON.stringify(firstCommitEvent)}`);
  assert(key, `GIT_COMMIT event missing key: ${JSON.stringify(firstCommitEvent)}`);
  first.kill('SIGKILL');
  await waitForExit(first);

  const checkpointAfterKill = JSON.parse(await readFile(join(target, '.wici', 'checkpoint.json'), 'utf8')) as Checkpoint;
  assert(checkpointAfterKill.supervisor_state === 'COMMIT', `expected checkpoint state COMMIT after kill, got ${checkpointAfterKill.supervisor_state}`);
  assert(checkpointAfterKill.ledger_seq === 0, `expected no checkpointed ledger rows after kill, got ${checkpointAfterKill.ledger_seq}`);
  assert((await perfCommitCount()) === 1, 'expected exactly one perf commit immediately after killed commit window');

  const second = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Recover idempotently after commit crash', '--max-iters', '1', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(second.exitCode === 0, `resume after commit crash failed:\n${second.all}`);

  const ledger = await readJsonLines<LedgerEntry>(join(target, 'ledger.jsonl'));
  assert(ledger.length === 1, `expected exactly one ledger row after recovery, got ${ledger.length}`);
  assert(ledger[0].status === 'keep', `expected keep ledger row, got ${ledger[0].status}`);
  assert(ledger[0].commit === firstCommit, `ledger commit ${ledger[0].commit} did not reuse first commit ${firstCommit}`);
  assert((await perfCommitCount()) === 1, 'idempotent recovery created a duplicate perf commit');

  const events = await readJsonLines<RunEvent>(join(target, '.wici', 'events.jsonl'));
  const reused = events.find((event) => event.type === 'GIT_COMMIT' && (event.data as { reused?: boolean; key?: string } | undefined)?.reused === true);
  assert(reused, `missing reused GIT_COMMIT event after recovery: ${JSON.stringify(events.filter((event) => event.type === 'GIT_COMMIT'))}`);
  assert((reused.data as { key?: string }).key === key, 'reused commit event used a different idempotency key');

  const baseline = JSON.parse(await readFile(join(target, 'baseline.json'), 'utf8')) as BaselineFile;
  assert(baseline.best_commit === firstCommit, `baseline best_commit ${baseline.best_commit} did not reuse first commit ${firstCommit}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after idempotent recovery:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        commit: firstCommit,
        idempotency_key: key,
        ledger_rows: ledger.length,
        perf_commits: await perfCommitCount(),
        reused: true
      },
      null,
      2
    )
  );
}

async function waitForEvent(path: string, type: string, timeoutMs: number): Promise<RunEvent> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const events = await readJsonLines<RunEvent>(path).catch(() => []);
    const event = events.find((item) => item.type === type);
    if (event) return event;
    await delay(100);
  }
  throw new Error(`Timed out waiting for event ${type}`);
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function perfCommitCount(): Promise<number> {
  const commits = await git(['log', '--oneline', '--grep', '^perf:']);
  return commits.split('\n').filter(Boolean).length;
}

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
