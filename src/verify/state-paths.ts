import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { ensureRunDirs, ensureTargetGitignore, runPaths } from '../shared/paths.js';

const root = resolve('fixture/state-paths-target');

async function main(): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const fresh = join(root, 'fresh');
  await mkdir(fresh, { recursive: true });
  const freshPaths = runPaths(fresh);
  assert(freshPaths.wici.endsWith('/.thinkless'), `fresh state should use .thinkless, got ${freshPaths.wici}`);
  await ensureRunDirs(freshPaths);
  assert(existsSync(join(fresh, '.thinkless', 'artifacts')), 'ensureRunDirs did not create .thinkless artifacts');
  assert(!existsSync(join(fresh, '.wici')), 'fresh state should not create .wici');

  const legacy = join(root, 'legacy');
  await mkdir(join(legacy, '.wici'), { recursive: true });
  await writeFile(join(legacy, '.wici', 'checkpoint.json'), '{}\n');
  const legacyPaths = runPaths(legacy);
  assert(legacyPaths.wici.endsWith('/.wici'), `legacy state should keep using .wici, got ${legacyPaths.wici}`);
  assert(legacyPaths.legacyStateDir.endsWith('/.wici'), 'legacyStateDir should point at .wici');

  const gitTarget = join(root, 'git-target');
  await mkdir(gitTarget, { recursive: true });
  await execa('git', ['-C', gitTarget, 'init'], { all: true });
  await ensureTargetGitignore(runPaths(gitTarget));
  const gitignore = await readFile(join(gitTarget, '.gitignore'), 'utf8');
  assert(gitignore.includes('.thinkless/'), '.gitignore missing .thinkless/');
  assert(gitignore.includes('.wici/'), '.gitignore missing legacy .wici/');

  const cliSource = await readFile(resolve('src/cli.tsx'), 'utf8');
  assert(cliSource.includes('migrateCompatibleWorkspaceRun(current)'), 'resume target does not migrate compatible legacy workspaces');
  assert(cliSource.includes('migrated-from-fixture:true'), 'migration plan must mark fixture completion as not product completion');

  console.log(JSON.stringify({ ok: true, fresh_state: '.thinkless', legacy_state: '.wici' }, null, 2));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  await main();
} finally {
  await rm(root, { recursive: true, force: true });
}
