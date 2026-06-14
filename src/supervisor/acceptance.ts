import { atomicWriteJson, exists, readJsonFile } from '../shared/atomic.js';
import type { RunPaths } from '../shared/paths.js';
import type { AcceptanceSpec, GoalFile } from '../shared/types.js';

export const ACCEPTANCE_CLARIFY_REPLY_KEY = 'acceptance-spec';

export interface AcceptanceSpecStatus {
  ok: boolean;
  reason?: string;
  spec?: AcceptanceSpec;
  created?: boolean;
}

export async function ensureAcceptanceSpec(paths: RunPaths, goal: GoalFile): Promise<AcceptanceSpecStatus> {
  const clarification = acceptanceClarificationReason(goal);
  if (clarification) return { ok: false, reason: clarification };

  if (await exists(paths.acceptanceSpec)) {
    return { ok: true, spec: await readAcceptanceSpec(paths), created: false };
  }

  const spec = buildAcceptanceSpec(goal);
  await atomicWriteJson(paths.acceptanceSpec, spec);
  return { ok: true, spec, created: true };
}

export async function readAcceptanceSpec(paths: RunPaths): Promise<AcceptanceSpec> {
  const spec = await readJsonFile<AcceptanceSpec>(paths.acceptanceSpec);
  validateAcceptanceSpecShape(spec);
  return spec;
}

export async function verifyAcceptanceSpec(paths: RunPaths, goal: GoalFile): Promise<AcceptanceSpec> {
  const spec = await readAcceptanceSpec(paths);
  if (spec.version !== 1) throw new Error(`Unsupported acceptance spec version: ${spec.version}`);
  if (spec.run_id !== goal.run_id) {
    throw new Error(`acceptance.spec.json run_id mismatch: expected ${goal.run_id}, got ${spec.run_id}`);
  }
  if (spec.criteria.length === 0) throw new Error('acceptance.spec.json has no criteria');
  for (const criterion of spec.criteria) {
    if (!criterion.id || !criterion.text || !criterion.check) {
      throw new Error(`acceptance.spec.json contains an incomplete criterion: ${JSON.stringify(criterion)}`);
    }
  }
  return spec;
}

export function formatAcceptanceSpecForPrompt(spec: AcceptanceSpec): string {
  return [
    'Frozen acceptance spec (authoritative; re-read from acceptance.spec.json this iteration):',
    `- frozen_goal_version: ${spec.frozen_goal_version}`,
    `- metric: ${spec.metric.name} ${spec.metric.direction}${spec.metric.target === null || spec.metric.target === undefined ? '' : ` target=${spec.metric.target}${spec.metric.unit ?? ''}`}`,
    ...spec.criteria.map((criterion) => `- ${criterion.id}: ${criterion.text} | check: ${criterion.check}`)
  ].join('\n');
}

function buildAcceptanceSpec(goal: GoalFile): AcceptanceSpec {
  return {
    version: 1,
    run_id: goal.run_id,
    frozen_goal_version: goal.version,
    frozen_at: new Date().toISOString(),
    requirements: goal.requirements.filter((req) => req.status === 'active'),
    criteria: goal.acceptance_criteria.map((criterion) => ({ ...criterion })),
    constraints: [...goal.constraints],
    metric: { ...goal.metric }
  };
}

function acceptanceClarificationReason(goal: GoalFile): string | null {
  const active = goal.requirements.filter((req) => req.status === 'active');
  if (active.length === 0) return 'No active requirements are present in GOAL.md.';
  if (goal.acceptance_criteria.length === 0) return 'No machine-checkable acceptance criteria are present in GOAL.md.';
  const incomplete = goal.acceptance_criteria.find((criterion) => !criterion.id || !criterion.text || !criterion.check);
  if (incomplete) return `Acceptance criterion ${incomplete.id || '<missing-id>'} is missing id, text, or check.`;
  if (!goal.metric.name || !goal.metric.direction) return 'The metric in GOAL.md is incomplete.';
  return null;
}

function validateAcceptanceSpecShape(spec: AcceptanceSpec): void {
  if (spec.version !== 1 || !spec.run_id || !Array.isArray(spec.criteria)) {
    throw new Error(`Invalid acceptance.spec.json: ${JSON.stringify(spec)}`);
  }
}
