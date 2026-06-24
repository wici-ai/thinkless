import { atomicWriteFile, atomicWriteJson, exists } from '../shared/atomic.js';
import type { RunPaths } from '../shared/paths.js';
import type { GoalFile } from '../shared/types.js';
import { isPlannerSelectedMetricName } from './metricFormat.js';

export async function saveGoalFiles(paths: RunPaths, goal: GoalFile): Promise<void> {
  await atomicWriteJson(paths.goal, goal);
  await atomicWriteFile(paths.goalDoc, renderGoalMarkdown(goal));
}

export async function ensureGoalDoc(paths: RunPaths, goal: GoalFile): Promise<void> {
  if (await exists(paths.goalDoc)) return;
  await atomicWriteFile(paths.goalDoc, renderGoalMarkdown(goal));
}

export function renderGoalMarkdown(goal: GoalFile): string {
  const plannerSelected = isPlannerSelectedMetricName(goal.metric.name);
  const acceptanceLines =
    goal.acceptance_criteria.length > 0
      ? [
          '',
          '## Acceptance Criteria',
          ...goal.acceptance_criteria.map((criterion) => `- ${criterion.id}: ${criterion.text}\n  - Check: \`${criterion.check}\``)
        ]
      : [];
  return `${[
    '# GOAL',
    '',
    `Version: v${goal.version}`,
    `Run: ${goal.run_id}`,
    '',
    '## Primary',
    ...renderRequirements(goal.requirements.filter((req) => (req.kind ?? 'primary') === 'primary')),
    '',
    '## Stretch',
    ...renderRequirements(goal.requirements.filter((req) => req.kind === 'stretch')),
    ...acceptanceLines,
    '',
    '## Validation',
    ...(plannerSelected
      ? [
          '- Planner chooses the concrete validation method in PLAN.md.',
          '- Optional scripts are planner artifacts, not a supervisor pre-execution gate.',
          '- Codex executes PLAN.md and reports whether the active requirement is met.'
        ]
      : [
          `- Name: ${goal.metric.name}`,
          `- Direction: ${goal.metric.direction}`,
          `- Target: ${goal.metric.target === null || goal.metric.target === undefined ? 'none' : `${goal.metric.target}${goal.metric.unit ?? ''}`}`
        ]),
    '',
    '## Constraints',
    ...(goal.constraints.length > 0 ? goal.constraints.map(renderConstraintMarkdown) : ['- none']),
    '',
    '## Notes',
    '- This markdown goal is the user-facing contract for the run.',
    '- WiCi keeps .wici/goal.json only as internal derived state for durable execution.',
    '- Deployment, SSH, model discovery, benchmark setup, and validation belong in PLAN.md and optional .opt scripts, then Codex executes them inside the loop.'
  ].join('\n')}\n`;
}

function renderRequirements(requirements: GoalFile['requirements']): string[] {
  if (requirements.length === 0) return ['- none'];
  return requirements.map((req) => {
    const stopWhen = req.stop_when ? ` (stop-when: ${req.stop_when})` : '';
    return `- [${req.status}] ${req.id}${stopWhen}: ${req.text}`;
  });
}

function renderConstraintMarkdown(constraint: string): string {
  const lines = constraint.replace(/\r\n/g, '\n').split('\n');
  const [first = '', ...rest] = lines;
  return [`- ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
}
