import { mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import type { RunPaths } from '../shared/paths.js';
import type { WiCiConfig } from '../shared/types.js';

const WICI_SCAFFOLD_ENTRIES = new Set(['.wici', '.opt']);

async function git(paths: RunPaths, args: string[], reject = true): Promise<string> {
  const result = await execa('git', ['-C', paths.target, ...args], {
    reject,
    all: true
  });
  return result.all ?? result.stdout;
}

export async function isGitRepo(paths: RunPaths): Promise<boolean> {
  const result = await execa('git', ['-C', paths.target, 'rev-parse', '--show-toplevel'], {
    reject: false
  });
  return result.exitCode === 0 && resolve(result.stdout.trim()) === resolve(paths.target);
}

export async function ensureGitRepo(paths: RunPaths, config: WiCiConfig): Promise<void> {
  if (await isGitRepo(paths)) return;
  const canInit = config.git.init_if_missing || (await hasOnlyWiCiScaffold(paths.target));
  if (!canInit) {
    throw new Error(`Target is not a git repository: ${paths.target}`);
  }
  await mkdir(paths.target, { recursive: true });
  await execa('git', ['-C', paths.target, 'init']);
  await execa('git', ['-C', paths.target, 'config', 'user.name', config.git.user_name]);
  await execa('git', ['-C', paths.target, 'config', 'user.email', config.git.user_email]);
}

async function hasOnlyWiCiScaffold(target: string): Promise<boolean> {
  try {
    const entries = await readdir(target, { withFileTypes: true });
    return entries.every((entry) => WICI_SCAFFOLD_ENTRIES.has(entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

export async function ensureGitIdentity(paths: RunPaths, config: WiCiConfig): Promise<void> {
  const name = await execa('git', ['-C', paths.target, 'config', '--get', 'user.name'], { reject: false });
  if (name.exitCode !== 0 || !name.stdout.trim()) {
    await execa('git', ['-C', paths.target, 'config', 'user.name', config.git.user_name]);
  }
  const email = await execa('git', ['-C', paths.target, 'config', '--get', 'user.email'], { reject: false });
  if (email.exitCode !== 0 || !email.stdout.trim()) {
    await execa('git', ['-C', paths.target, 'config', 'user.email', config.git.user_email]);
  }
}

export async function currentCommit(paths: RunPaths): Promise<string> {
  const result = await execa('git', ['-C', paths.target, 'rev-parse', 'HEAD'], { reject: false });
  if (result.exitCode !== 0) return 'NO_HEAD';
  return result.stdout.trim();
}

export async function hasTrackedHead(paths: RunPaths): Promise<boolean> {
  const result = await execa('git', ['-C', paths.target, 'rev-parse', '--verify', 'HEAD'], { reject: false });
  return result.exitCode === 0;
}

export async function hasChanges(paths: RunPaths): Promise<boolean> {
  const result = await git(paths, ['status', '--porcelain']);
  return result.trim().length > 0;
}

export async function commitAll(paths: RunPaths, message: string): Promise<string> {
  await git(paths, ['add', '-A']);
  if (!(await hasChanges(paths))) {
    return currentCommit(paths);
  }
  await git(paths, ['commit', '-m', message]);
  return currentCommit(paths);
}

export async function commitAllWithKey(paths: RunPaths, message: string, key: string): Promise<{ commit: string; reused: boolean }> {
  const existing = await findCommitByKey(paths, key);
  if (existing) return { commit: existing, reused: true };
  const commit = await commitAll(paths, `${message}\n\nWiCi-Idempotency-Key: ${key}`);
  return { commit, reused: false };
}

export async function findCommitByKey(paths: RunPaths, key: string): Promise<string | null> {
  const result = await git(paths, ['log', '--all', '--fixed-strings', '--grep', `WiCi-Idempotency-Key: ${key}`, '--format=%H', '-n', '1'], false);
  return result.trim() || null;
}

export async function tagPerf(paths: RunPaths, tag: string): Promise<void> {
  await git(paths, ['tag', '-f', tag]);
}

export async function tagBest(paths: RunPaths): Promise<void> {
  await git(paths, ['tag', '-f', 'wici/best']);
}

export async function revertToBest(paths: RunPaths, bestCommit: string): Promise<void> {
  const bestTag = await execa('git', ['-C', paths.target, 'rev-parse', '--verify', 'refs/tags/wici/best'], {
    reject: false
  });
  const rollbackTarget = bestTag.exitCode === 0 ? 'wici/best' : bestCommit;
  if (rollbackTarget && rollbackTarget !== 'NO_HEAD') {
    await git(paths, ['reset', '--hard', rollbackTarget]);
  } else {
    await git(paths, ['restore', '--staged', '--worktree', '.'], false);
  }
  await git(paths, ['clean', '-fd', '-e', '.wici/'], false);
}

export async function resetToCommit(paths: RunPaths, commit: string): Promise<void> {
  if (!commit || commit === 'NO_HEAD') {
    throw new Error(`Cannot reset to invalid WiCi checkpoint commit: ${commit}`);
  }
  await git(paths, ['reset', '--hard', commit]);
  await git(paths, ['clean', '-fd', '-e', '.wici/'], false);
}
