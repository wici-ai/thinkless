import { readFile } from 'node:fs/promises';
import { appendJsonLine, exists, readJsonLines } from '../shared/atomic.js';
import type { GoalFile, GoalInterrogationEntry, LedgerEntry } from '../shared/types.js';
import type { RunPaths } from '../shared/paths.js';
import { isPlannerSelectedMetricName, primaryMetricValue } from './metricFormat.js';

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

  const validationChecks = await readPlannerValidationChecks(paths, goal);
  const entry = buildGoalInterrogation(goal, ledger, iter, validationChecks);
  await appendJsonLine(paths.goalInterrogations, entry);
  return entry;
}

export function markSatisfiedPrimaryRequirements(goal: GoalFile, ledger: LedgerEntry[]): GoalFile | null {
  if (!isGoalTargetMet(goal, ledger)) return null;
  let changed = false;
  const requirements = goal.requirements.map((requirement) => {
    if ((requirement.kind ?? 'primary') !== 'primary' || requirement.status !== 'active') return requirement;
    changed = true;
    return { ...requirement, status: 'done' as const };
  });
  return changed ? { ...goal, version: goal.version + 1, requirements } : null;
}

export async function readGoalInterrogations(paths: RunPaths): Promise<GoalInterrogationEntry[]> {
  return readJsonLines<GoalInterrogationEntry>(paths.goalInterrogations);
}

export async function readLatestGoalInterrogation(paths: RunPaths): Promise<GoalInterrogationEntry | null> {
  const entries = await readGoalInterrogations(paths);
  return entries.at(-1) ?? null;
}

async function readPlannerValidationChecks(paths: RunPaths, goal: GoalFile): Promise<string[]> {
  const acceptance = goal.acceptance_criteria.map((item) => `${item.id}: ${item.check}`);
  if (acceptance.length > 0) return acceptance;
  const checks: string[] = [];
  if (await exists(paths.checks)) checks.push('planner artifact: ./.opt/checks.sh');
  if (await exists(paths.measure)) checks.push('planner artifact: ./.opt/measure.sh');
  if (checks.length > 0) return checks;
  if (await exists(paths.plan)) {
    const plan = await readFile(paths.plan, 'utf8');
    if (/validation|verify|test|check|measure|验收|验证/i.test(plan)) checks.push('PLAN.md: planner-defined validation');
  }
  return checks;
}

function buildGoalInterrogation(goal: GoalFile, ledger: LedgerEntry[], iter: number, validationChecks: string[]): GoalInterrogationEntry {
  const active = goal.requirements.filter((req) => req.status === 'active');
  const recent = ledger.slice(-goalInterrogationPeriod(goal));
  const latest = ledger.at(-1) ?? null;
  const concerns = goalConcerns(active, recent, validationChecks);
  return {
    id: `goal-check-${iter}-v${goal.version}`,
    ts: new Date().toISOString(),
    iter,
    goal_version: goal.version,
    restated_goal: restateGoal(goal, active),
    active_requirement_ids: active.map((req) => req.id),
    acceptance_checks: validationChecks,
    latest_ledger_id: latest?.id ?? null,
    recent_statuses: recent.map((entry) => entry.status),
    aligned: !concerns.some((item) => item.startsWith('drift:')),
    concerns
  };
}

function restateGoal(goal: GoalFile, active: GoalFile['requirements']): string {
  const requirements = active.map((req) => req.text).join(' ');
  if (isPlannerSelectedMetricName(goal.metric.name)) {
    return `Satisfy active GOAL.md requirements using PLAN.md's planner-defined validation: ${requirements}`;
  }
  const target = goal.metric.target === null || goal.metric.target === undefined ? 'without a fixed numeric target' : `toward ${goal.metric.target}${goal.metric.unit ?? ''}`;
  return `Optimize ${goal.metric.name} (${goal.metric.direction}) ${target} while satisfying active requirements: ${requirements}`;
}

function goalConcerns(active: GoalFile['requirements'], recent: LedgerEntry[], validationChecks: string[]): string[] {
  const concerns: string[] = [];
  if (active.length === 0) concerns.push('drift: GOAL.md has no active requirements');
  if (validationChecks.length === 0) concerns.push('drift: PLAN.md has no visible validation signal');
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

function isGoalTargetMet(goal: GoalFile, ledger: LedgerEntry[]): boolean {
  const metric = [...ledger].reverse().find((entry) => entry.status === 'keep' && entry.metric)?.metric;
  if (!metric || goal.metric.target === undefined || goal.metric.target === null) return false;
  const value = primaryMetricValue(metric);
  return goal.metric.direction === 'minimize' ? value <= goal.metric.target : value >= goal.metric.target;
}
