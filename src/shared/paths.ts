import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { atomicWriteFile, ensureDir, exists } from './atomic.js';

const thisFile = fileURLToPath(import.meta.url);
const THINKLESS_STATE_DIR = '.thinkless';
const LEGACY_STATE_DIR = '.wici';
const NUMBERED_SESSION_RE = /^\.thinkless([1-9]\d*)$/;

export const THINKLESS_SESSION_DIR_ENV = 'THINKLESS_SESSION_DIR';

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
  const fileRoot = sessionFileRoot(root, stateDir);
  const legacyStateDir = join(root, LEGACY_STATE_DIR);
  const opt = join(fileRoot, '.opt');
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
    goalDoc: join(fileRoot, 'GOAL.md'),
    checkpoint: join(stateDir, 'checkpoint.json'),
    lock: join(stateDir, '.lock'),
    plan: join(fileRoot, 'PLAN.md'),
    assumptions: join(fileRoot, 'ASSUMPTIONS.md'),
    acceptanceSpec: join(fileRoot, 'acceptance.spec.json'),
    opt,
    measure: join(opt, 'measure.sh'),
    checks: join(opt, 'checks.sh'),
    benchmarkManifest: join(opt, 'benchmark.json'),
    prescreen: join(opt, 'prescreen.sh'),
    validate: join(opt, 'validate.sh'),
    selftestGoodPatch: join(opt, 'selftest-good.patch'),
    selftestBadPatch: join(opt, 'selftest-bad.patch'),
    baseline: join(fileRoot, 'baseline.json'),
    ledger: join(fileRoot, 'ledger.jsonl'),
    lessons: join(stateDir, 'lessons.jsonl'),
    skillsIndex: join(stateDir, 'skills.json'),
    context: join(stateDir, 'context.md'),
    goalInterrogations: join(stateDir, 'goal-interrogations.jsonl'),
    archive: join(stateDir, 'archive.json'),
    config: join(TOOL_ROOT, 'wici.config.json')
  };
}

function resolveStateDir(root: string): string {
  const sessionOverride = sessionDirOverride(root);
  if (sessionOverride) return sessionOverride;
  const numbered = latestNumberedSessionDir(root);
  if (numbered) return numbered;
  const thinkless = join(root, THINKLESS_STATE_DIR);
  if (existsSync(thinkless)) return thinkless;
  const legacy = join(root, LEGACY_STATE_DIR);
  if (hasRunState(legacy)) return legacy;
  return thinkless;
}

export function allocateNumberedSessionDir(target: string): string {
  const root = resolve(target);
  mkdirSync(root, { recursive: true });
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = join(root, `.thinkless${index}`);
    try {
      mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error(`Could not allocate a Thinkless session directory under ${root}`);
}

export function latestNumberedSessionDir(target: string): string | null {
  const root = resolve(target);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const match = NUMBERED_SESSION_RE.exec(entry.name);
      return match ? { dir: join(root, entry.name), index: Number(match[1]) } : null;
    })
    .filter((entry): entry is { dir: string; index: number } => Boolean(entry))
    .filter((entry) => hasSessionState(entry.dir))
    .sort((a, b) => b.index - a.index);
  return candidates[0]?.dir ?? null;
}

export function isNumberedSessionDirName(name: string): boolean {
  return NUMBERED_SESSION_RE.test(name);
}

function sessionDirOverride(root: string): string | null {
  const raw = process.env[THINKLESS_SESSION_DIR_ENV]?.trim();
  return raw ? resolve(root, raw) : null;
}

function sessionFileRoot(root: string, stateDir: string): string {
  if (sessionDirOverride(root)) return stateDir;
  return isNumberedSessionDirName(basename(stateDir)) ? stateDir : root;
}

function hasRunState(stateDir: string): boolean {
  return existsSync(join(stateDir, 'goal.json')) || existsSync(join(stateDir, 'checkpoint.json'));
}

function hasSessionState(stateDir: string): boolean {
  return hasRunState(stateDir) || existsSync(join(stateDir, 'chat.jsonl')) || existsSync(join(stateDir, 'events.jsonl')) || existsSync(join(stateDir, 'runtime-selection.json'));
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
  const lines = ['.thinkless/', '.thinkless*/', '.wici/'];
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
