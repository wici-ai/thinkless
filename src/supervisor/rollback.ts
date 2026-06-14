import { execa } from 'execa';
import { readJsonFileMaybe } from '../shared/atomic.js';
import type { RunPaths } from '../shared/paths.js';
import type { BaselineFile, Checkpoint } from '../shared/types.js';
import { currentCommit, hasChanges } from './gitgate.js';

export interface RollbackPreview {
  target: string;
  current_commit: string;
  rollback_ref: string;
  rollback_commit: string;
  source: 'wici/best' | 'baseline.best_commit';
  dirty: boolean;
  confirm_required: boolean;
  wici?: NonNullable<Checkpoint['tool_versions']>['wici'];
}

export interface RollbackResult extends RollbackPreview {
  reset: boolean;
  cleaned: boolean;
  head_after: string;
}

export async function previewRollback(paths: RunPaths): Promise<RollbackPreview> {
  const baseline = await readJsonFileMaybe<BaselineFile>(paths.baseline);
  if (!baseline) throw new Error(`Cannot rollback without baseline.json: ${paths.baseline}`);
  const checkpoint = await readJsonFileMaybe<Checkpoint>(paths.checkpoint);
  const bestTag = await resolveBestTag(paths);
  const rollbackRef = bestTag ?? baseline.best_commit;
  if (!rollbackRef || rollbackRef === 'NO_HEAD') {
    throw new Error(`Cannot rollback to invalid best commit: ${rollbackRef}`);
  }
  const rollbackCommit = await revParse(paths, rollbackRef);
  return {
    target: paths.target,
    current_commit: await currentCommit(paths),
    rollback_ref: rollbackRef,
    rollback_commit: rollbackCommit,
    source: bestTag ? 'wici/best' : 'baseline.best_commit',
    dirty: await hasChanges(paths),
    confirm_required: true,
    wici: checkpoint?.tool_versions?.wici
  };
}

export async function rollbackTarget(paths: RunPaths): Promise<RollbackResult> {
  const preview = await previewRollback(paths);
  await git(paths, ['reset', '--hard', preview.rollback_ref]);
  await git(paths, ['clean', '-fd', '-e', '.wici/'], false);
  return {
    ...preview,
    reset: true,
    cleaned: true,
    head_after: await currentCommit(paths)
  };
}

async function resolveBestTag(paths: RunPaths): Promise<string | null> {
  const result = await execa('git', ['-C', paths.target, 'rev-parse', '--verify', 'refs/tags/wici/best'], {
    reject: false
  });
  return result.exitCode === 0 ? 'wici/best' : null;
}

async function revParse(paths: RunPaths, ref: string): Promise<string> {
  const result = await execa('git', ['-C', paths.target, 'rev-parse', ref], {
    reject: false,
    all: true
  });
  if (result.exitCode !== 0) throw new Error(`Cannot resolve rollback ref ${ref}: ${result.all ?? result.stderr}`);
  return (result.all ?? result.stdout).trim();
}

async function git(paths: RunPaths, args: string[], reject = true): Promise<string> {
  const result = await execa('git', ['-C', paths.target, ...args], {
    reject,
    all: true
  });
  return result.all ?? result.stdout;
}
