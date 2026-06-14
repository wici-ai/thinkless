import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { execa } from 'execa';
import { atomicWriteFile, atomicWriteJson, readJsonFileMaybe } from '../shared/atomic.js';
import type { GoalFile, LedgerEntry, SkillEntry, SkillLibrary } from '../shared/types.js';
import type { RunPaths } from '../shared/paths.js';

export async function recordSkillFromKeep(paths: RunPaths, goal: GoalFile, entry: LedgerEntry, commit: string): Promise<SkillEntry | null> {
  if (entry.status !== 'keep' || !entry.metric) return null;
  const patch = await git(paths, ['show', '--format=', '--binary', commit, '--', '.', ':(exclude)PLAN.md', ':(exclude)baseline.json', ':(exclude)ledger.jsonl', ':(exclude)acceptance.spec.json', ':(exclude).opt/**']);
  if (!patch.trim()) return null;
  const patchSha = sha256(patch);
  const library = await loadSkillLibrary(paths);
  const existing = library.entries.find((item) => item.patch_sha256 === patchSha);
  if (existing) return existing;

  const id = `skill-${entry.id}`;
  const patchName = `${id}.patch`;
  await atomicWriteFile(`${paths.skills}/${patchName}`, patch.endsWith('\n') ? patch : `${patch}\n`);
  const skill: SkillEntry = {
    id,
    ts: new Date().toISOString(),
    source_ledger_id: entry.id,
    step_id: entry.step_id,
    title: entry.hypothesis,
    summary: summarizeSkill(goal, entry),
    tags: skillTags(goal, entry),
    patch_path: relative(paths.target, `${paths.skills}/${patchName}`),
    patch_sha256: patchSha,
    commit,
    delta_pct: entry.delta_pct,
    uses: 0
  };
  await atomicWriteJson(paths.skillsIndex, {
    version: library.version + 1,
    entries: [...library.entries, skill]
  });
  return skill;
}

export async function retrieveSkills(paths: RunPaths, query: string, limit = 3): Promise<SkillEntry[]> {
  const library = await loadSkillLibrary(paths);
  const queryTokens = tokenize(query);
  return library.entries
    .map((entry) => ({ entry, score: scoreSkill(entry, queryTokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || (b.entry.delta_pct ?? 0) - (a.entry.delta_pct ?? 0) || a.entry.id.localeCompare(b.entry.id))
    .slice(0, limit)
    .map((item) => item.entry);
}

export function formatSkillsForPrompt(skills: SkillEntry[]): string {
  if (skills.length === 0) return '';
  return [
    'Executable WiCi skills retrieved from prior accepted patches:',
    ...skills.map((skill) => `- ${skill.id}: ${skill.summary} | patch: ${skill.patch_path} | source: ${skill.source_ledger_id}`)
  ].join('\n');
}

export async function loadSkillLibrary(paths: RunPaths): Promise<SkillLibrary> {
  const existing = await readJsonFileMaybe<SkillLibrary>(paths.skillsIndex);
  if (!existing) return { version: 1, entries: [] };
  return {
    version: existing.version,
    entries: existing.entries.map((entry) => ({ ...entry, uses: entry.uses ?? 0 }))
  };
}

function summarizeSkill(goal: GoalFile, entry: LedgerEntry): string {
  const delta = typeof entry.delta_pct === 'number' ? ` improved ${goal.metric.name} by ${(entry.delta_pct * 100).toFixed(1)}%` : '';
  return `${entry.hypothesis}${delta}. Reuse by inspecting and applying the patch path when the same pattern fits.`;
}

function skillTags(goal: GoalFile, entry: LedgerEntry): string[] {
  return [...tokenize(`${goal.metric.name} ${entry.step_id} ${entry.hypothesis} ${entry.reflection}`)].slice(0, 12);
}

function scoreSkill(entry: SkillEntry, queryTokens: Set<string>): number {
  const tokens = tokenize(`${entry.title} ${entry.summary} ${entry.tags.join(' ')}`);
  let score = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) score += 1;
  }
  return score;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !stopWords.has(token))
  );
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function git(paths: RunPaths, args: string[]): Promise<string> {
  const result = await execa('git', ['-C', paths.target, ...args], { all: true });
  return result.all ?? result.stdout;
}

const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'while', 'only', 'when', 'into', 'path']);
