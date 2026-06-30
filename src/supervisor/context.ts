import { readFile } from 'node:fs/promises';
import { atomicWriteFile, exists } from '../shared/atomic.js';
import type { RunPaths } from '../shared/paths.js';
import type { CurriculumEntry, GoalFile, GoalInterrogationEntry, LedgerEntry } from '../shared/types.js';
import { readLatestCurriculumSubgoal } from './curriculum.js';
import { readLatestGoalInterrogation } from './goalInterrogation.js';
import { formatPrimaryMetric } from './metricFormat.js';

const MAX_HANDOFF_CHARS = 16_000;
const MAX_FRONTIER_LINES = 24;
const MAX_RECENT_HANDOFF_LEDGER = 5;
const MAX_ITEM_CHARS = 280;

export async function writeContextSummary(paths: RunPaths, goal: GoalFile, ledger: LedgerEntry[]): Promise<boolean> {
  if (ledger.length === 0) return false;
  const latestGoalInterrogation = await readLatestGoalInterrogation(paths);
  const latestCurriculum = await readLatestCurriculumSubgoal(paths);
  const planText = (await exists(paths.plan)) ? await readFile(paths.plan, 'utf8') : '';
  const content = boundHandoff(formatContextSummary(paths, goal, ledger, latestGoalInterrogation, latestCurriculum, planText));
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
  latestCurriculum: CurriculumEntry | null,
  planText: string
): string {
  const recent = ledger.slice(-MAX_RECENT_HANDOFF_LEDGER);
  const latestKeep = [...ledger].reverse().find((entry) => entry.status === 'keep');
  const lines = [
    '# Thinkless Durable Handoff',
    '',
    '## Goal Brief',
    `- run_id: ${goal.run_id}`,
    `- goal_version: ${goal.version}`,
    `- active_requirements: ${goal.requirements.filter((req) => req.status === 'active').map((req) => `${req.id}:${singleLineBounded(req.text)}`).join(' | ') || 'none'}`,
    `- acceptance: ${goal.acceptance_criteria.map((criterion) => `${criterion.id}:${singleLineBounded(criterion.check || criterion.text)}`).join(' | ') || 'none'}`,
    `- constraints: ${goal.constraints.slice(0, 8).map(singleLineBounded).join(' | ') || 'none'}`,
    `- metric: ${goal.metric.name || 'n/a'} ${goal.metric.direction}${goal.metric.target === undefined || goal.metric.target === null ? '' : ` target=${goal.metric.target}`}${goal.metric.unit ? ` ${goal.metric.unit}` : ''}`,
    '',
    '## Active Plan Frontier',
    ...formatPlanFrontier(planText),
    '',
    '## Claim Check Paths',
    `- target: ${paths.target}`,
    '- goal: GOAL.md',
    '- plan: PLAN.md',
    '- public ledger: ledger.jsonl',
    '- executor artifacts: .thinkless*/artifacts/ or .wici/artifacts/',
    '- optional planner scripts: .opt/checks.sh and .opt/measure.sh',
    '- optional benchmark note: .opt/benchmark.json',
    '- acceptance spec, only if present: acceptance.spec.json',
    '- periodic goal checks: goal-interrogations.jsonl',
    '- automatic curriculum: curriculum.jsonl',
    '- codex transcript: codex-run.jsonl (read only targeted slices; do not paste whole transcript)',
    '',
    '## Current Best Evidence',
    `- latest_keep: ${latestKeep ? `${latestKeep.id} commit=${latestKeep.commit ?? 'none'} ${latestKeep.metric ? formatPrimaryMetric(goal, latestKeep.metric) : 'metric=n/a'}` : 'none'}`,
    '',
    '## Recent Ledger Conclusions',
    ...recent.map((entry) => formatLedgerLine(goal, entry)),
    '',
    '## Latest Curriculum Sub-goal',
    ...(latestCurriculum ? formatCurriculum(latestCurriculum) : ['- none yet']),
    '',
    '## Latest Goal Interrogation',
    ...(latestGoalInterrogation ? formatGoalInterrogation(latestGoalInterrogation) : ['- none yet']),
    '',
    '## Guidance',
    '- Treat this handoff as an index, not hidden memory. Claim-check GOAL.md, PLAN.md, git status, recent ledger, and referenced artifacts before acting.',
    '- Old Codex thread memory is disposable. Durable facts must be in GOAL.md, PLAN.md, ASSUMPTIONS.md, ledger, or artifact files.',
    '- Reference large artifacts by path instead of copying their contents into prompts.',
    ''
  ];
  return `${lines.join('\n')}`;
}

function formatPlanFrontier(planText: string): string[] {
  const lines = planText.split(/\r?\n/);
  const selected: string[] = [];
  let activeIndex = lines.findIndex((line) => /<!--\s*status:active\b/i.test(line) || /^\s*-\s*\[[ xX]\]\s+\S+.*\bstatus:active\b/i.test(line));
  if (activeIndex < 0) activeIndex = lines.findIndex((line) => /^\s*-\s*\[\s\]\s+S?\d+/i.test(line));
  if (activeIndex < 0) return ['- no active or pending step found; read PLAN.md directly'];
  const start = Math.max(0, activeIndex - 4);
  const end = Math.min(lines.length, activeIndex + MAX_FRONTIER_LINES);
  for (const line of lines.slice(start, end)) {
    const trimmed = line.trimEnd();
    if (!trimmed.trim()) continue;
    selected.push(`- ${singleLineBounded(trimmed)}`);
  }
  return selected.length > 0 ? selected : ['- no compact frontier extracted; read PLAN.md directly'];
}

function formatCurriculum(entry: CurriculumEntry): string[] {
  return [
    `- id: ${entry.id}`,
    `- iter: ${entry.iter}`,
    `- saturated_step_id: ${entry.saturated_step_id}`,
    `- branch_reason: ${singleLine(entry.branch_reason)}`,
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

function formatLedgerLine(goal: GoalFile, entry: LedgerEntry): string {
  const metric = entry.metric ? formatPrimaryMetric(goal, entry.metric) : `${goal.metric.name || 'metric'}=n/a`;
  const delta = typeof entry.delta_pct === 'number' ? `delta=${(entry.delta_pct * 100).toFixed(2)}%` : 'delta=n/a';
  const guards = publicGuardSummary(entry.guards);
  const guardText = guards.length > 0 ? ` guards=${guards.join(',')}` : '';
  const parent = entry.parent_id ? ` parent=${entry.parent_id}` : '';
  return `- ${entry.id} iter=${entry.iter} step=${entry.step_id} status=${entry.status} commit=${entry.commit ?? 'none'} ${metric} ${delta} confidence=${entry.confidence}${parent}${guardText} reflection=${singleLineBounded(entry.reflection)}`;
}

function publicGuardSummary(guards: LedgerEntry['guards']): string[] {
  return Object.entries(guards)
    .filter(([key]) => !key.startsWith('heldout_'))
    .map(([key, value]) => `${key}:${singleLine(String(value))}`);
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function singleLineBounded(text: string): string {
  const line = singleLine(text);
  return line.length > MAX_ITEM_CHARS ? `${line.slice(0, MAX_ITEM_CHARS - 3)}...` : line;
}

function boundHandoff(content: string): string {
  if (content.length <= MAX_HANDOFF_CHARS) return content;
  return [
    content.slice(0, MAX_HANDOFF_CHARS - 260).trimEnd(),
    '',
    '## Truncation Notice',
    `- Handoff was capped at ${MAX_HANDOFF_CHARS} characters. Read GOAL.md, PLAN.md, ledger.jsonl, and referenced artifacts directly for omitted details.`,
    ''
  ].join('\n');
}
