import { mkdir, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { execa } from 'execa';
import type { RunPaths } from '../shared/paths.js';
import type { WiCiConfig } from '../shared/types.js';

const NESTED_GIT_SEARCH_MAX_DEPTH = 5;
const NESTED_GIT_SEARCH_SKIP = new Set(['.git', '.thinkless', '.wici', '.opt', 'node_modules', 'vendor', 'dist', 'build', 'coverage']);

async function git(paths: RunPaths, args: string[], reject = true): Promise<string> {
  const root = await resolveGitWorktreeRoot(paths);
  const result = await execa('git', ['-C', root ?? paths.target, ...args], {
    reject,
    all: true
  });
  return result.all ?? result.stdout;
}

export async function isGitRepo(paths: RunPaths): Promise<boolean> {
  return Boolean(await resolveGitWorktreeRoot(paths));
}

export async function resolveGitWorktreeRoot(paths: RunPaths): Promise<string | null> {
  const result = await execa('git', ['-C', paths.target, 'rev-parse', '--show-toplevel'], { reject: false });
  if (result.exitCode === 0 && result.stdout.trim()) return result.stdout.trim();
  const nested = await findNestedGitRoots(paths.target);
  if (nested[0]) return nested[0];
  const adjacent = await findAdjacentGitRoots(paths.target);
  return adjacent[0] ?? null;
}

async function canonicalExistingPath(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return normalizePathForComparison(await realpath(resolved));
  } catch {
    return normalizePathForComparison(resolved);
  }
}

function normalizePathForComparison(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export async function ensureGitRepo(paths: RunPaths, config: WiCiConfig): Promise<void> {
  if (await isGitRepo(paths)) return;
  await mkdir(paths.target, { recursive: true });
  await execa('git', ['-C', paths.target, 'init']);
  await execa('git', ['-C', paths.target, 'config', 'user.name', config.git.user_name]);
  await execa('git', ['-C', paths.target, 'config', 'user.email', config.git.user_email]);
}

async function findNestedGitRoots(target: string): Promise<string[]> {
  const found: string[] = [];
  await walkForNestedGitRoots(resolve(target), 0, found);
  return found.sort((a, b) => pathDepth(a) - pathDepth(b) || a.localeCompare(b));
}

async function findAdjacentGitRoots(target: string): Promise<string[]> {
  const requested = normalizePathForComparison(target);
  const parent = dirname(resolve(target));
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
  const found: string[] = [];
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !NESTED_GIT_SEARCH_SKIP.has(entry.name) && !/^\.thinkless[1-9]\d*$/.test(entry.name))
      .map(async (entry) => {
        const sibling = resolve(parent, entry.name);
        if (normalizePathForComparison(sibling) === requested) return;
        await walkForNestedGitRoots(sibling, 0, found);
      })
  );
  return found.sort((a, b) => pathDepth(a) - pathDepth(b) || a.localeCompare(b));
}

async function walkForNestedGitRoots(dir: string, depth: number, found: string[]): Promise<void> {
  if (depth > NESTED_GIT_SEARCH_MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw error;
  }
  if (entries.some((entry) => entry.name === '.git')) {
    found.push(dir);
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !NESTED_GIT_SEARCH_SKIP.has(entry.name) && !/^\.thinkless[1-9]\d*$/.test(entry.name))
      .map((entry) => walkForNestedGitRoots(resolve(dir, entry.name), depth + 1, found))
  );
}

function pathDepth(path: string): number {
  return resolve(path).split(/[\\/]+/).length;
}

export async function ensureGitIdentity(paths: RunPaths, config: WiCiConfig): Promise<void> {
  const root = await resolveGitWorktreeRoot(paths) ?? paths.target;
  const name = await execa('git', ['-C', root, 'config', '--get', 'user.name'], { reject: false });
  if (name.exitCode !== 0 || !name.stdout.trim()) {
    await execa('git', ['-C', root, 'config', 'user.name', config.git.user_name]);
  }
  const email = await execa('git', ['-C', root, 'config', '--get', 'user.email'], { reject: false });
  if (email.exitCode !== 0 || !email.stdout.trim()) {
    await execa('git', ['-C', root, 'config', 'user.email', config.git.user_email]);
  }
}

export async function currentCommit(paths: RunPaths): Promise<string> {
  const root = await resolveGitWorktreeRoot(paths) ?? paths.target;
  const result = await execa('git', ['-C', root, 'rev-parse', 'HEAD'], { reject: false });
  if (result.exitCode !== 0) return 'NO_HEAD';
  return result.stdout.trim();
}

export async function hasTrackedHead(paths: RunPaths): Promise<boolean> {
  const root = await resolveGitWorktreeRoot(paths) ?? paths.target;
  const result = await execa('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { reject: false });
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
  const root = await resolveGitWorktreeRoot(paths) ?? paths.target;
  const bestTag = await execa('git', ['-C', root, 'rev-parse', '--verify', 'refs/tags/wici/best'], {
    reject: false
  });
  const rollbackTarget = bestTag.exitCode === 0 ? 'wici/best' : bestCommit;
  if (rollbackTarget && rollbackTarget !== 'NO_HEAD') {
    await git(paths, ['reset', '--hard', rollbackTarget]);
  } else {
    await git(paths, ['restore', '--staged', '--worktree', '.'], false);
  }
  await git(paths, ['clean', '-fd', ...(await gitCleanExcludes(paths))], false);
}

export async function resetToCommit(paths: RunPaths, commit: string): Promise<void> {
  if (!commit || commit === 'NO_HEAD') {
    throw new Error(`Cannot reset to invalid WiCi checkpoint commit: ${commit}`);
  }
  await git(paths, ['reset', '--hard', commit]);
  await git(paths, ['clean', '-fd', ...(await gitCleanExcludes(paths))], false);
}

async function gitCleanExcludes(paths: RunPaths): Promise<string[]> {
  const root = await resolveGitWorktreeRoot(paths) ?? paths.target;
  const targetPrefix = await toGitRelativePath(root, paths.target);
  if (targetPrefix.startsWith('..') || isAbsolute(targetPrefix)) return [];
  const prefix = targetPrefix ? `${targetPrefix}/` : '';
  return ['-e', `${prefix}.thinkless/`, '-e', `${prefix}.thinkless*/`, '-e', `${prefix}.wici/`];
}

async function toGitRelativePath(root: string, path: string): Promise<string> {
  const [canonicalRoot, canonicalPath] = await Promise.all([
    canonicalExistingPath(root),
    canonicalExistingPath(path)
  ]);
  const rel = relative(canonicalRoot, canonicalPath);
  return rel.split('\\').join('/');
}
