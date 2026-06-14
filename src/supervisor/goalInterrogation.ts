import { appendJsonLine, readJsonLines } from '../shared/atomic.js';
import type { GoalFile, GoalInterrogationEntry, LedgerEntry } from '../shared/types.js';
import type { RunPaths } from '../shared/paths.js';

export function goalInterrogationPeriod(goal: GoalFile): number {
  return Math.max(2, goal.stop.N || 0);
}

export async function maybeInterrogateGoal(paths: RunPaths, goal: GoalFile, ledger: LedgerEntry[]): Promise<GoalInterrogationEntry | null> {
  if (ledger.length === 0) return null;
  const period = goalInterrogationPeriod(goal);
  const iter = ledger[ledger.length - 1]?.iter ?? 0;
  if (iter <= 0 || iter % period !== 0) return null;

  const existing = await readGoalInterrogations(paths);
  if (existing.some((entry) => entry.iter === iter && entry.goal_version === goal.version)) return null;

  const entry = buildGoalInterrogation(goal, ledger, iter);
  await appendJsonLine(paths.goalInterrogations, entry);
  return entry;
}

export async function readGoalInterrogations(paths: RunPaths): Promise<GoalInterrogationEntry[]> {
  return readJsonLines<GoalInterrogationEntry>(paths.goalInterrogations);
}

export async function readLatestGoalInterrogation(paths: RunPaths): Promise<GoalInterrogationEntry | null> {
  const entries = await readGoalInterrogations(paths);
  return entries.at(-1) ?? null;
}

function buildGoalInterrogation(goal: GoalFile, ledger: LedgerEntry[], iter: number): GoalInterrogationEntry {
  const active = goal.requirements.filter((req) => req.status === 'active');
  const recent = ledger.slice(-goalInterrogationPeriod(goal));
  const latest = ledger.at(-1) ?? null;
  const concerns = goalConcerns(goal, active, recent);
  return {
    id: `goal-check-${iter}-v${goal.version}`,
    ts: new Date().toISOString(),
    iter,
    goal_version: goal.version,
    restated_goal: restateGoal(goal, active),
    active_requirement_ids: active.map((req) => req.id),
    acceptance_checks: goal.acceptance_criteria.map((item) => `${item.id}: ${item.check}`),
    latest_ledger_id: latest?.id ?? null,
    recent_statuses: recent.map((entry) => entry.status),
    aligned: !concerns.some((item) => item.startsWith('drift:')),
    concerns
  };
}

function restateGoal(goal: GoalFile, active: GoalFile['requirements']): string {
  const requirements = active.map((req) => req.text).join(' ');
  const target = goal.metric.target === null || goal.metric.target === undefined ? 'without a fixed numeric target' : `toward ${goal.metric.target}${goal.metric.unit ?? ''}`;
  return `Optimize ${goal.metric.name} (${goal.metric.direction}) ${target} while satisfying active requirements: ${requirements}`;
}

function goalConcerns(goal: GoalFile, active: GoalFile['requirements'], recent: LedgerEntry[]): string[] {
  const concerns: string[] = [];
  if (active.length === 0) concerns.push('drift: goal.json has no active requirements');
  if (goal.acceptance_criteria.length === 0) concerns.push('drift: goal.json has no acceptance criteria');
  if (recent.length > 0 && recent.every((entry) => entry.status !== 'keep')) {
    concerns.push('progress: no accepted improvement in the latest interrogation window');
  }
  if (recent.some((entry) => entry.status === 'checks_failed' || entry.status === 'crash')) {
    concerns.push('safety: recent execution hit correctness or crash failures');
  }
  if (recent.some((entry) => String(entry.guards.reason ?? '').toLowerCase().includes('heldout'))) {
    concerns.push('safety: recent public attempt was rejected by hidden validation; do not optimize against hidden details');
  }
  return concerns;
}
