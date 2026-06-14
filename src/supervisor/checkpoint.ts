import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, atomicWriteJson, ensureDir, exists, lineCount, readJsonFileMaybe, removeIfExists } from '../shared/atomic.js';
import type { Checkpoint, CheckpointSnapshot, GoalFile } from '../shared/types.js';
import type { RunPaths } from '../shared/paths.js';
import { saveGoalFiles } from './goalDoc.js';

export async function hashFile(path: string): Promise<string | null> {
  if (!(await exists(path))) return null;
  const raw = await readFile(path);
  return createHash('sha256').update(raw).digest('hex');
}

export async function loadCheckpoint(paths: RunPaths, goal?: GoalFile): Promise<Checkpoint> {
  const current = await readJsonFileMaybe<Checkpoint>(paths.checkpoint);
  if (current) return current;
  return {
    supervisor_state: 'INTAKE',
    next_step: null,
    iter: 0,
    goal_version: goal?.version ?? 0,
    plan_hash: await hashFile(paths.plan),
    ledger_seq: await lineCount(paths.ledger),
    events_seq: await lineCount(paths.events),
    sessions: {},
    tool_versions: undefined,
    drained_inbox: [],
    updated_at: new Date().toISOString()
  };
}

export async function saveCheckpoint(paths: RunPaths, checkpoint: Checkpoint): Promise<void> {
  await atomicWriteJson(paths.checkpoint, {
    ...checkpoint,
    updated_at: new Date().toISOString()
  });
}

export async function saveIterationSnapshot(
  paths: RunPaths,
  checkpoint: Checkpoint,
  goal: GoalFile,
  input: { headCommit: string; bestCommit?: string | null }
): Promise<CheckpointSnapshot> {
  const createdAt = new Date().toISOString();
  const snapshot: CheckpointSnapshot = {
    version: 1,
    iter: checkpoint.iter,
    checkpoint: {
      ...checkpoint,
      updated_at: createdAt
    },
    goal,
    head_commit: input.headCommit,
    best_commit: input.bestCommit ?? null,
    files: {
      goal_doc: await readTextMaybe(paths.goalDoc),
      lessons: await readTextMaybe(paths.lessons),
      skills_index: await readTextMaybe(paths.skillsIndex),
      skills: await readTextDirectory(paths.skills),
      curriculum: await readTextMaybe(paths.curriculum),
      context: await readTextMaybe(paths.context),
      goal_interrogations: await readTextMaybe(paths.goalInterrogations),
      archive: await readTextMaybe(paths.archive),
      avenues: await readTextMaybe(paths.avenues)
    },
    created_at: createdAt
  };
  await atomicWriteJson(iterationSnapshotPath(paths, checkpoint.iter), snapshot);
  return snapshot;
}

export async function loadIterationSnapshot(paths: RunPaths, iter: number): Promise<CheckpointSnapshot> {
  if (!Number.isInteger(iter) || iter < 0) {
    throw new Error(`resume iteration must be a non-negative integer, got ${iter}`);
  }
  const snapshot = await readJsonFileMaybe<CheckpointSnapshot>(iterationSnapshotPath(paths, iter));
  if (!snapshot) {
    throw new Error(`No WiCi checkpoint snapshot exists for iteration ${iter}`);
  }
  if (snapshot.version !== 1 || snapshot.iter !== iter) {
    throw new Error(`Invalid WiCi checkpoint snapshot for iteration ${iter}`);
  }
  return snapshot;
}

export async function restoreSnapshotRunFiles(paths: RunPaths, snapshot: CheckpointSnapshot): Promise<void> {
  await saveGoalFiles(paths, snapshot.goal);
  if (snapshot.files.goal_doc !== undefined) await restoreTextFile(paths.goalDoc, snapshot.files.goal_doc);
  await restoreTextFile(paths.lessons, snapshot.files.lessons);
  await restoreTextFile(paths.skillsIndex, snapshot.files.skills_index);
  await restoreTextDirectory(paths.skills, snapshot.files.skills);
  await restoreTextFile(paths.curriculum, snapshot.files.curriculum);
  await restoreTextFile(paths.context, snapshot.files.context);
  await restoreTextFile(paths.goalInterrogations, snapshot.files.goal_interrogations);
  await restoreTextFile(paths.archive, snapshot.files.archive);
  await restoreTextFile(paths.avenues, snapshot.files.avenues);
}

export function iterationSnapshotPath(paths: RunPaths, iter: number): string {
  return join(paths.checkpoints, `iter-${iter}.json`);
}

async function readTextMaybe(path: string): Promise<string | undefined> {
  if (!(await exists(path))) return undefined;
  return readFile(path, 'utf8');
}

async function restoreTextFile(path: string, content: string | undefined): Promise<void> {
  if (content === undefined) {
    await removeIfExists(path);
    return;
  }
  await atomicWriteFile(path, content);
}

async function readTextDirectory(path: string): Promise<Record<string, string> | undefined> {
  if (!(await exists(path))) return undefined;
  const entries = await readdir(path, { withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    files[entry.name] = await readFile(join(path, entry.name), 'utf8');
  }
  return files;
}

async function restoreTextDirectory(path: string, files: Record<string, string> | undefined): Promise<void> {
  await removeIfExists(path);
  await ensureDir(path);
  for (const [name, content] of Object.entries(files ?? {})) {
    await atomicWriteFile(join(path, name), content);
  }
}
