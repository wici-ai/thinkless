import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import type { LedgerEntry, LessonEntry } from '../shared/types.js';

const target = resolve('fixture/lessons-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure();
  const paths = runPaths(target);

  const result = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Write and reuse WiCi lessons', '--max-iters', '3', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(result.exitCode === 0, `lessons verifier supervisor run failed:\n${result.all}`);

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 3, `expected 3 ledger rows, got ${ledger.length}`);
  assert(ledger[0].status === 'keep', `expected first row keep, got ${ledger[0].status}`);
  assert(ledger[1].status === 'reject', `expected second row reject, got ${ledger[1].status}`);
  assert(ledger[2].status === 'reject', `expected third row reject, got ${ledger[2].status}`);

  const lessons = await readJsonLines<LessonEntry>(paths.lessons);
  assert(lessons.length === 2, `expected only measured reject lessons, got ${lessons.length}`);
  assert(lessons.every((lesson) => lesson.status === 'reject'), `lessons should only come from rejects: ${JSON.stringify(lessons)}`);
  assert(lessons.every((lesson) => lesson.trigger === 'measured_reject'), `lessons missing measured_reject trigger: ${JSON.stringify(lessons)}`);
  assert(lessons.every((lesson) => lesson.author === 'supervisor'), `stub lessons should use supervisor fallback: ${JSON.stringify(lessons)}`);
  assert(lessons[0].source_ledger_id === 'iter-2', `first lesson should come from measured reject iter-2: ${JSON.stringify(lessons[0])}`);
  assert(lessons[0].lesson.includes('Measured verifier rejected'), `first reject lesson missing verifier language: ${lessons[0].lesson}`);

  const secondPrompt = await readFile(`${paths.artifacts}/iter-2.prompt.txt`, 'utf8');
  assert(!secondPrompt.includes('Recent WiCi lessons to apply'), 'iter-2 prompt should not include a keep-derived lesson');
  const thirdPrompt = await readFile(`${paths.artifacts}/iter-3.prompt.txt`, 'utf8');
  assert(thirdPrompt.includes('Recent WiCi lessons to apply'), 'iter-3 prompt missing lessons header after measured reject');
  assert(thirdPrompt.includes(lessons[0].lesson), 'iter-3 prompt missing measured reject lesson');

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after lessons run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        ledger_rows: ledger.length,
        lessons: lessons.length,
        prompt_reused_lesson: true
      },
      null,
      2
    )
  );
}

async function writeDeterministicMeasure(): Promise<void> {
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
