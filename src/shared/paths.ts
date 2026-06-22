import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { atomicWriteFile, ensureDir, exists } from './atomic.js';

const thisFile = fileURLToPath(import.meta.url);
const THINKLESS_STATE_DIR = '.thinkless';
const LEGACY_STATE_DIR = '.wici';

export const SRC_ROOT = resolve(dirname(thisFile), '..');
const candidateToolRoot = resolve(SRC_ROOT, '..');
export const TOOL_ROOT = existsSync(join(candidateToolRoot, 'package.json')) ? candidateToolRoot : resolve(candidateToolRoot, '..');

export interface RunPaths {
  target: string;
  stateDir: string;
  legacyStateDir: string;
  wici: string;
  inbox: string;
  inboxDone: string;
  urgentSentinel: string;
  outbox: string;
  artifacts: string;
  checkpoints: string;
  skills: string;
  curriculum: string;
  events: string;
  supervisorLog: string;
  codexRun: string;
  chat: string;
  chatSession: string;
  runtimeSelection: string;
  goal: string;
  goalDoc: string;
  checkpoint: string;
  lock: string;
  plan: string;
  assumptions: string;
  acceptanceSpec: string;
  opt: string;
  measure: string;
  checks: string;
  benchmarkManifest: string;
  prescreen: string;
  validate: string;
  selftestGoodPatch: string;
  selftestBadPatch: string;
  baseline: string;
  ledger: string;
  lessons: string;
  skillsIndex: string;
  context: string;
  goalInterrogations: string;
  archive: string;
  config: string;
}

export function runPaths(target: string): RunPaths {
  const root = resolve(target);
  const stateDir = resolveStateDir(root);
  const legacyStateDir = join(root, LEGACY_STATE_DIR);
  const opt = join(root, '.opt');
  return {
    target: root,
    stateDir,
    legacyStateDir,
    wici: stateDir,
    inbox: join(stateDir, 'inbox'),
    inboxDone: join(stateDir, 'inbox', 'done'),
    urgentSentinel: join(stateDir, 'inbox', 'URGENT'),
    outbox: join(stateDir, 'outbox'),
    artifacts: join(stateDir, 'artifacts'),
    checkpoints: join(stateDir, 'checkpoints'),
    skills: join(stateDir, 'skills'),
    curriculum: join(stateDir, 'curriculum.jsonl'),
    events: join(stateDir, 'events.jsonl'),
    supervisorLog: join(stateDir, 'supervisor.log'),
    codexRun: join(stateDir, 'codex-run.jsonl'),
    chat: join(stateDir, 'chat.jsonl'),
    chatSession: join(stateDir, 'chat-session.json'),
    runtimeSelection: join(stateDir, 'runtime-selection.json'),
    goal: join(stateDir, 'goal.json'),
    goalDoc: join(root, 'GOAL.md'),
    checkpoint: join(stateDir, 'checkpoint.json'),
    lock: join(stateDir, '.lock'),
    plan: join(root, 'PLAN.md'),
    assumptions: join(root, 'ASSUMPTIONS.md'),
    acceptanceSpec: join(root, 'acceptance.spec.json'),
    opt,
    measure: join(opt, 'measure.sh'),
    checks: join(opt, 'checks.sh'),
    benchmarkManifest: join(opt, 'benchmark.json'),
    prescreen: join(opt, 'prescreen.sh'),
    validate: join(opt, 'validate.sh'),
    selftestGoodPatch: join(opt, 'selftest-good.patch'),
    selftestBadPatch: join(opt, 'selftest-bad.patch'),
    baseline: join(root, 'baseline.json'),
    ledger: join(root, 'ledger.jsonl'),
    lessons: join(stateDir, 'lessons.jsonl'),
    skillsIndex: join(stateDir, 'skills.json'),
    context: join(stateDir, 'context.md'),
    goalInterrogations: join(stateDir, 'goal-interrogations.jsonl'),
    archive: join(stateDir, 'archive.json'),
    config: join(TOOL_ROOT, 'wici.config.json')
  };
}

function resolveStateDir(root: string): string {
  const thinkless = join(root, THINKLESS_STATE_DIR);
  if (existsSync(thinkless)) return thinkless;
  const legacy = join(root, LEGACY_STATE_DIR);
  if (existsSync(legacy)) return legacy;
  return thinkless;
}

export async function ensureRunDirs(paths: RunPaths): Promise<void> {
  await Promise.all([
    ensureDir(paths.wici),
    ensureDir(paths.inbox),
    ensureDir(paths.inboxDone),
    ensureDir(paths.outbox),
    ensureDir(paths.artifacts),
    ensureDir(paths.checkpoints),
    ensureDir(paths.skills),
    ensureDir(paths.opt)
  ]);
}

export async function ensureTargetGitignore(paths: RunPaths): Promise<void> {
  const gitDir = join(paths.target, '.git');
  if (!(await exists(gitDir))) return;

  const gitignore = join(paths.target, '.gitignore');
  const lines = ['.thinkless/', '.wici/'];
  if (await exists(gitignore)) {
    const current = await readFile(gitignore, 'utf8');
    const currentLines = new Set(current.split('\n'));
    const missing = lines.filter((line) => !currentLines.has(line));
    if (missing.length === 0) return;
    const suffix = current.endsWith('\n') || current.length === 0 ? '' : '\n';
    await atomicWriteFile(gitignore, `${current}${suffix}${missing.join('\n')}\n`);
  } else {
    await atomicWriteFile(gitignore, `${lines.join('\n')}\n`);
  }
}

export function schemaPath(name: 'iter-result'): string {
  return join(TOOL_ROOT, 'schemas', `${name}.schema.json`);
}

export function promptPath(name: 'planner' | 'planner-diff' | 'stop-verdict' | 'continue-verdict' | 'chat'): string {
  return join(TOOL_ROOT, 'prompts', `${name}.md`);
}
