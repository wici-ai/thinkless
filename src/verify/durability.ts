import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { exists } from '../shared/atomic.js';
import type { Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';

const target = resolve('fixture/resume-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure(target);
  await git(['add', 'measure.mjs']);
  await git(['commit', '-m', 'test: make direct durability measure deterministic']);
  const goal = 'Recover a direct V1 PLAN.md execution after a supervisor crash';

  const first = spawn(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', goal, '--max-iters', '1', '--mode', 'stub'], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      WICI_PAUSE_AFTER_EVENT: 'EXECUTE_DONE:10000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  await waitForEvent(join(target, '.wici', 'events.jsonl'), 'EXECUTE_DONE', 15_000);
  first.kill('SIGKILL');
  await waitForExit(first);

  const killedStatus = await git(['status', '--short']);
  assert(killedStatus.includes('src/hotpath.js') || killedStatus.includes('PLAN.md'), `expected unconfirmed dirty state after kill, got: ${killedStatus}`);

  const second = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', goal, '--max-iters', '1', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(second.exitCode === 0, `resume run failed:\n${second.all}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree is dirty after resume:\n${status}`);

  const ledger = await readJsonLines<LedgerEntry>(join(target, 'ledger.jsonl'));
  assert(ledger.length === 1, `expected exactly one ledger row, got ${ledger.length}`);
  assert(ledger[0].status === 'keep', `expected keep ledger row, got ${ledger[0].status}`);
  assert(ledger[0].guards.direct === true, `expected direct V1 ledger row, got ${JSON.stringify(ledger[0])}`);

  assert(!(await exists(join(target, 'baseline.json'))), 'direct V1 durability should not create baseline.json');

  const events = await readJsonLines<RunEvent>(join(target, '.wici', 'events.jsonl'));
  assert(
    events.some((event) => event.type === 'RECOVER_REVERT' && (event.data as { mode?: string } | undefined)?.mode === 'direct'),
    'expected direct RECOVER_REVERT event after restart'
  );
  assert(!events.some((event) => event.type === 'BASELINE_START'), 'direct V1 durability must not initialize baseline before recovery');
  assert(!events.some((event) => event.type === 'EVALUATE_START'), 'direct V1 durability must not run evaluator gate before recovery');

  const checkpoint = JSON.parse(await readFile(join(target, '.wici', 'checkpoint.json'), 'utf8')) as Checkpoint;
  assert(checkpoint.iter === 1, `expected checkpoint iter=1, got ${checkpoint.iter}`);
  assert(checkpoint.ledger_seq === 1, `expected checkpoint ledger_seq=1, got ${checkpoint.ledger_seq}`);
  assert(checkpoint.supervisor_state === 'STOP', `expected STOP checkpoint after resumed direct run, got ${checkpoint.supervisor_state}`);

  const plan = await readFile(join(target, 'PLAN.md'), 'utf8');
  assert(plan.includes('- [x] S1') || plan.includes('status:done'), `expected resumed direct run to complete S1:\n${plan}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        ledger_rows: ledger.length,
        direct_recovered: true,
        baseline_created: false
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

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
