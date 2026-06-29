import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function resolveFreshTargetOption(target: string | undefined, cwd = process.cwd()): string {
  if (target?.trim()) return resolve(cwd, target);
  return resolve(gitTopLevelSync(cwd) ?? cwd);
}

export function defaultCurrentTarget(cwd = process.cwd()): string {
  return resolve(gitTopLevelSync(cwd) ?? cwd);
}

export function gitTopLevelSync(cwd = process.cwd()): string | null {
  try {
    const output = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return output.trim() || null;
  } catch {
    return findContainingGitRootSync(cwd);
  }
}

export function findContainingGitRootSync(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
