import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { LedgerEntry } from '../shared/types.js';

const target = resolve('fixture/metric-label-target');
const goalText = '听说diffussionGemma很快，要求达到700token/s以上';

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeThroughputMeasure();
  await git(['add', 'measure.mjs']);
  await git(['commit', '-m', 'test: make throughput measure deterministic']);
  const paths = runPaths(target);

  const result = await execa(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', goalText, '--max-iters', '1', '--mode', 'stub'],
    {
      cwd: resolve('.'),
      all: true,
      reject: false,
      timeout: 30_000
    }
  );
  assert(result.exitCode === 0, `metric label run failed:\n${result.all}`);

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 1, `expected one ledger row, got ${ledger.length}`);
  assert(ledger[0].status === 'keep', `expected throughput row to be kept, got ${ledger[0].status}`);
  assert(ledger[0].metric?.unit === 'token/s', `ledger should record token/s metric: ${JSON.stringify(ledger[0].metric)}`);

  const log = await git(['log', '--format=%s', '-8']);
  assert(log.includes('token throughput 650token/s->850token/s'), `perf commit did not use goal metric label:\n${log}`);
  assert(!log.includes('| p99 650->850token/s'), `perf commit leaked p99 label for throughput:\n${log}`);

  const tags = await git(['tag', '--list', 'perf/*']);
  assert(tags.split('\n').some((tag) => tag.startsWith('perf/token-throughput-850token-s-')), `throughput perf tag missing or unsanitized:\n${tags}`);
  assert(!tags.includes('perf/p99-850token/s'), `throughput perf tag used p99 label:\n${tags}`);

  const artifact = await readFile(`${target}/wici-limit-artifact.md`, 'utf8');
  assert(artifact.includes('Best token throughput=850token/s'), `limit artifact missing throughput label:\n${artifact}`);
  assert(artifact.includes('token throughput=850token/s'), `recent ledger artifact missing throughput metric:\n${artifact}`);
  assert(!artifact.includes('Best p99:'), `limit artifact leaked old p99 heading:\n${artifact}`);

  const context = await readFile(paths.context, 'utf8');
  assert(context.includes('token throughput=850token/s'), `context summary missing throughput metric:\n${context}`);
  assert(!context.includes(' p99=850token/s'), `context summary leaked p99 label:\n${context}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target dirty after metric label run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        metric: ledger[0].metric,
        throughput_commit_label: true,
        throughput_tag_label: true,
        throughput_artifact_label: true,
        throughput_context_label: true
      },
      null,
      2
    )
  );
}

async function writeThroughputMeasure(): Promise<void> {
  await writeFile(
    `${target}/measure.mjs`,
    `import { readFileSync } from 'node:fs';

const source = readFileSync('./src/hotpath.js', 'utf8');
const optimized = source.includes('new Set');
const samples = optimized ? [850, 850, 850, 850, 850, 850, 850] : [650, 650, 650, 650, 650, 650, 650];
const p50 = samples[3];
const p95 = samples[6];
const p99 = samples[6];
console.log(\`METRIC p50=\${p50} p95=\${p95} p99=\${p99} unit=token/s n=\${samples.length} warmup_discarded=2 samples=\${samples.join(',')}\`);
`
  );
}

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
