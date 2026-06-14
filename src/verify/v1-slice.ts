import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { exists, readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { AcceptanceSpec, BaselineFile, BenchmarkManifest, Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';
import { runSupervisor } from '../supervisor/index.js';

const target = resolve('fixture/v1-slice-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure(target);
  await git(['add', 'measure.mjs']);
  await git(['commit', '-m', 'test: make v1 slice measure deterministic']);

  const result = await runSupervisor({
    target,
    goal: 'Reduce p99 latency in a v1 vertical slice while preserving exact uniqueSorted output.',
    maxIters: 1,
    mode: 'stub'
  });
  assert(result.state === 'STOP', `v1 supervisor should stop cleanly, got ${JSON.stringify(result)}`);
  assert(result.reason === 'Reached max_iters=1', `unexpected v1 stop reason: ${result.reason}`);
  assert(result.iter === 1, `expected one v1 iteration, got ${result.iter}`);

  const paths = runPaths(target);
  await assertExists(paths.goalDoc, 'GOAL.md');
  await assertExists(paths.plan, 'PLAN.md');
  await assertExists(paths.acceptanceSpec, 'acceptance.spec.json');
  await assertExists(paths.benchmarkManifest, '.opt/benchmark.json');
  await assertExists(paths.measure, '.opt/measure.sh');
  await assertExists(paths.checks, '.opt/checks.sh');
  await assertExists(paths.baseline, 'baseline.json');
  await assertExists(paths.ledger, 'ledger.jsonl');
  await assertExists(`${target}/wici-limit-artifact.md`, 'wici-limit-artifact.md');
  await assertExists(`${paths.checkpoints}/iter-1.json`, '.wici/checkpoints/iter-1.json');
  await assertExists(`${paths.artifacts}/iter-1.json`, '.wici/artifacts/iter-1.json');
  await assertExists(`${paths.artifacts}/iter-1.prompt.txt`, '.wici/artifacts/iter-1.prompt.txt');

  const acceptance = await readJsonFile<AcceptanceSpec>(paths.acceptanceSpec);
  const goalDoc = await readFile(paths.goalDoc, 'utf8');
  assert(goalDoc.includes('# GOAL') && goalDoc.includes('v1 vertical slice'), `GOAL.md missing initial goal text:\n${goalDoc}`);
  assert(acceptance.criteria.some((criterion) => criterion.check === './.opt/checks.sh'), 'acceptance spec missing checks criterion');
  assert(acceptance.criteria.some((criterion) => criterion.check === './.opt/measure.sh'), 'acceptance spec missing measure criterion');

  const benchmark = await readJsonFile<BenchmarkManifest>(paths.benchmarkManifest);
  assert(benchmark.command === './.opt/measure.sh', `benchmark command should use locked measure.sh, got ${benchmark.command}`);
  assert(benchmark.min_reps >= 5, `benchmark min_reps too low: ${benchmark.min_reps}`);

  const baseline = await readJsonFile<BaselineFile>(paths.baseline);
  assert(typeof baseline.eval_sha256.measure === 'string' && baseline.eval_sha256.measure.length > 0, 'baseline missing measure hash');
  assert(typeof baseline.eval_sha256.checks === 'string' && baseline.eval_sha256.checks.length > 0, 'baseline missing checks hash');
  assert(typeof baseline.eval_sha256.benchmark_manifest === 'string', 'baseline missing benchmark manifest hash');
  assert(typeof baseline.eval_sha256.acceptance_spec === 'string', 'baseline missing acceptance spec hash');
  assert(typeof baseline.eval_sha256.files?.['test.mjs'] === 'string', 'baseline missing test guard hash');

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 1, `expected exactly one v1 ledger row, got ${ledger.length}`);
  assert(ledger[0].status === 'keep', `expected accepted v1 row, got ${ledger[0].status}`);
  assert((ledger[0].delta_pct ?? 0) > 0.5, `expected substantial deterministic improvement, got ${ledger[0].delta_pct}`);
  assert(typeof ledger[0].p_value === 'number' && ledger[0].p_value < 0.05, `accepted v1 row missing significant p-value: ${ledger[0].p_value}`);
  assert(ledger[0].commit, 'accepted v1 ledger row missing commit');
  assert(ledger[0].cost.wall_ms !== undefined, 'accepted v1 ledger row missing wall clock cost');

  const events = await readJsonLines<RunEvent>(paths.events);
  for (const type of [
    'SUPERVISOR_START',
    'ACCEPTANCE_SPEC_FROZEN',
    'PLAN_DONE',
    'BENCHMARK_SELECTED',
    'BASELINE_DONE',
    'EXECUTE_START',
    'EXECUTE_DONE',
    'EVALUATE_START',
    'GIT_COMMIT',
    'COMMIT',
    'LIMIT_ARTIFACT_COMMIT',
    'STOP'
  ]) {
    assert(events.some((event) => event.type === type), `missing v1 event ${type}`);
  }
  const commitEvent = events.find((event) => event.type === 'COMMIT');
  const commitData = commitEvent?.data as { p_value?: number } | undefined;
  assert(typeof commitData?.p_value === 'number' && commitData.p_value < 0.05, `COMMIT event missing significant p-value: ${JSON.stringify(commitEvent)}`);

  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(checkpoint.supervisor_state === 'STOP', `expected STOP checkpoint, got ${checkpoint.supervisor_state}`);
  assert(checkpoint.iter === 1, `expected checkpoint iter=1, got ${checkpoint.iter}`);
  assert(checkpoint.ledger_seq === 1, `expected checkpoint ledger_seq=1, got ${checkpoint.ledger_seq}`);
  const packageVersion = await readPackageVersion();
  const wiciVersion = checkpoint.tool_versions?.wici;
  assert(wiciVersion !== undefined, `checkpoint missing WiCi version block: ${JSON.stringify(checkpoint.tool_versions)}`);
  assert(wiciVersion.package_version === packageVersion, `checkpoint missing WiCi package version: ${JSON.stringify(checkpoint.tool_versions)}`);
  assert(
    wiciVersion.git_commit === null || /^[0-9a-f]{40}$/.test(wiciVersion.git_commit ?? ''),
    `checkpoint has invalid WiCi git commit: ${wiciVersion.git_commit}`
  );
  assert(typeof wiciVersion.git_dirty === 'boolean' || wiciVersion.git_dirty === undefined, 'checkpoint missing WiCi dirty flag');

  const hotpath = await readFile(`${target}/src/hotpath.js`, 'utf8');
  assert(hotpath.includes('new Set'), 'target hot path was not optimized by the v1 slice');

  const prompt = await readFile(`${paths.artifacts}/iter-1.prompt.txt`, 'utf8');
  assert(prompt.includes('WiCi safety constraints'), 'executor prompt missing safety constraints');
  assert(prompt.includes('Frozen acceptance spec'), 'executor prompt missing frozen acceptance spec');

  const checks = await execa(paths.checks, [], { cwd: target, all: true, reject: false });
  assert(checks.exitCode === 0, `locked checks failed after v1 run:\n${checks.all}`);
  const measure = await execa(paths.measure, [], { cwd: target, all: true, reject: false });
  assert(measure.exitCode === 0 && (measure.all ?? '').includes('METRIC '), `locked measure failed after v1 run:\n${measure.all}`);

  const log = await git(['log', '--oneline', '--decorate', '-8']);
  assert(log.includes('perf:'), `v1 target git log missing perf commit:\n${log}`);
  assert(log.includes('chore: record WiCi limit artifact'), `v1 target git log missing limit artifact commit:\n${log}`);
  const status = await git(['status', '--short']);
  assert(status.trim() === '', `v1 target worktree dirty:\n${status}`);

  const tui = await verifyTuiRender();

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        iter: result.iter,
        stop_reason: result.reason,
        ledger_rows: ledger.length,
        perf_commit: ledger[0].commit,
        events_checked: events.length,
        tui_rendered: tui.rendered
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

async function verifyTuiRender(): Promise<{ rendered: true }> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'tui', '--target', target, '--mode', 'stub', '--no-supervisor', '--no-fullscreen'],
    {
      cwd: resolve('.'),
      env: { ...process.env, FORCE_COLOR: '0', TERM: 'xterm-256color' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  const started = Date.now();
  while (Date.now() - started < 4000) {
    const text = stripAnsi(output);
    if (hasTuiPanes(text)) {
      await stopChild(child);
      return { rendered: true };
    }
    if (child.exitCode !== null) break;
    await delay(100);
  }

  await stopChild(child);
  const text = stripAnsi(output).slice(-4000);
  if (hasTuiPanes(text)) return { rendered: true };
  throw new Error(`TUI did not render expected v1 panes:\n${text}`);
}

function hasTuiPanes(text: string): boolean {
  return text.includes('WiCi') && text.includes('CHAT') && text.includes('GOAL') && text.includes('事实执行');
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    delay(1000).then(() => false)
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B[=>]/g, '');
}

async function assertExists(path: string, label: string): Promise<void> {
  assert(await exists(path), `missing ${label}: ${path}`);
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
