import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { exists, readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';
import { runSupervisor } from '../supervisor/index.js';

const target = resolve('fixture/v1-slice-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure(target);
  await git(['add', 'measure.mjs']);
  await git(['commit', '-m', 'test: make v1 slice measure deterministic']);

  const result = await runSupervisor({
    target,
    goal: 'Improve the v1 vertical slice fixture while preserving exact uniqueSorted output correctness.',
    maxIters: 1,
    mode: 'stub'
  });
  assert(result.state === 'STOP', `v1 supervisor should stop cleanly, got ${JSON.stringify(result)}`);
  assert(result.reason === 'Reached max_iters=1', `unexpected v1 stop reason: ${result.reason}`);
  assert(result.iter === 1, `expected one v1 iteration, got ${result.iter}`);

  const paths = runPaths(target);
  await assertExists(paths.goalDoc, 'GOAL.md');
  await assertExists(paths.plan, 'PLAN.md');
  await assertExists(paths.measure, '.opt/measure.sh');
  await assertExists(paths.checks, '.opt/checks.sh');
  await assertExecutable(paths.measure, '.opt/measure.sh');
  await assertExecutable(paths.checks, '.opt/checks.sh');
  await assertExists(`${paths.artifacts}/iter-1.json`, '.wici/artifacts/iter-1.json');
  await assertExists(`${paths.artifacts}/iter-1.prompt.txt`, '.wici/artifacts/iter-1.prompt.txt');

  const goalDoc = await readFile(paths.goalDoc, 'utf8');
  assert(goalDoc.includes('# GOAL') && goalDoc.includes('v1 vertical slice'), `GOAL.md missing initial goal text:\n${goalDoc}`);
  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes('- [x] S1') || plan.includes('status:done'), `PLAN.md did not mark the executed step done:\n${plan}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  for (const type of [
    'SUPERVISOR_START',
    'PLAN_DONE',
    'EXECUTE_START',
    'EXECUTE_DONE',
    'GIT_COMMIT',
    'STOP'
  ]) {
    assert(events.some((event) => event.type === type), `missing v1 event ${type}`);
  }
  assert(!events.some((event) => event.type === 'BASELINE_START'), 'fresh V1 direct run must not initialize baseline before Codex execution');
  assert(!events.some((event) => event.type === 'EVALUATE_START'), 'fresh V1 direct run must not require measure/evaluate before completing execution');

  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(checkpoint.supervisor_state === 'STOP', `expected STOP checkpoint, got ${checkpoint.supervisor_state}`);
  assert(checkpoint.iter === 1, `expected checkpoint iter=1, got ${checkpoint.iter}`);
  assert(checkpoint.ledger_seq === 1, `direct V1 run should record one ledger receipt, got ${checkpoint.ledger_seq}`);
  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 1, `direct V1 run should record one ledger row, got ${ledger.length}`);
  assert(ledger[0].guards.direct === true, `direct V1 ledger row should be marked direct: ${JSON.stringify(ledger[0])}`);
  assert(ledger[0].cost.tokens_input !== undefined, `direct V1 ledger row missing token usage: ${JSON.stringify(ledger[0])}`);
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
  assert(prompt.includes('Execute the current GOAL.md and PLAN.md as one Codex goal.'), 'executor prompt must treat GOAL.md and PLAN.md as one Codex goal');
  assert(prompt.includes('Supervisor receipt focus: S1.'), 'executor prompt missing supervisor receipt focus');
  assert(prompt.includes('Current GOAL.md:'), 'executor prompt missing embedded GOAL.md section');
  assert(prompt.includes('v1 vertical slice'), 'executor prompt missing GOAL.md content');
  assert(prompt.includes('Current PLAN.md:'), 'executor prompt missing embedded PLAN.md section');
  assert(prompt.includes('S1'), 'executor prompt missing PLAN.md step content');

  const checks = await execa(paths.checks, [], { cwd: target, all: true, reject: false });
  assert(checks.exitCode === 0, `locked checks failed after v1 run:\n${checks.all}`);
  const measure = await execa(paths.measure, [], { cwd: target, all: true, reject: false });
  assert(measure.exitCode === 0 && (measure.all ?? '').includes('METRIC '), `locked measure failed after v1 run:\n${measure.all}`);

  const log = await git(['log', '--oneline', '--decorate', '-8']);
  assert(log.includes('chore: initialize WiCi plan'), `v1 target git log missing initial plan checkpoint:\n${log}`);
  assert(log.includes('chore: WiCi direct iteration 1 S1'), `v1 target git log missing direct execution checkpoint:\n${log}`);
  assert(log.includes('chore: record WiCi direct iteration 1 state'), `v1 target git log missing direct state checkpoint:\n${log}`);
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

async function assertExecutable(path: string, label: string): Promise<void> {
  const mode = (await stat(path)).mode;
  assert((mode & 0o111) !== 0, `${label} should be executable: ${path}`);
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
