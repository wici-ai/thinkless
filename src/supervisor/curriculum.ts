import { appendJsonLine, readJsonLines } from '../shared/atomic.js';
import type { CurriculumEntry, GoalFile } from '../shared/types.js';
import type { RunPaths } from '../shared/paths.js';

export interface CurriculumInput {
  iter: number;
  stepId: string;
  stuckReason: string;
  attempts: number;
  consecutiveFailures: number;
  parentId: string | null;
}

export async function appendCurriculumSubgoal(paths: RunPaths, goal: GoalFile, input: CurriculumInput): Promise<CurriculumEntry> {
  const entries = await readCurriculum(paths);
  const existing = entries.find(
    (entry) =>
      entry.iter === input.iter &&
      entry.goal_version === goal.version &&
      entry.saturated_step_id === input.stepId &&
      entry.parent_ledger_id === input.parentId
  );
  if (existing) return existing;

  const entry: CurriculumEntry = {
    id: `curriculum-${input.iter}-${safeId(input.stepId)}`,
    ts: new Date().toISOString(),
    iter: input.iter,
    goal_version: goal.version,
    parent_ledger_id: input.parentId,
    saturated_step_id: input.stepId,
    branch_reason: singleLine(input.stuckReason),
    stuck_reason: singleLine(input.stuckReason),
    attempts: input.attempts,
    consecutive_failures: input.consecutiveFailures,
    sub_goal: buildSubGoal(goal, input),
    status: 'applied'
  };
  await appendJsonLine(paths.curriculum, entry);
  return entry;
}

export async function readCurriculum(paths: RunPaths): Promise<CurriculumEntry[]> {
  return readJsonLines<CurriculumEntry>(paths.curriculum);
}

export async function readLatestCurriculumSubgoal(paths: RunPaths): Promise<CurriculumEntry | null> {
  const entries = await readCurriculum(paths);
  return entries.at(-1) ?? null;
}

function buildSubGoal(goal: GoalFile, input: CurriculumInput): string {
  const parent = input.parentId ? `from parent ${input.parentId}` : 'from the current checkpoint';
  const target =
    goal.metric.target === null || goal.metric.target === undefined
      ? ''
      : ` toward ${goal.metric.target}${goal.metric.unit ?? ''}`;
  return `Ask the planner for one bounded continuation ${parent} for ${input.stepId}: isolate the saturated attempt (${singleLine(input.stuckReason)}) into a smaller PLAN.md change, preserve user-facing GOAL.md requirements, and only continue if the planner-selected validation in PLAN.md still supports the active goal${target}.`;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
