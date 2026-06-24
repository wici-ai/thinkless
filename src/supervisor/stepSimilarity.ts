import type { PlanStep } from './plan.js';

export interface StepSimilarityMatch {
  added: PlanStep;
  existing: PlanStep;
  score: number;
}

export interface StepSimilarityOptions {
  recentWindow?: number;
  threshold?: number;
}

const DEFAULT_RECENT_WINDOW = 8;
const DEFAULT_THRESHOLD = 0.78;

export function findNearDuplicateContinuationStep(
  previousSteps: PlanStep[],
  updatedSteps: PlanStep[],
  options: StepSimilarityOptions = {}
): StepSimilarityMatch | null {
  const previousIds = new Set(previousSteps.map((step) => step.id));
  const added = updatedSteps.filter((step) => !previousIds.has(step.id));
  const recent = previousSteps.slice(-Math.max(1, options.recentWindow ?? DEFAULT_RECENT_WINDOW));
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  let best: StepSimilarityMatch | null = null;

  for (const item of added) {
    for (const existing of recent) {
      const score = stepTitleSimilarity(item.text, existing.text);
      if (score < threshold) continue;
      if (!best || score > best.score) best = { added: item, existing, score };
    }
  }

  return best;
}

export function stepTitleSimilarity(left: string, right: string): number {
  const a = normalizeStepTitle(left);
  const b = normalizeStepTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const tokenScore = tokenDice(tokens(a), tokens(b));
  const editScore = levenshteinRatio(a, b);
  return Math.max(tokenScore, editScore);
}

export function normalizeStepTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/<!--.*?-->/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokens(value: string): Set<string> {
  return new Set(value.split(/\s+/).filter((token) => token.length > 1));
}

function tokenDice(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return (2 * intersection) / (left.size + right.size);
}

function levenshteinRatio(left: string, right: string): number {
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) return 1;
  return 1 - levenshteinDistance(left, right) / maxLength;
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length] ?? 0;
}
