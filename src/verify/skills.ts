import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import type { RunEvent, SkillLibrary } from '../shared/types.js';

const target = resolve('fixture/skills-target');
process.env.WICI_LEGACY_OPTIMIZER = '1';

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure();
  const paths = runPaths(target);

  const result = await execa(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Reuse accepted optimization skills for the hot path', '--max-iters', '2', '--mode', 'stub'],
    {
      cwd: resolve('.'),
      all: true,
      reject: false,
      timeout: 30_000
    }
  );
  assert(result.exitCode === 0, `skills verifier supervisor run failed:\n${result.all}`);

  const library = JSON.parse(await readFile(paths.skillsIndex, 'utf8')) as SkillLibrary;
  assert(library.entries.length === 1, `expected one recorded skill, got ${library.entries.length}`);
  const skill = library.entries[0];
  assert(skill.source_ledger_id === 'iter-1', `skill should come from iter-1, got ${skill.source_ledger_id}`);
  assert(skill.patch_path === '.wici/skills/skill-iter-1.patch', `unexpected skill patch path: ${skill.patch_path}`);
  assert(skill.patch_sha256.length === 64, `skill missing sha256: ${skill.patch_sha256}`);

  const patch = await readFile(join(target, skill.patch_path), 'utf8');
  assert(patch.includes('new Set'), 'skill patch does not contain accepted optimization');
  const patchCheck = await execa('git', ['-C', target, 'apply', '--check', '--reverse', skill.patch_path], { all: true, reject: false });
  assert(patchCheck.exitCode === 0, `recorded skill patch is not executable against current tree:\n${patchCheck.all}`);

  const secondPrompt = await readFile(join(paths.artifacts, 'iter-2.prompt.txt'), 'utf8');
  assert(secondPrompt.includes('Executable WiCi skills retrieved from prior accepted patches'), 'iter-2 prompt missing skill library header');
  assert(secondPrompt.includes(skill.patch_path), 'iter-2 prompt missing skill patch path');

  const events = await readJsonLines<RunEvent>(paths.events);
  const event = events.find((item) => item.type === 'SKILL_RECORDED');
  assert(event, 'missing SKILL_RECORDED event');
  assert((event.data as { patch_path?: string } | undefined)?.patch_path === skill.patch_path, `skill event missing patch path: ${JSON.stringify(event)}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after skills run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        skills: library.entries.length,
        patch_path: skill.patch_path,
        prompt_reused_skill: true
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
