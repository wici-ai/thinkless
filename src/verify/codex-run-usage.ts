import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import type { LedgerEntry, RunEvent } from '../shared/types.js';
import { CodexRunError, assertCodexRunSucceeded, parseCodexRunEvents } from '../supervisor/codexRun.js';

const target = resolve('fixture/codex-run-target');

async function main(): Promise<void> {
  await verifyParser();
  await verifyLedgerCost();
}

async function verifyParser(): Promise<void> {
  const summary = parseCodexRunEvents(
    [
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 5, cost_usd: 0.0012 } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'message' } }),
      'non-json progress line'
    ].join('\n')
  );
  assert(summary.events === 2, `expected two parsed json events, got ${summary.events}`);
  assert(summary.completed_turns === 1, `expected one completed turn, got ${summary.completed_turns}`);
  assert(summary.completed_items === 1, `expected one completed item, got ${summary.completed_items}`);
  assert(summary.tokens_input === 12, `expected 12 input tokens, got ${summary.tokens_input}`);
  assert(summary.tokens_output === 5, `expected 5 output tokens, got ${summary.tokens_output}`);
  assert(summary.usd === 0.0012, `expected usd cost 0.0012, got ${summary.usd}`);

  const failed = parseCodexRunEvents(JSON.stringify({ type: 'turn.failed', error: { message: 'model stream failed' } }));
  assert(failed.failed === true, 'turn.failed event did not mark summary failed');
  try {
    assertCodexRunSucceeded(failed, 'synthetic failure');
    throw new Error('assertCodexRunSucceeded did not throw');
  } catch (error) {
    assert(error instanceof CodexRunError, `expected CodexRunError, got ${String(error)}`);
    assert(error.usage.failed === true, 'CodexRunError did not retain usage summary');
  }
}

async function verifyLedgerCost(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure();
  const paths = runPaths(target);

  const result = await execa(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Parse codex run usage into the ledger', '--max-iters', '1', '--mode', 'stub'],
    {
      cwd: resolve('.'),
      all: true,
      reject: false,
      timeout: 30_000
    }
  );
  assert(result.exitCode === 0, `codex-run usage verifier supervisor run failed:\n${result.all}`);

  const transcript = await readFile(paths.codexRun, 'utf8');
  assert(transcript.includes('"turn.completed"'), 'codex-run transcript missing turn.completed event');
  assert(transcript.includes('"item.completed"'), 'codex-run transcript missing item.completed event');

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 1, `expected one ledger row, got ${ledger.length}`);
  assert((ledger[0].cost.tokens_input ?? 0) > 0, `ledger missing input token cost: ${JSON.stringify(ledger[0].cost)}`);
  assert((ledger[0].cost.tokens_output ?? 0) > 0, `ledger missing output token cost: ${JSON.stringify(ledger[0].cost)}`);
  assert((ledger[0].cost.wall_ms ?? 0) > 0, `ledger missing wall_ms cost: ${JSON.stringify(ledger[0].cost)}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  const executeDone = events.find((event) => event.type === 'EXECUTE_DONE');
  const usage = (executeDone?.data as { usage?: { tokens_input?: number; tokens_output?: number } } | undefined)?.usage;
  assert((usage?.tokens_input ?? 0) > 0, `EXECUTE_DONE event missing input token usage: ${JSON.stringify(executeDone)}`);
  assert((usage?.tokens_output ?? 0) > 0, `EXECUTE_DONE event missing output token usage: ${JSON.stringify(executeDone)}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after codex-run usage run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        transcript_parsed: true,
        ledger_tokens_input: ledger[0].cost.tokens_input,
        ledger_tokens_output: ledger[0].cost.tokens_output
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
