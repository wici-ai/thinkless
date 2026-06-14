import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { exists } from '../shared/atomic.js';
import type { RollbackPreview, RollbackResult } from '../supervisor/rollback.js';

const target = resolve('fixture/rollback-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure(target);
  await git(['add', 'measure.mjs']);
  await git(['commit', '-m', 'test: make rollback measure deterministic']);

  const run = await execa(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Create a rollback point after one accepted improvement', '--max-iters', '1', '--mode', 'stub'],
    { cwd: resolve('.'), all: true, reject: false, timeout: 30_000 }
  );
  assert(run.exitCode === 0, `rollback setup run failed:\n${run.all}`);

  const best = await git(['rev-parse', 'wici/best']);
  const headBeforeDirty = await git(['rev-parse', 'HEAD']);
  assert(best.trim() !== headBeforeDirty.trim(), 'rollback fixture should have a later limit artifact commit after wici/best');

  await writeFile(`${target}/src/hotpath.js`, `${await readFile(`${target}/src/hotpath.js`, 'utf8')}\n// dirty local attempt\n`);
  await writeFile(`${target}/scratch.tmp`, 'untracked local file\n');
  const dirtyStatus = await git(['status', '--short']);
  assert(dirtyStatus.includes('M src/hotpath.js') && dirtyStatus.includes('?? scratch.tmp'), `fixture did not become dirty:\n${dirtyStatus}`);

  const preview = await rollback(['--target', target]) as RollbackPreview;
  assert(preview.confirm_required === true, 'rollback preview should require explicit confirmation');
  assert(preview.source === 'wici/best', `rollback should prefer wici/best, got ${preview.source}`);
  assert(preview.rollback_commit === best.trim(), `preview rollback commit ${preview.rollback_commit} did not match wici/best ${best}`);
  assert(preview.dirty === true, 'rollback preview should report dirty target');
  assert(preview.wici?.package_version === await readPackageVersion(), `rollback preview missing WiCi package version: ${JSON.stringify(preview.wici)}`);

  const stillDirty = await git(['status', '--short']);
  assert(stillDirty.includes('scratch.tmp'), 'rollback preview must not clean the target');

  const executed = await rollback(['--target', target, '--confirm']) as RollbackResult;
  assert(executed.reset === true && executed.cleaned === true, `rollback did not execute reset/clean: ${JSON.stringify(executed)}`);
  assert(executed.head_after === best.trim(), `rollback HEAD ${executed.head_after} did not match wici/best ${best}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after rollback:\n${status}`);
  assert(!(await exists(`${target}/scratch.tmp`)), 'rollback did not remove untracked file');
  assert(await exists(`${target}/.wici/checkpoint.json`), 'rollback should preserve .wici checkpoint state');

  await git(['tag', '-d', 'wici/best']);
  const fallbackPreview = await rollback(['--target', target]) as RollbackPreview;
  assert(fallbackPreview.source === 'baseline.best_commit', `rollback should fall back to baseline.best_commit without tag, got ${fallbackPreview.source}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        rollback_ref: executed.rollback_ref,
        rollback_commit: executed.rollback_commit,
        fallback_source: fallbackPreview.source,
        preview_was_non_destructive: true,
        target_clean_after_rollback: true
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

async function rollback(args: string[]): Promise<unknown> {
  const result = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'rollback', ...args], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(result.exitCode === 0, `rollback command failed:\n${result.all}`);
  return JSON.parse(result.stdout || result.all || '{}') as unknown;
}

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readPackageVersion(): Promise<string | undefined> {
  return (JSON.parse(await readFile('package.json', 'utf8')) as { version?: string }).version;
}

await main();
