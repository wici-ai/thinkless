import { execa } from 'execa';
import { appendJsonLine, readJsonLines } from '../shared/atomic.js';
import type { LedgerEntry, LessonEntry, WiCiConfig } from '../shared/types.js';
import type { RunPaths } from '../shared/paths.js';

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
          '--dangerously-skip-permissions'
        ],
        { cwd: paths.target, reject: true, all: true, maxBuffer: 1024 * 1024 * 5 }
      );
      const parsed = JSON.parse(result.stdout) as { lesson?: string; structured_output?: { lesson?: string } };
      const lesson = compactLesson(parsed.structured_output?.lesson ?? parsed.lesson);
      if (lesson) return { lesson, author: 'claude' };
    } catch (error) {
      if (config.tools.mode === 'real') throw error;
    }
  }

  return { lesson: deterministicMeasuredRejectLesson(entry), author: 'supervisor' };
}

function deterministicMeasuredRejectLesson(entry: LedgerEntry): string {
  const delta = typeof entry.delta_pct === 'number' ? ` delta=${(entry.delta_pct * 100).toFixed(2)}%` : '';
  return `Measured verifier rejected ${entry.hypothesis}.${delta} Do not repeat this avenue without a new hypothesis; address: ${entry.reflection}.`;
}

function isMeasuredReject(entry: LedgerEntry): boolean {
  if (entry.status !== 'reject' && entry.status !== 'revert') return false;
  return Boolean(entry.metric || typeof entry.guards.prescreen_p99 === 'number' || typeof entry.guards.heldout_p99 === 'number');
}

function compactLesson(value: string | undefined): string | null {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

async function commandExists(command: string): Promise<boolean> {
  const result = await execa('command', ['-v', command], { shell: true, reject: false });
  return result.exitCode === 0;
}
