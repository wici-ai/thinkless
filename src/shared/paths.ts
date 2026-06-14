import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { atomicWriteFile, ensureDir, exists } from './atomic.js';

const thisFile = fileURLToPath(import.meta.url);

export const SRC_ROOT = resolve(dirname(thisFile), '..');
export const TOOL_ROOT = resolve(SRC_ROOT, '..');

export interface RunPaths {
  target: string;
  wici: string;
  inbox: string;
  inboxDone: string;
  outbox: string;
  artifacts: string;
  checkpoints: string;
  events: string;
  codexRun: string;
  goal: string;
  checkpoint: string;
  lock: string;
  plan: string;
  acceptanceSpec: string;
  opt: string;
  measure: string;
  checks: string;
  prescreen: string;
  validate: string;
  selftestGoodPatch: string;
  selftestBadPatch: string;
  baseline: string;
  ledger: string;
  lessons: string;
  context: string;
  goalInterrogations: string;
  avenues: string;
  config: string;
}

export function runPaths(target: string): RunPaths {
  const root = resolve(target);
  const wici = join(root, '.wici');
  const opt = join(root, '.opt');
  return {
    target: root,
    wici,
    inbox: join(wici, 'inbox'),
    inboxDone: join(wici, 'inbox', 'done'),
    outbox: join(wici, 'outbox'),
    artifacts: join(wici, 'artifacts'),
    checkpoints: join(wici, 'checkpoints'),
    events: join(wici, 'events.jsonl'),
    codexRun: join(wici, 'codex-run.jsonl'),
    goal: join(wici, 'goal.json'),
    checkpoint: join(wici, 'checkpoint.json'),
    lock: join(wici, '.lock'),
    plan: join(root, 'PLAN.md'),
    acceptanceSpec: join(root, 'acceptance.spec.json'),
    opt,
    measure: join(opt, 'measure.sh'),
    checks: join(opt, 'checks.sh'),
    prescreen: join(opt, 'prescreen.sh'),
    validate: join(opt, 'validate.sh'),
    selftestGoodPatch: join(opt, 'selftest-good.patch'),
    selftestBadPatch: join(opt, 'selftest-bad.patch'),
    baseline: join(root, 'baseline.json'),
    ledger: join(root, 'ledger.jsonl'),
    lessons: join(wici, 'lessons.jsonl'),
    context: join(wici, 'context.md'),
    goalInterrogations: join(wici, 'goal-interrogations.jsonl'),
    avenues: join(wici, 'avenues.json'),
    config: join(TOOL_ROOT, 'wici.config.json')
  };
}

export async function ensureRunDirs(paths: RunPaths): Promise<void> {
  await Promise.all([
    ensureDir(paths.wici),
    ensureDir(paths.inbox),
    ensureDir(paths.inboxDone),
    ensureDir(paths.outbox),
    ensureDir(paths.artifacts),
    ensureDir(paths.checkpoints),
    ensureDir(paths.opt)
  ]);
}

export async function ensureTargetGitignore(paths: RunPaths): Promise<void> {
  const gitDir = join(paths.target, '.git');
  if (!(await exists(gitDir))) return;

  const gitignore = join(paths.target, '.gitignore');
  const line = '.wici/';
  if (await exists(gitignore)) {
    const current = await readFile(gitignore, 'utf8');
    if (current.split('\n').includes(line)) return;
    const suffix = current.endsWith('\n') || current.length === 0 ? '' : '\n';
    await atomicWriteFile(gitignore, `${current}${suffix}${line}\n`);
  } else {
    await atomicWriteFile(gitignore, `${line}\n`);
  }
}

export function schemaPath(name: 'plan' | 'plan-diff' | 'iter-result'): string {
  const file =
    name === 'plan'
      ? 'plan.schema.json'
      : name === 'plan-diff'
        ? 'plan-diff.schema.json'
        : 'iter-result.schema.json';
  return join(TOOL_ROOT, 'schemas', file);
}

export function promptPath(name: 'planner' | 'planner-diff' | 'stop-verdict'): string {
  return join(TOOL_ROOT, 'prompts', `${name}.md`);
}
