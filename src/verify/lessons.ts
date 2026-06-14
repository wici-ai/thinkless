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

  const result = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Write and reuse WiCi lessons', '--max-iters', '2', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(result.exitCode === 0, `lessons verifier supervisor run failed:\n${result.all}`);

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 2, `expected 2 ledger rows, got ${ledger.length}`);
  assert(ledger[0].status === 'keep', `expected first row keep, got ${ledger[0].status}`);
  assert(ledger[1].status === 'reject', `expected second row reject, got ${ledger[1].status}`);

  const lessons = await readJsonLines<LessonEntry>(paths.lessons);
  assert(lessons.length === 2, `expected 2 lessons, got ${lessons.length}`);
  assert(lessons[0].lesson.includes('Promising avenue'), `first lesson did not capture keep: ${lessons[0].lesson}`);
  assert(lessons[1].lesson.includes('Avoid repeating'), `second lesson did not capture reject: ${lessons[1].lesson}`);

  const secondPrompt = await readFile(`${paths.artifacts}/iter-2.prompt.txt`, 'utf8');
  assert(secondPrompt.includes('Recent WiCi lessons to apply'), 'iter-2 prompt missing lessons header');
  assert(secondPrompt.includes(lessons[0].lesson), 'iter-2 prompt missing first lesson');

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
