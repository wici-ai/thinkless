import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { exists, readJsonFileMaybe, readJsonLines } from './atomic.js';
import { isNumberedSessionDirName, runPaths, type RunPaths } from './paths.js';
import type { Checkpoint, GoalFile, OutboxMessage, RunEvent } from './types.js';

const WORKSPACE_ROOT = join(homedir(), 'thinkless-workspaces');
const PLANNER_CLARIFY_REPLY_PREFIX = 'planner-clarify-';

export type ResumeCandidateStatus = 'runnable' | 'blocked';

export interface ResumeCandidate {
  id: string;
  target: string;
  sessionDir?: string;
  stateDir: string;
  label: string;
  goalSummary: string;
  updatedAt: string | null;
  supervisorState: Checkpoint['supervisor_state'] | 'NO_CHECKPOINT';
  hasChat: boolean;
  hasRuntimeSelection: boolean;
  hasGoal: boolean;
  hasGoalDoc: boolean;
  hasPlan: boolean;
  hasLedger: boolean;
  hasEvents: boolean;
  plannerSessionId?: string;
  executorSessionId?: string;
  executorAppThreadId?: string;
  bestCommit?: string | null;
  toolVersions?: Checkpoint['tool_versions'];
  runnable: boolean;
  status: ResumeCandidateStatus;
  reason: string;
  fallback?: 'planner_rerun' | 'executor_rerun';
}

export interface ResumeContext {
  candidate: ResumeCandidate;
  paths: RunPaths;
  goal: GoalFile | null;
  checkpoint: Checkpoint | null;
  events: RunEvent[];
}

export async function discoverResumeCandidates(options: { currentTarget?: string; workspaceRoot?: string; limit?: number } = {}): Promise<ResumeCandidate[]> {
  const roots = await discoverTargetRoots(options.currentTarget, options.workspaceRoot ?? WORKSPACE_ROOT);
  const candidates: ResumeCandidate[] = [];
  for (const target of roots) {
    candidates.push(...await candidatesForTarget(target));
  }
  return dedupeCandidates(candidates)
    .sort((a, b) => Date.parse(b.updatedAt ?? '0') - Date.parse(a.updatedAt ?? '0'))
    .slice(0, options.limit ?? 20);
}

export async function loadResumeContext(candidate: Pick<ResumeCandidate, 'target' | 'sessionDir'>): Promise<ResumeContext> {
  const paths = runPaths(candidate.target, candidate.sessionDir);
  const [goal, checkpoint, events] = await Promise.all([
    readJsonFileMaybe<GoalFile>(paths.goal),
    readJsonFileMaybe<Checkpoint>(paths.checkpoint),
    readJsonLines<RunEvent>(paths.events)
  ]);
  return {
    candidate: await candidateFromPaths(paths, candidate.sessionDir),
    paths,
    goal,
    checkpoint,
    events
  };
}

export async function preflightResumeCandidate(target: string, sessionDir?: string): Promise<ResumeCandidate> {
  return candidateFromPaths(runPaths(target, sessionDir), sessionDir);
}

async function discoverTargetRoots(currentTarget?: string, workspaceRoot = WORKSPACE_ROOT): Promise<string[]> {
  const roots = new Set<string>();
  if (currentTarget) roots.add(resolve(currentTarget));
  for (const target of await readWorkspaceTargets(workspaceRoot)) roots.add(target);
  return [...roots];
}

async function readWorkspaceTargets(workspaceRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(workspaceRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => resolve(workspaceRoot, entry.name));
  } catch {
    return [];
  }
}

async function candidatesForTarget(target: string): Promise<ResumeCandidate[]> {
  const root = resolve(target);
  const candidates: ResumeCandidate[] = [];
  candidates.push(await candidateFromPaths(runPaths(root, join(root, '.thinkless')), join(root, '.thinkless')));
  for (const sessionDir of await numberedSessionDirs(root)) {
    candidates.push(await candidateFromPaths(runPaths(root, sessionDir), sessionDir));
  }
  const legacy = join(root, '.wici');
  if (await hasStateDir(legacy)) candidates.push(await candidateFromPaths(runPaths(root, legacy), legacy));
  return candidates.filter((candidate) => candidate.hasGoal || candidate.hasChat || candidate.hasEvents || candidate.hasRuntimeSelection);
}

async function numberedSessionDirs(target: string): Promise<string[]> {
  try {
    const entries = await readdir(target, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && isNumberedSessionDirName(entry.name))
      .map((entry) => join(target, entry.name));
  } catch {
    return [];
  }
}

async function candidateFromPaths(paths: RunPaths, sessionDir?: string): Promise<ResumeCandidate> {
  const [goal, checkpoint, goalDoc, plan, ledger, chat, runtimeSelection, events, outbox, plannerTranscript, executorTranscript] = await Promise.all([
    readJsonFileMaybe<GoalFile>(paths.goal),
    readJsonFileMaybe<Checkpoint>(paths.checkpoint),
    exists(paths.goalDoc),
    exists(paths.plan),
    exists(paths.ledger),
    exists(paths.chat),
    exists(paths.runtimeSelection),
    exists(paths.events),
    readOutbox(paths.outbox),
    hasPlannerTranscript(paths.artifacts),
    hasNonEmptyFile(paths.codexRun)
  ]);
  const updatedAt = await latestUpdatedAt([paths.checkpoint, paths.events, paths.chat, paths.goal, paths.plan, paths.goalDoc]);
  const preflight = buildPreflight({ paths, goal, checkpoint, goalDoc, plan, ledger, events, outbox, plannerTranscript, executorTranscript });
  const label = sessionDir ? `${basename(paths.target)} ${basename(sessionDir)}` : basename(paths.target);
  return {
    id: `${paths.target}::${sessionDir ?? paths.stateDir}`,
    target: paths.target,
    sessionDir,
    stateDir: paths.stateDir,
    label,
    goalSummary: goal ? summarizeGoal(goal) : await summarizeGoalDoc(paths.goalDoc),
    updatedAt: checkpoint?.updated_at ?? updatedAt,
    supervisorState: checkpoint?.supervisor_state ?? 'NO_CHECKPOINT',
    hasChat: chat,
    hasRuntimeSelection: runtimeSelection,
    hasGoal: Boolean(goal),
    hasGoalDoc: goalDoc,
    hasPlan: plan,
    hasLedger: ledger,
    hasEvents: events,
    plannerSessionId: checkpoint?.sessions.planner,
    executorSessionId: checkpoint?.sessions.executor,
    executorAppThreadId: checkpoint?.sessions.executorApp?.threadId,
    bestCommit: checkpoint?.best_commit,
    toolVersions: checkpoint?.tool_versions,
    ...preflight
  };
}

function buildPreflight(input: {
  paths: RunPaths;
  goal: GoalFile | null;
  checkpoint: Checkpoint | null;
  goalDoc: boolean;
  plan: boolean;
  ledger: boolean;
  events: boolean;
  outbox: OutboxMessage[];
  plannerTranscript: boolean;
  executorTranscript: boolean;
}): Pick<ResumeCandidate, 'runnable' | 'status' | 'reason' | 'fallback'> {
  const { goal, checkpoint } = input;
  if (!goal && (input.events || input.outbox.length > 0 || input.ledger)) return blocked('missing durable GOAL context');
  if (!goal && !checkpoint) return blocked('chat/runtime only; no supervisor run context');
  if (!checkpoint) return blocked('missing checkpoint context');
  if (!input.goalDoc) return blocked('missing GOAL.md context');
  if (checkpoint.supervisor_state === 'FAILED') return blocked('failed run requires manual inspection');
  if (checkpoint.supervisor_state === 'STOP') return runnable('stopped run can be explicitly resumed');
  if (checkpoint.supervisor_state === 'PLAN') {
    const pendingPlannerQuestion = input.outbox.some((message) => message.kind === 'question' && !message.answered && message.reply_key?.startsWith(PLANNER_CLARIFY_REPLY_PREFIX));
    if (pendingPlannerQuestion && !checkpoint.sessions.planner) return blocked('planner clarification is pending but no planner session was persisted');
    if (checkpoint.sessions.planner) {
      if (!input.plannerTranscript) return blocked('planner session is missing durable transcript state');
      return runnable('planner session is available for continuation');
    }
    return input.goalDoc ? runnable('planner can rerun from durable GOAL.md state', 'planner_rerun') : blocked('planner cannot rerun without GOAL.md');
  }
  if (checkpoint.supervisor_state === 'EXECUTE' || checkpoint.supervisor_state === 'REFLECT') {
    if (!input.plan) return blocked('executor resume needs PLAN.md');
    if (checkpoint.sessions.executor || checkpoint.sessions.executorApp?.threadId) {
      if (!input.executorTranscript) return blocked('executor session is missing durable transcript state');
      return runnable('executor session is available for continuation');
    }
    if (checkpoint.next_step || input.ledger) return runnable('executor can replay from checkpointed PLAN/ledger state', 'executor_rerun');
    return blocked('executor has no session and no replayable PLAN step');
  }
  if (!input.plan && checkpoint.supervisor_state !== 'INTAKE') return blocked('missing PLAN.md context');
  return runnable('supervisor state can be resumed from durable context');
}

function runnable(reason: string, fallback?: ResumeCandidate['fallback']): Pick<ResumeCandidate, 'runnable' | 'status' | 'reason' | 'fallback'> {
  return { runnable: true, status: 'runnable', reason, fallback };
}

function blocked(reason: string): Pick<ResumeCandidate, 'runnable' | 'status' | 'reason' | 'fallback'> {
  return { runnable: false, status: 'blocked', reason };
}

async function readOutbox(path: string): Promise<OutboxMessage[]> {
  try {
    const names = (await readdir(path)).filter((name) => /^out-.+\.json$/.test(name)).sort();
    const messages = await Promise.all(names.map((name) => readJsonFileMaybe<OutboxMessage>(join(path, name))));
    return messages.filter((message): message is OutboxMessage => Boolean(message));
  } catch {
    return [];
  }
}

async function hasPlannerTranscript(path: string): Promise<boolean> {
  try {
    const names = await readdir(path);
    return names.some((name) => /^planner-.+\.stdout\.jsonl$/.test(name));
  } catch {
    return false;
  }
}

async function hasNonEmptyFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function hasStateDir(path: string): Promise<boolean> {
  return (await exists(join(path, 'goal.json'))) || (await exists(join(path, 'checkpoint.json'))) || (await exists(join(path, 'chat.jsonl'))) || (await exists(join(path, 'events.jsonl')));
}

async function latestUpdatedAt(paths: string[]): Promise<string | null> {
  const stats = await Promise.all(paths.map(async (path) => {
    try {
      return await stat(path);
    } catch {
      return null;
    }
  }));
  const latest = stats.filter((item): item is NonNullable<typeof item> => Boolean(item)).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return latest ? new Date(latest.mtimeMs).toISOString() : null;
}

function summarizeGoal(goal: GoalFile): string {
  const active = goal.requirements.find((requirement) => requirement.status === 'active') ?? goal.requirements[0];
  return active?.text?.trim() || `run ${goal.run_id}`;
}

async function summarizeGoalDoc(path: string): Promise<string> {
  try {
    const raw = await readFile(path, 'utf8');
    return raw.split('\n').find((line) => line.trim() && !line.startsWith('#'))?.trim() ?? '(no goal summary)';
  } catch {
    return '(no goal summary)';
  }
}

function dedupeCandidates(candidates: ResumeCandidate[]): ResumeCandidate[] {
  const seen = new Set<string>();
  const output: ResumeCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.target}::${candidate.stateDir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(candidate);
  }
  return output;
}
