import { atomicWriteFile, atomicWriteJson, exists } from '../shared/atomic.js';
import type { RunPaths } from '../shared/paths.js';
import type { GoalFile } from '../shared/types.js';

export async function saveGoalFiles(paths: RunPaths, goal: GoalFile): Promise<void> {
  await atomicWriteJson(paths.goal, goal);
  await atomicWriteFile(paths.goalDoc, renderGoalMarkdown(goal));
}

export async function ensureGoalDoc(paths: RunPaths, goal: GoalFile): Promise<void> {
  if (await exists(paths.goalDoc)) return;
  await atomicWriteFile(paths.goalDoc, renderGoalMarkdown(goal));
}

export function renderGoalMarkdown(goal: GoalFile): string {
  return `${[
    '# GOAL',
    '',
    `Version: v${goal.version}`,
    `Run: ${goal.run_id}`,
    '',
    '## Requirements',
    ...goal.requirements.map((req) => `- [${req.status}] ${req.id}: ${req.text}`),
    '',
    '## Acceptance Criteria',
    ...goal.acceptance_criteria.map((criterion) => `- ${criterion.id}: ${criterion.text}\n  - Check: \`${criterion.check}\``),
    '',
    '## Metric',
    `- Name: ${goal.metric.name}`,
    `- Direction: ${goal.metric.direction}`,
    `- Target: ${goal.metric.target === null || goal.metric.target === undefined ? 'none' : `${goal.metric.target}${goal.metric.unit ?? ''}`}`,
    '',
    '## Constraints',
    ...(goal.constraints.length > 0 ? goal.constraints.map((constraint) => `- ${constraint}`) : ['- none']),
    '',
    '## Notes',
    '- This markdown goal is the user-facing contract for the run.',
    '- WiCi keeps .wici/goal.json only as internal derived state for durable execution.',
    '- Deployment, SSH, model discovery, benchmark setup, and validation belong in PLAN.md and locked .opt scripts, then Codex executes them inside the loop.'
  ].join('\n')}\n`;
}
