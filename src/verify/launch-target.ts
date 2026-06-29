import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultCurrentTarget, findContainingGitRootSync, resolveFreshTargetOption } from '../shared/launchTarget.js';

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'thinkless-launch-target-'));
  try {
    const plain = join(temp, 'plain-start');
    await mkdir(plain);
    assert(resolveFreshTargetOption(undefined, plain) === resolve(plain), 'fresh launch outside git must target the startup directory');
    assert(defaultCurrentTarget(plain) === resolve(plain), 'default current target outside git must be the startup directory');

    const repo = join(temp, 'repo-start');
    const nested = join(repo, 'packages', 'app');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(nested, { recursive: true });
    assert(findContainingGitRootSync(nested) === resolve(repo), 'filesystem git discovery must find parent .git without requiring git on PATH');
    assert(resolveFreshTargetOption(undefined, nested) === resolve(repo), 'fresh launch inside a git tree must target the real repo root');
    assert(resolveFreshTargetOption('explicit-target', nested) === resolve(nested, 'explicit-target'), 'explicit --target must remain relative to the startup directory');

    console.log(JSON.stringify({ ok: true, startup_dir_target: true, fs_git_fallback: true }, null, 2));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
