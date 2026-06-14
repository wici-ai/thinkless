import { chmod, readFile, readdir, stat } from 'node:fs/promises';
import { execa } from 'execa';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { atomicWriteFile, atomicWriteJson, exists, makeReadOnly, makeWritable } from '../shared/atomic.js';
import { promptPath, schemaPath, type RunPaths } from '../shared/paths.js';
import type { EvalSha256, GoalFile, ToolInvocationResult, WiCiConfig } from '../shared/types.js';
import { applyPlanDiff } from './plan.js';
import { type PlannerBenchmark, writeBenchmarkManifest } from './benchmark.js';
import { appendSafety, formatSafetyForPrompt } from './safety.js';
import { primaryMetricName } from './metricFormat.js';

interface PlannerOutput {
  session_id?: string;
  structured_output?: {
    summary?: string;
    planMarkdown: string;
    measureSh: string;
    checksSh: string;
    benchmark?: PlannerBenchmark;
  };
  planMarkdown?: string;
  measureSh?: string;
  checksSh?: string;
  benchmark?: PlannerBenchmark;
}

async function commandExists(command: string): Promise<boolean> {
  const result = await execa('command', ['-v', command], { shell: true, reject: false });
  return result.exitCode === 0;
}

function requirementText(goal: GoalFile): string {
  return goal.requirements.filter((req) => req.status === 'active').map((req) => req.text).join('\n');
}

function extractStructured(raw: string): PlannerOutput {
  const parsed = JSON.parse(raw) as PlannerOutput;
  return parsed;
}

export async function runInitialPlanner(paths: RunPaths, goal: GoalFile, config: WiCiConfig): Promise<ToolInvocationResult> {
  const available = await commandExists(config.tools.planner.command);
  if (config.tools.mode === 'real' && !available) {
    throw new Error(`Planner command not found in real mode: ${config.tools.planner.command}`);
  }

  if (config.tools.mode !== 'stub' && available) {
    try {
      const systemPrompt = await readFile(promptPath('planner'), 'utf8');
      const schema = await readFile(schemaPath('plan'), 'utf8');
      const safetyText = formatSafetyForPrompt(config);
      const goalText = await readPlannerGoalText(paths, goal);
      const result = await execa(
        config.tools.planner.command,
        buildInitialPlannerArgs({
          goalText,
          schema,
          effort: config.tools.planner.effort,
          systemPrompt,
          safetyText
        }),
        {
          cwd: paths.target,
          reject: true,
          all: true,
          maxBuffer: 1024 * 1024 * 20
        }
      );
      const output = extractStructured(result.stdout);
      await materializePlannerOutput(paths, output);
      return { ok: true, sessionId: output.session_id, stdout: result.all ?? result.stdout };
    } catch (error) {
      if (config.tools.mode === 'real') throw error;
    }
  }

  await materializeStubPlan(paths, goal);
  return { ok: true, sessionId: 'stub-planner', stdout: 'stub planner materialized PLAN.md and .opt scripts' };
}

export async function runPlanDiff(paths: RunPaths, goal: GoalFile, plannerSessionId: string | undefined, newText: string, config: WiCiConfig): Promise<ToolInvocationResult> {
  const available = await commandExists(config.tools.planner.command);
  if (config.tools.mode === 'real' && !available) {
    throw new Error(`Planner command not found in real mode: ${config.tools.planner.command}`);
  }
  if (config.tools.mode === 'real' && (!plannerSessionId || plannerSessionId === 'stub-planner')) {
    throw new Error('Planner resume session is required in real mode for plan diffs');
  }

  if (config.tools.mode !== 'stub' && plannerSessionId && plannerSessionId !== 'stub-planner' && available) {
    try {
      const systemPrompt = await readFile(promptPath('planner-diff'), 'utf8');
      const plan = await readFile(paths.plan, 'utf8');
      const schema = await readFile(schemaPath('plan-diff'), 'utf8');
      const safetyText = formatSafetyForPrompt(config);
      const goalText = await readPlannerGoalText(paths, goal);
      const result = await execa(
        config.tools.planner.command,
        buildPlanDiffArgs({
          newText,
          currentPlan: plan,
          goalText,
          sessionId: plannerSessionId,
          schema,
          systemPrompt,
          safetyText
        }),
        {
          cwd: paths.target,
          reject: true,
          all: true,
          maxBuffer: 1024 * 1024 * 20
        }
      );
      const parsed = JSON.parse(result.stdout) as { structured_output?: Parameters<typeof applyPlanDiff>[1] } & Parameters<typeof applyPlanDiff>[1];
      await applyPlanDiff(paths, parsed.structured_output ?? parsed);
      return { ok: true, sessionId: plannerSessionId, stdout: result.all ?? result.stdout };
    } catch (error) {
      if (config.tools.mode === 'real') throw error;
    }
  }

  const plan = await readFile(paths.plan, 'utf8');
  const nextId = `S${(plan.match(/-\s+\[[ x>!]\]\s+S\d+/g)?.length ?? 0) + 1}`;
  await applyPlanDiff(paths, {
    add: [{ after: 'S9999', id: nextId, text: `Incorporate new requirement: ${newText}` }]
  });
  return { ok: true, sessionId: plannerSessionId ?? 'stub-planner', stdout: 'stub planner applied requirement diff' };
}

export function buildInitialPlannerArgs(input: { goalText: string; schema: string; effort: string; systemPrompt: string; safetyText?: string }): string[] {
  return [
    '-p',
    `ULTRAPLAN for goal:\n${input.goalText}`,
    '--output-format',
    'json',
    '--json-schema',
    input.schema,
    '--effort',
    input.effort,
    '--permission-mode',
    'plan',
    '--disallowedTools',
    'Bash(git push *)',
    'Bash(rm -rf *)',
    '--append-system-prompt',
    appendSafety(input.systemPrompt, input.safetyText ?? '')
  ];
}

export function buildPlanDiffArgs(input: {
  newText: string;
  currentPlan: string;
  goalText: string;
  sessionId: string;
  schema: string;
  systemPrompt: string;
  safetyText?: string;
}): string[] {
  return [
    '-p',
    `New requirement: ${input.newText}\n\nCurrent GOAL.md:\n${input.goalText}\n\nCurrent PLAN.md:\n${input.currentPlan}`,
    '--resume',
    input.sessionId,
    '--output-format',
    'json',
    '--json-schema',
    input.schema,
    '--permission-mode',
    'plan',
    '--append-system-prompt',
    appendSafety(input.systemPrompt, input.safetyText ?? '')
  ];
}

async function readPlannerGoalText(paths: RunPaths, goal: GoalFile): Promise<string> {
  return (await exists(paths.goalDoc)) ? readFile(paths.goalDoc, 'utf8') : requirementText(goal);
}

async function materializePlannerOutput(paths: RunPaths, output: PlannerOutput): Promise<void> {
  const structured = output.structured_output ?? output;
  if (!structured.planMarkdown || !structured.measureSh || !structured.checksSh) {
    throw new Error('Planner output missing planMarkdown, measureSh, or checksSh');
  }
  await atomicWriteFile(paths.plan, ensureTrailingNewline(structured.planMarkdown));
  await atomicWriteFile(paths.measure, ensureScript(structured.measureSh), 0o755);
  await atomicWriteFile(paths.checks, ensureScript(structured.checksSh), 0o755);
  await writeBenchmarkManifest(paths, await readGoalForPlanner(paths), structured.benchmark ?? output.benchmark);
  await chmod(paths.measure, 0o755);
  await chmod(paths.checks, 0o755);
}

async function materializeStubPlan(paths: RunPaths, goal: GoalFile): Promise<void> {
  const metricName = primaryMetricName(goal);
  const plan = `# WiCi Optimization Plan

Goal: ${requirementText(goal) || 'Optimize the target metric while preserving correctness.'}

- [ ] S1 Replace avoidable quadratic hot-path work with a linear implementation
  - Experiment: inspect the hot path and remove nested scans or redundant recomputation.
  - Validation: ./.opt/checks.sh && ./.opt/measure.sh
- [ ] S2 Re-run measurement and commit only if ${metricName} improves beyond the configured noise gate
  - Experiment: validate the optimized path against the locked metric.
  - Validation: ./.opt/checks.sh && ./.opt/measure.sh
`;

  const checks = `#!/usr/bin/env bash
set -euo pipefail
node test.mjs
`;

  const measure = `#!/usr/bin/env bash
set -euo pipefail
node measure.mjs
`;

  await atomicWriteFile(paths.plan, plan);
  await atomicWriteFile(paths.measure, checksExecutable(measure), 0o755);
  await atomicWriteFile(paths.checks, checksExecutable(checks), 0o755);
  await writeBenchmarkManifest(paths, goal, {
    tool: 'node',
    command: './.opt/measure.sh',
    metric: goal.metric.name,
    min_reps: 5,
    warmup_discarded: 2,
    reason: `Fixture target uses a deterministic Node workload through .opt/measure.sh; it emits WiCi ${metricName} METRIC samples for the locked gate.`
  });
  await chmod(paths.measure, 0o755);
  await chmod(paths.checks, 0o755);
}

function ensureScript(script: string): string {
  const text = ensureTrailingNewline(script);
  return text.startsWith('#!') ? text : `#!/usr/bin/env bash\nset -euo pipefail\n${text}`;
}

function checksExecutable(script: string): string {
  return ensureTrailingNewline(script);
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

export async function lockEvalScripts(paths: RunPaths): Promise<EvalSha256> {
  const hashes = await evalHashes(paths);
  await makeReadOnly(paths.measure);
  await makeReadOnly(paths.checks);
  if (await exists(paths.benchmarkManifest)) await makeReadOnly(paths.benchmarkManifest);
  if (await exists(paths.acceptanceSpec)) await makeReadOnly(paths.acceptanceSpec);
  if (await exists(paths.prescreen)) await makeReadOnly(paths.prescreen);
  if (await exists(paths.validate)) await makeReadOnly(paths.validate);
  if (await exists(paths.selftestGoodPatch)) await makeReadOnly(paths.selftestGoodPatch);
  if (await exists(paths.selftestBadPatch)) await makeReadOnly(paths.selftestBadPatch);
  for (const file of Object.keys(hashes.files ?? {})) {
    await makeReadOnly(join(paths.target, file)).catch(() => undefined);
  }
  return hashes;
}

export async function unlockEvalScripts(paths: RunPaths): Promise<void> {
  if (await exists(paths.measure)) await makeWritable(paths.measure);
  if (await exists(paths.checks)) await makeWritable(paths.checks);
  if (await exists(paths.benchmarkManifest)) await makeWritable(paths.benchmarkManifest);
  if (await exists(paths.acceptanceSpec)) await makeWritable(paths.acceptanceSpec);
  if (await exists(paths.prescreen)) await makeWritable(paths.prescreen);
  if (await exists(paths.validate)) await makeWritable(paths.validate);
  if (await exists(paths.selftestGoodPatch)) await makeWritable(paths.selftestGoodPatch);
  if (await exists(paths.selftestBadPatch)) await makeWritable(paths.selftestBadPatch);
}

export async function evalHashes(paths: RunPaths): Promise<EvalSha256> {
  const guardFiles = await discoverGuardFiles(paths);
  const files: Record<string, string> = {};
  for (const file of guardFiles) {
    files[file] = await sha256File(join(paths.target, file));
  }
  return {
    measure: await sha256File(paths.measure),
    checks: await sha256File(paths.checks),
    ...((await exists(paths.benchmarkManifest)) ? { benchmark_manifest: await sha256File(paths.benchmarkManifest) } : {}),
    ...((await exists(paths.acceptanceSpec)) ? { acceptance_spec: await sha256File(paths.acceptanceSpec) } : {}),
    ...((await exists(paths.prescreen)) ? { prescreen: await sha256File(paths.prescreen) } : {}),
    ...((await exists(paths.validate)) ? { validate: await sha256File(paths.validate) } : {}),
    ...((await exists(paths.selftestGoodPatch)) ? { selftest_good_patch: await sha256File(paths.selftestGoodPatch) } : {}),
    ...((await exists(paths.selftestBadPatch)) ? { selftest_bad_patch: await sha256File(paths.selftestBadPatch) } : {}),
    files
  };
}

async function sha256File(path: string): Promise<string> {
  const raw = await readFile(path);
  return createHash('sha256').update(raw).digest('hex');
}

export async function verifyEvalHashes(paths: RunPaths, expected: EvalSha256): Promise<void> {
  const actual = await evalHashes(paths);
  if (actual.measure !== expected.measure || actual.checks !== expected.checks) {
    throw new Error(`eval_sha256 mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  if (actual.validate !== expected.validate) {
    throw new Error(`eval_sha256 mismatch for validate.sh: expected ${expected.validate ?? 'missing'}, got ${actual.validate ?? 'missing'}`);
  }
  if (actual.benchmark_manifest !== expected.benchmark_manifest) {
    throw new Error(
      `eval_sha256 mismatch for .opt/benchmark.json: expected ${expected.benchmark_manifest ?? 'missing'}, got ${actual.benchmark_manifest ?? 'missing'}`
    );
  }
  if (actual.acceptance_spec !== expected.acceptance_spec) {
    throw new Error(
      `eval_sha256 mismatch for acceptance.spec.json: expected ${expected.acceptance_spec ?? 'missing'}, got ${actual.acceptance_spec ?? 'missing'}`
    );
  }
  if (actual.prescreen !== expected.prescreen) {
    throw new Error(`eval_sha256 mismatch for prescreen.sh: expected ${expected.prescreen ?? 'missing'}, got ${actual.prescreen ?? 'missing'}`);
  }
  if (actual.selftest_good_patch !== expected.selftest_good_patch) {
    throw new Error(
      `eval_sha256 mismatch for selftest-good.patch: expected ${expected.selftest_good_patch ?? 'missing'}, got ${actual.selftest_good_patch ?? 'missing'}`
    );
  }
  if (actual.selftest_bad_patch !== expected.selftest_bad_patch) {
    throw new Error(
      `eval_sha256 mismatch for selftest-bad.patch: expected ${expected.selftest_bad_patch ?? 'missing'}, got ${actual.selftest_bad_patch ?? 'missing'}`
    );
  }
  for (const [file, hash] of Object.entries(expected.files ?? {})) {
    if (actual.files?.[file] !== hash) {
      throw new Error(`eval_sha256 mismatch for ${file}: expected ${hash}, got ${actual.files?.[file] ?? 'missing'}`);
    }
  }
}

async function readGoalForPlanner(paths: RunPaths): Promise<GoalFile> {
  return JSON.parse(await readFile(paths.goal, 'utf8')) as GoalFile;
}

async function discoverGuardFiles(paths: RunPaths): Promise<string[]> {
  const found: string[] = [];
  await walk(paths.target, found, paths.target);
  return found.sort();
}

async function walk(dir: string, found: string[], root: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.wici' || entry.name === '.opt' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, found, root);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isGuardFile(entry.name, relative(root, full))) continue;
    const info = await stat(full);
    if (info.size > 1024 * 1024) continue;
    found.push(relative(root, full));
  }
}

function isGuardFile(name: string, rel: string): boolean {
  const normalized = rel.replaceAll('\\', '/');
  return (
    /^test\.(mjs|cjs|js|ts|tsx)$/.test(name) ||
    /^spec\.(mjs|cjs|js|ts|tsx)$/.test(name) ||
    /\.(test|spec)\.(mjs|cjs|js|ts|tsx)$/.test(name) ||
    normalized.startsWith('test/') ||
    normalized.startsWith('tests/') ||
    normalized.startsWith('__tests__/')
  );
}
