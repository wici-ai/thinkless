import { readFile } from 'node:fs/promises';
import { atomicWriteFile, exists } from '../shared/atomic.js';
import type { RunPaths } from '../shared/paths.js';
import type { CurriculumEntry, GoalFile, GoalInterrogationEntry, LedgerEntry } from '../shared/types.js';
import { readLatestCurriculumSubgoal } from './curriculum.js';
import { readLatestGoalInterrogation } from './goalInterrogation.js';

const MAX_RECENT_LEDGER = 8;

export async function writeContextSummary(paths: RunPaths, goal: GoalFile, ledger: LedgerEntry[]): Promise<boolean> {
  if (ledger.length === 0) return false;
  const latestGoalInterrogation = await readLatestGoalInterrogation(paths);
  const latestCurriculum = await readLatestCurriculumSubgoal(paths);
  const content = formatContextSummary(paths, goal, ledger, latestGoalInterrogation, latestCurriculum);
  const current = (await exists(paths.context)) ? await readFile(paths.context, 'utf8') : '';
  if (current === content) return false;
  await atomicWriteFile(paths.context, content);
  return true;
}

export async function readContextForPrompt(paths: RunPaths): Promise<string> {
  if (!(await exists(paths.context))) return '';
  const content = await readFile(paths.context, 'utf8');
  if (!content.trim()) return '';
  return [
    'Condensed WiCi run context (KEEP_FIRST_GOAL / GOAL.md is authoritative; do not treat ledger notes as a replacement for the goal):',
    content.trim()
  ].join('\n');
}

export function combinePromptMemory(...items: string[]): string {
  return items.map((item) => item.trim()).filter(Boolean).join('\n\n');
}

function formatContextSummary(
  paths: RunPaths,
  goal: GoalFile,
  ledger: LedgerEntry[],
  latestGoalInterrogation: GoalInterrogationEntry | null,
  latestCurriculum: CurriculumEntry | null
): string {
  const recent = ledger.slice(-MAX_RECENT_LEDGER);
  const lines = [
    '# WiCi Condensed Run Context',
    '',
    '## KEEP_FIRST_GOAL',
    fencedJson({
      run_id: goal.run_id,
      version: goal.version,
      requirements: goal.requirements.filter((req) => req.status === 'active'),
      acceptance_criteria: goal.acceptance_criteria,
      constraints: goal.constraints,
      metric: goal.metric,
      stop: goal.stop
    }),
    '',
    '## Claim Check Paths',
    `- target: ${paths.target}`,
    '- goal: GOAL.md',
    '- plan: PLAN.md',
    '- frozen acceptance spec: acceptance.spec.json',
    '- public ledger: ledger.jsonl',
    '- executor artifacts: .wici/artifacts/',
    '- locked eval scripts: .opt/checks.sh and .opt/measure.sh',
    '- benchmark selection: .opt/benchmark.json',
    '- periodic goal checks: .wici/goal-interrogations.jsonl',
    '- automatic curriculum: .wici/curriculum.jsonl',
    '',
    '## Recent Public Ledger',
    ...recent.map(formatLedgerLine),
    '',
    '## Latest Curriculum Sub-goal',
    ...(latestCurriculum ? formatCurriculum(latestCurriculum) : ['- none yet']),
    '',
    '## Latest Goal Interrogation',
    ...(latestGoalInterrogation ? formatGoalInterrogation(latestGoalInterrogation) : ['- none yet']),
    '',
    '## Guidance',
    '- Keep GOAL.md and PLAN.md as the source of truth.',
    '- Use the ledger as public history only; held-out validation details are intentionally omitted from this prompt context.',
    '- Prefer referencing large artifacts by path instead of copying their contents into prompts.',
    ''
  ];
  return `${lines.join('\n')}`;
}

function formatCurriculum(entry: CurriculumEntry): string[] {
  return [
    `- id: ${entry.id}`,
    `- iter: ${entry.iter}`,
    `- saturated_step_id: ${entry.saturated_step_id}`,
    `- avenue: ${singleLine(entry.avenue)}`,
    `- parent_ledger_id: ${entry.parent_ledger_id ?? 'none'}`,
    `- sub_goal: ${singleLine(entry.sub_goal)}`
  ];
}

function formatGoalInterrogation(entry: GoalInterrogationEntry): string[] {
  return [
    `- id: ${entry.id}`,
    `- iter: ${entry.iter}`,
    `- aligned: ${entry.aligned}`,
    `- restated_goal: ${singleLine(entry.restated_goal)}`,
    `- active_requirement_ids: ${entry.active_requirement_ids.join(',') || 'none'}`,
    `- acceptance_checks: ${entry.acceptance_checks.join(',') || 'none'}`,
    `- recent_statuses: ${entry.recent_statuses.join(',') || 'none'}`,
    `- concerns: ${entry.concerns.join('; ') || 'none'}`
  ];
}

function formatLedgerLine(entry: LedgerEntry): string {
  const metric = entry.metric ? `p99=${entry.metric.p99}${entry.metric.unit}` : 'p99=n/a';
  const delta = typeof entry.delta_pct === 'number' ? `delta=${(entry.delta_pct * 100).toFixed(2)}%` : 'delta=n/a';
  const guards = publicGuardSummary(entry.guards);
  const guardText = guards.length > 0 ? ` guards=${guards.join(',')}` : '';
  const parent = entry.parent_id ? ` parent=${entry.parent_id}` : '';
  return `- ${entry.id} iter=${entry.iter} step=${entry.step_id} status=${entry.status} ${metric} ${delta} confidence=${entry.confidence}${parent}${guardText} reflection=${singleLine(entry.reflection)}`;
}

function publicGuardSummary(guards: LedgerEntry['guards']): string[] {
  return Object.entries(guards)
    .filter(([key]) => !key.startsWith('heldout_'))
    .map(([key, value]) => `${key}:${singleLine(String(value))}`);
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function fencedJson(value: unknown): string {
  return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
}
