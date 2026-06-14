import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import type { BaselineFile, LedgerEntry, RunEvent } from '../shared/types.js';

const target = resolve('fixture/heldout-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  await writePublicAndHeldoutMetrics();

  const result = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Reject public-only metric gaming with held-out validation', '--max-iters', '1', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(result.exitCode === 0, `heldout verifier supervisor run failed:\n${result.all}`);

  const baseline = JSON.parse(await readFile(paths.baseline, 'utf8')) as BaselineFile;
  assert(Boolean(baseline.eval_sha256.validate), `baseline did not pin validate.sh: ${JSON.stringify(baseline.eval_sha256)}`);
  assert(baseline.heldout_metric?.p99 === 100, `unexpected baseline heldout metric: ${JSON.stringify(baseline.heldout_metric)}`);

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 1, `expected one ledger row, got ${ledger.length}`);
  assert(ledger[0].status === 'reject', `expected heldout regression reject, got ${ledger[0].status}`);
  assert(ledger[0].confidence === 'heldout-regression', `expected heldout-regression confidence, got ${ledger[0].confidence}`);
  assert(ledger[0].guards.heldout_p99 === 150, `ledger missing heldout p99: ${JSON.stringify(ledger[0].guards)}`);
  assert((ledger[0].guards.heldout_delta_pct as number) < 0, `ledger missing negative heldout delta: ${JSON.stringify(ledger[0].guards)}`);

  const perfCommits = await git(['log', '--oneline', '--grep', '^perf:']);
  assert(perfCommits.trim() === '', `heldout regression produced perf commit:\n${perfCommits}`);

  const prompt = await readFile(`${paths.artifacts}/iter-1.prompt.txt`, 'utf8');
  assert(!/held[- ]?out/i.test(prompt), `executor prompt leaked heldout wording:\n${prompt}`);
  assert(!/validate\.sh/i.test(prompt), `executor prompt leaked validate.sh:\n${prompt}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  const revert = events.find((event) => event.type === 'REVERT');
  assert(revert, 'missing REVERT event for heldout regression');
  assert(revert.message.includes('held-out validation'), `REVERT event missing heldout reason: ${JSON.stringify(revert)}`);
  const revertData = revert.data as { heldout_p99?: number; heldout_delta_pct?: number } | undefined;
  assert(revertData?.heldout_p99 === 150, `REVERT event missing heldout p99: ${JSON.stringify(revert.data)}`);
  assert((revertData.heldout_delta_pct ?? 0) < 0, `REVERT event missing negative heldout delta: ${JSON.stringify(revert.data)}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after heldout run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        validate_pinned: true,
        heldout_p99: ledger[0].guards.heldout_p99,
        rejected_public_only_improvement: true,
        prompt_hidden: true
      },
      null,
      2
    )
  );
}

async function writePublicAndHeldoutMetrics(): Promise<void> {
  await writeFile(
    `${target}/measure.mjs`,
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
  await writeFile(
    `${target}/heldout.mjs`,
    `import { readFileSync } from 'node:fs';

const source = readFileSync('./src/hotpath.js', 'utf8');
const optimized = source.includes('new Set');
const samples = optimized ? [150, 150, 150, 150, 150, 150, 150] : [100, 100, 100, 100, 100, 100, 100];
const p50 = samples[3];
const p95 = samples[6];
const p99 = samples[6];
console.log(\`METRIC p50=\${p50} p95=\${p95} p99=\${p99} unit=ms n=\${samples.length} warmup_discarded=2 samples=\${samples.join(',')}\`);
`
  );
  await mkdir(dirname(`${target}/.opt/validate.sh`), { recursive: true });
  await writeFile(
    `${target}/.opt/validate.sh`,
    `#!/usr/bin/env bash
set -euo pipefail
node heldout.mjs
`
  );
  await chmod(`${target}/.opt/validate.sh`, 0o755);
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
