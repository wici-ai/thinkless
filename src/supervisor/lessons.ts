import { execa } from 'execa';
import { appendJsonLine, readJsonLines } from '../shared/atomic.js';
import { commandExists } from '../shared/commands.js';
import type { LedgerEntry, LessonEntry, WiCiConfig } from '../shared/types.js';
import type { RunPaths } from '../shared/paths.js';
import { isClaudeEnvelope, parseClaudeJsonOutput, parseJsonObjectFromText } from './claudeOutput.js';

export async function appendLessonFromLedger(paths: RunPaths, entry: LedgerEntry, config?: WiCiConfig): Promise<LessonEntry | null> {
  if (!isMeasuredReject(entry)) return null;
  const reflected = await reflectMeasuredReject(paths, entry, config);
  const lesson = reflected.lesson;
  if (!lesson) return null;
  const item: LessonEntry = {
    id: `lesson-${entry.id}`,
    ts: new Date().toISOString(),
    source_ledger_id: entry.id,
    step_id: entry.step_id,
    status: entry.status,
    trigger: 'measured_reject',
    author: reflected.author,
    lesson
  };
  await appendJsonLine(paths.lessons, item);
  return item;
}

export async function readRecentLessons(paths: RunPaths, limit = 6): Promise<LessonEntry[]> {
  const lessons = await readJsonLines<LessonEntry>(paths.lessons);
  return lessons.slice(-limit);
}

export function formatLessonsForPrompt(lessons: LessonEntry[]): string {
  if (lessons.length === 0) return '';
  return [
    'Recent WiCi lessons to apply:',
    ...lessons.map((item) => `- ${item.step_id} ${item.status}: ${item.lesson}`)
  ].join('\n');
}

async function reflectMeasuredReject(
  paths: RunPaths,
  entry: LedgerEntry,
  config: WiCiConfig | undefined
): Promise<{ lesson: string | null; author: LessonEntry['author'] }> {
  if (config && config.tools.mode !== 'stub' && (await commandExists(config.tools.planner.command))) {
    try {
      const result = await execa(
        config.tools.planner.command,
        [
          '-p',
          [
            'A WiCi candidate was rejected by the external verifier. Write one compact lesson for the next optimization attempt.',
            'Do not trust the executor self-report; use only this ledger row.',
            'Return JSON: {"lesson":"short actionable lesson"}.',
            '',
            JSON.stringify(entry, null, 2)
          ].join('\n'),
          '--output-format',
          'json',
          '--permission-mode',
          'plan'
        ],
        { cwd: paths.target, reject: true, all: true, maxBuffer: 1024 * 1024 * 5 }
      );
      const lesson = compactLesson(extractLesson(result.stdout));
      if (lesson) return { lesson, author: 'claude' };
    } catch (error) {
      if (config.tools.mode === 'real') throw error;
    }
  }

  return { lesson: deterministicMeasuredRejectLesson(entry), author: 'supervisor' };
}

function deterministicMeasuredRejectLesson(entry: LedgerEntry): string {
  const delta = typeof entry.delta_pct === 'number' ? ` delta=${(entry.delta_pct * 100).toFixed(2)}%` : '';
  return `Measured verifier rejected ${entry.hypothesis}.${delta} Do not repeat this direction without a new hypothesis; address: ${entry.reflection}.`;
}

function extractLesson(raw: string): string | undefined {
  const parsed = parseClaudeJsonOutput(raw);
  for (const item of [...parsed].reverse()) {
    const lesson = lessonFromCandidate(item);
    if (lesson) return lesson;
  }
  return undefined;
}

function lessonFromCandidate(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const direct = candidate as { lesson?: unknown; structured_output?: unknown };
  if (typeof direct.lesson === 'string') return direct.lesson;
  if (direct.structured_output) {
    const structured = lessonFromCandidate(direct.structured_output);
    if (structured) return structured;
  }
  if (!isClaudeEnvelope(candidate) || candidate.result === undefined || candidate.result === null) return null;
  if (typeof candidate.result === 'object') return lessonFromCandidate(candidate.result);
  if (typeof candidate.result !== 'string') return null;
  const parsed = parseJsonObjectFromText(candidate.result);
  return parsed ? lessonFromCandidate(parsed) : null;
}

function isMeasuredReject(entry: LedgerEntry): boolean {
  if (entry.status !== 'reject' && entry.status !== 'revert') return false;
  return Boolean(entry.metric || typeof entry.guards.prescreen_value === 'number' || typeof entry.guards.heldout_value === 'number');
}

function compactLesson(value: string | undefined): string | null {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}
