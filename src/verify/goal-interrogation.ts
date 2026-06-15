import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import type { GoalInterrogationEntry, LedgerEntry, RunEvent } from '../shared/types.js';

const target = resolve('fixture/goal-interrogation-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDirectPlanFixture();
  await writeDeterministicMeasure();
  const paths = runPaths(target);

  const result = await execa(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Periodically check that behavior still matches GOAL.md', '--max-iters', '5', '--mode', 'stub'],
    {
      cwd: resolve('.'),
      all: true,
      reject: false,
      timeout: 30_000
    }
  );
  assert(result.exitCode === 0, `goal interrogation verifier supervisor run failed:\n${result.all}`);

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 5, `expected five ledger rows, got ${ledger.length}`);

  const checks = await readJsonLines<GoalInterrogationEntry>(paths.goalInterrogations);
  assert(checks.length === 1, `expected exactly one goal interrogation at iter 4, got ${checks.length}`);
  const check = checks[0];
  assert(check.iter === 4, `expected goal interrogation at iter 4, got ${check.iter}`);
  assert(check.goal_version === 1, `expected goal version 1, got ${check.goal_version}`);
  assert(check.restated_goal.includes('Periodically check that behavior still matches GOAL.md'), `restated goal missing requirement: ${check.restated_goal}`);
  assert(!check.restated_goal.includes('Optimize planner-selected validation'), `restated goal leaked internal metric placeholder: ${check.restated_goal}`);
  assert(check.restated_goal.includes("PLAN.md's planner-defined validation"), `restated goal should defer validation semantics to PLAN.md: ${check.restated_goal}`);
  assert(check.active_requirement_ids.includes('R1'), `active requirement ids missing R1: ${check.active_requirement_ids.join(',')}`);
  assert(check.acceptance_checks.some((item) => item.includes('./.opt/checks.sh')), `acceptance checks missing checks.sh: ${check.acceptance_checks.join(',')}`);

  const context = await readFile(paths.context, 'utf8');
  assert(context.includes('## Latest Goal Interrogation'), 'context missing latest goal interrogation section');
  assert(context.includes(check.id), 'context missing goal interrogation id');
  assert(context.includes('Periodic'), 'context missing restated goal text');

  const fifthPrompt = await readFile(join(paths.artifacts, 'iter-5.prompt.txt'), 'utf8');
  assert(fifthPrompt.includes('Latest Goal Interrogation'), 'iter-5 prompt missing goal interrogation from context');
  assert(fifthPrompt.includes(check.id), 'iter-5 prompt missing goal interrogation id');

  const events = await readJsonLines<RunEvent>(paths.events);
  const event = events.find((item) => item.type === 'GOAL_INTERROGATION');
  assert(event, 'missing GOAL_INTERROGATION event');
  assert((event.data as { iter?: number } | undefined)?.iter === 4, `goal interrogation event used wrong iter: ${JSON.stringify(event)}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after goal interrogation run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        ledger_rows: ledger.length,
        interrogation_id: check.id,
        prompt_reused_goal_check: true
      },
      null,
      2
    )
  );
}

async function writeDeterministicMeasure(): Promise<void> {
  await mkdir(`${target}/.opt`, { recursive: true });
  await writeFile(`${target}/.opt/checks.sh`, '#!/usr/bin/env bash\nset -euo pipefail\nnpm test\n');
  await writeFile(`${target}/.opt/measure.sh`, '#!/usr/bin/env bash\nset -euo pipefail\nnpm run measure\n');
  await chmod(`${target}/.opt/checks.sh`, 0o755);
  await chmod(`${target}/.opt/measure.sh`, 0o755);
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

async function writeDirectPlanFixture(): Promise<void> {
  await writeFile(
    `${target}/PLAN.md`,
    `# WiCi Execution Plan

Goal: Periodically check that behavior still matches GOAL.md while executing a direct markdown plan.

- [ ] S1 Optimize the fixture hot path
  - Validation: ./.opt/checks.sh && ./.opt/measure.sh
- [ ] S2 Verify the optimized implementation remains correct
  - Validation: ./.opt/checks.sh
- [ ] S3 Re-read PLAN.md and keep following the markdown source of truth
  - Validation: ./.opt/checks.sh
- [ ] S4 Record a public execution checkpoint before continuing
  - Validation: ./.opt/checks.sh
- [ ] S5 Continue after the periodic goal check with the condensed context available
  - Validation: ./.opt/checks.sh
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
