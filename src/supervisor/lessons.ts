import { appendJsonLine, readJsonLines } from '../shared/atomic.js';
import type { LedgerEntry, LessonEntry } from '../shared/types.js';
import type { RunPaths } from '../shared/paths.js';

export async function appendLessonFromLedger(paths: RunPaths, entry: LedgerEntry): Promise<LessonEntry | null> {
  const lesson = deriveLesson(entry);
  if (!lesson) return null;
  const item: LessonEntry = {
    id: `lesson-${entry.id}`,
    ts: new Date().toISOString(),
    source_ledger_id: entry.id,
    step_id: entry.step_id,
    status: entry.status,
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

function deriveLesson(entry: LedgerEntry): string | null {
  if (entry.status === 'keep') {
    const delta = typeof entry.delta_pct === 'number' ? ` (${(entry.delta_pct * 100).toFixed(1)}% p99 delta)` : '';
    return `Promising avenue: ${entry.hypothesis}${delta}. Preserve the correctness guards that passed.`;
  }

  if (entry.status === 'reject' || entry.status === 'revert') {
    return `Avoid repeating this avenue without a new hypothesis: ${entry.hypothesis}. Rejection reason: ${entry.reflection}.`;
  }

  if (entry.status === 'checks_failed') {
    return `Correctness failed for ${entry.hypothesis}. Prioritize tests and invariants before performance changes.`;
  }

  if (entry.status === 'crash') {
    return `Executor crashed on ${entry.hypothesis}. Reduce blast radius and make smaller, verifiable edits.`;
  }

  return null;
}
