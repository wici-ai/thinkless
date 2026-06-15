import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import type { BaselineFile, LedgerEntry, RunEvent } from '../shared/types.js';

const passTarget = resolve('fixture/scorer-selftest-target');
const failTarget = resolve('fixture/scorer-selftest-fail-target');
process.env.WICI_LEGACY_OPTIMIZER = '1';

async function main(): Promise<void> {
  const pass = await runPassScenario();
  const fail = await runFailScenario();

  console.log(
    JSON.stringify(
      {
        ok: true,
        pass_target: passTarget,
        selftest_before_execute: pass.selftestBeforeExecute,
        good_delta_pct: pass.goodDeltaPct,
        bad_delta_pct: pass.badDeltaPct,
        fail_target: failTarget,
        failed_before_execute: fail.failedBeforeExecute
      },
      null,
      2
    )
  );
}

async function runPassScenario(): Promise<{ selftestBeforeExecute: boolean; goodDeltaPct: number; badDeltaPct: number }> {
  await createSampleTarget(passTarget, true);
  const paths = runPaths(passTarget);
  await writeDeterministicMeasure(passTarget);
  await writeSelftestPatches(paths, goodPatch(), badPatch());

  const result = await runSupervisor(passTarget);
  assert(result.exitCode === 0, `scorer self-test pass scenario failed:\n${result.all}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  const selftestIndex = events.findIndex((event) => event.type === 'SCORER_SELFTEST_PASS');
  const executeIndex = events.findIndex((event) => event.type === 'EXECUTE_START');
  assert(selftestIndex >= 0, 'missing SCORER_SELFTEST_PASS event');
  assert(executeIndex >= 0, 'missing EXECUTE_START event');
  assert(selftestIndex < executeIndex, 'scorer self-test did not run before executor');
  const data = events[selftestIndex].data as { good?: { delta_pct?: number; verdict?: string }; bad?: { delta_pct?: number; verdict?: string } } | undefined;
  assert(data?.good?.verdict === 'accept', `known-good patch was not accepted: ${JSON.stringify(data)}`);
  assert(data?.bad?.verdict === 'reject', `known-bad patch was not rejected: ${JSON.stringify(data)}`);

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 1, `expected one ledger row, got ${ledger.length}`);
  assert(ledger[0].status === 'keep', `expected normal executor improvement after self-test, got ${ledger[0].status}`);
  const baseline = JSON.parse(await readFile(paths.baseline, 'utf8')) as BaselineFile;
  assert(Boolean(baseline.eval_sha256.selftest_good_patch), `baseline did not pin good self-test patch: ${JSON.stringify(baseline.eval_sha256)}`);
  assert(Boolean(baseline.eval_sha256.selftest_bad_patch), `baseline did not pin bad self-test patch: ${JSON.stringify(baseline.eval_sha256)}`);

  const status = await git(passTarget, ['status', '--short']);
  assert(status.trim() === '', `pass target worktree dirty:\n${status}`);

  return {
    selftestBeforeExecute: true,
    goodDeltaPct: data.good.delta_pct ?? 0,
    badDeltaPct: data.bad.delta_pct ?? 0
  };
}

async function runFailScenario(): Promise<{ failedBeforeExecute: boolean }> {
  await createSampleTarget(failTarget, true);
  const paths = runPaths(failTarget);
  await writeDeterministicMeasure(failTarget);
  await writeSelftestPatches(paths, badPatch(), goodPatch());

  const result = await runSupervisor(failTarget);
  assert(result.exitCode !== 0, `scorer self-test fail scenario unexpectedly succeeded:\n${result.all}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'FAILED' && event.message.includes('known-good patch was not accepted')), `missing self-test failure event:\n${JSON.stringify(events)}`);
  assert(!events.some((event) => event.type === 'EXECUTE_START'), 'executor started after failed scorer self-test');
  const ledger = await readJsonLines<LedgerEntry>(paths.ledger).catch(() => []);
  assert(ledger.length === 0, `expected no ledger rows after failed startup self-test, got ${ledger.length}`);

  const status = await git(failTarget, ['status', '--short']);
  assert(status.trim() === '', `fail target worktree dirty:\n${status}`);

  return { failedBeforeExecute: true };
}

async function runSupervisor(target: string) {
  return execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Run scorer self-test before executor', '--max-iters', '1', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
}

async function writeDeterministicMeasure(target: string): Promise<void> {
  await writeFile(
    `${target}/measure.mjs`,
    `import { readFileSync } from 'node:fs';

const source = readFileSync('./src/hotpath.js', 'utf8');
const samples = source.includes('BAD_SLOW')
  ? [200, 200, 200, 200, 200, 200, 200]
  : source.includes('new Set')
    ? [10, 10, 10, 10, 10, 10, 10]
    : [100, 100, 100, 100, 100, 100, 100];
const p50 = samples[3];
const p95 = samples[6];
const p99 = samples[6];
console.log(\`METRIC p50=\${p50} p95=\${p95} p99=\${p99} unit=ms n=\${samples.length} warmup_discarded=2 samples=\${samples.join(',')}\`);
`
  );
}

async function writeSelftestPatches(paths: ReturnType<typeof runPaths>, good: string, bad: string): Promise<void> {
  await mkdir(dirname(paths.selftestGoodPatch), { recursive: true });
  await writeFile(paths.selftestGoodPatch, good);
  await writeFile(paths.selftestBadPatch, bad);
}

function goodPatch(): string {
  return `diff --git a/src/hotpath.js b/src/hotpath.js
--- a/src/hotpath.js
+++ b/src/hotpath.js
@@ -1,14 +1,3 @@
 export function uniqueSorted(values) {
-  const unique = [];
-  for (const value of values) {
-    let seen = false;
-    for (const candidate of values) {
-      if (candidate === value && unique.includes(candidate)) {
-        seen = true;
-        break;
-      }
-    }
-    if (!seen) unique.push(value);
-  }
-  return unique.sort((a, b) => a - b);
+  return [...new Set(values)].sort((a, b) => a - b);
 }
`;
}

function badPatch(): string {
  return `diff --git a/src/hotpath.js b/src/hotpath.js
--- a/src/hotpath.js
+++ b/src/hotpath.js
@@ -1,14 +1,4 @@
 export function uniqueSorted(values) {
-  const unique = [];
-  for (const value of values) {
-    let seen = false;
-    for (const candidate of values) {
-      if (candidate === value && unique.includes(candidate)) {
-        seen = true;
-        break;
-      }
-    }
-    if (!seen) unique.push(value);
-  }
-  return unique.sort((a, b) => a - b);
+  // BAD_SLOW
+  return [...new Set(values)].sort((a, b) => a - b);
 }
`;
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function git(target: string, args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
