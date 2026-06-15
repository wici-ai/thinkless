import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import type { BaselineFile, LedgerEntry, RunEvent } from '../shared/types.js';

const target = resolve('fixture/prescreen-target');
process.env.WICI_LEGACY_OPTIMIZER = '1';

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  await writeCascadeMetrics();

  const result = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Skip full measure when cascade pre-screen rejects', '--max-iters', '1', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(result.exitCode === 0, `prescreen verifier supervisor run failed:\n${result.all}`);

  const baseline = JSON.parse(await readFile(paths.baseline, 'utf8')) as BaselineFile;
  assert(Boolean(baseline.eval_sha256.prescreen), `baseline did not pin prescreen.sh: ${JSON.stringify(baseline.eval_sha256)}`);

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 1, `expected one ledger row, got ${ledger.length}`);
  assert(ledger[0].status === 'reject', `expected prescreen reject, got ${ledger[0].status}`);
  assert(ledger[0].confidence === 'prescreen-reject', `expected prescreen-reject confidence, got ${ledger[0].confidence}`);
  assert(ledger[0].metric === null, `full measure unexpectedly populated ledger metric: ${JSON.stringify(ledger[0].metric)}`);
  assert(ledger[0].guards.prescreen_value === 120, `ledger missing prescreen value: ${JSON.stringify(ledger[0].guards)}`);
  assert((ledger[0].guards.prescreen_delta_pct as number) < 0, `ledger missing negative prescreen delta: ${JSON.stringify(ledger[0].guards)}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  const revert = events.find((event) => event.type === 'REVERT');
  assert(revert, 'missing REVERT event for prescreen reject');
  assert(revert.message.includes('cascade pre-screen rejected'), `REVERT event missing prescreen reason: ${JSON.stringify(revert)}`);
  const data = revert.data as { prescreen_value?: number; prescreen_delta_pct?: number } | undefined;
  assert(data?.prescreen_value === 120, `REVERT event missing prescreen value: ${JSON.stringify(revert.data)}`);
  assert((data.prescreen_delta_pct ?? 0) < 0, `REVERT event missing negative prescreen delta: ${JSON.stringify(revert.data)}`);

  const fullMeasureMarker = await readFile(`${target}/full-measure-ran.txt`, 'utf8').catch(() => '');
  assert(fullMeasureMarker.trim() === 'baseline', `full measure ran after pre-screen reject: ${fullMeasureMarker}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after prescreen run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        prescreen_pinned: true,
        rejected_before_full_measure: true,
        prescreen_value: ledger[0].guards.prescreen_value
      },
      null,
      2
    )
  );
}

async function writeCascadeMetrics(): Promise<void> {
  await writeFile(
    `${target}/measure.mjs`,
    `import { readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync('./src/hotpath.js', 'utf8');
if (source.includes('new Set')) {
  writeFileSync('./full-measure-ran.txt', 'candidate');
  throw new Error('full measure should be skipped after pre-screen rejection');
}
writeFileSync('./full-measure-ran.txt', 'baseline');
const samples = [100, 100, 100, 100, 100, 100, 100];
const p50 = samples[3];
const p95 = samples[6];
const p99 = samples[6];
console.log(\`METRIC p50=\${p50} p95=\${p95} p99=\${p99} unit=ms n=\${samples.length} warmup_discarded=2 samples=\${samples.join(',')}\`);
`
  );
  await writeFile(
    `${target}/prescreen.mjs`,
    `import { readFileSync } from 'node:fs';

const source = readFileSync('./src/hotpath.js', 'utf8');
const samples = source.includes('new Set') ? [120] : [100];
const p50 = samples[0];
const p95 = samples[0];
const p99 = samples[0];
console.log(\`METRIC p50=\${p50} p95=\${p95} p99=\${p99} unit=ms n=\${samples.length} warmup_discarded=0 samples=\${samples.join(',')}\`);
`
  );
  await mkdir(dirname(`${target}/.opt/prescreen.sh`), { recursive: true });
  await writeFile(
    `${target}/.opt/prescreen.sh`,
    `#!/usr/bin/env bash
set -euo pipefail
node prescreen.mjs
`
  );
  await chmod(`${target}/.opt/prescreen.sh`, 0o755);
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
