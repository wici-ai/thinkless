import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { ensureRunDirs, ensureTargetGitignore, latestNumberedRunSessionDir, runPaths, THINKLESS_SESSION_DIR_ENV } from '../shared/paths.js';

const root = resolve('fixture/state-paths-target');

async function main(): Promise<void> {
  const priorSessionDir = process.env[THINKLESS_SESSION_DIR_ENV];
  delete process.env[THINKLESS_SESSION_DIR_ENV];
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  try {
    const fresh = join(root, 'fresh');
    await mkdir(fresh, { recursive: true });
    const freshPaths = runPaths(fresh);
    assert(freshPaths.wici.endsWith('/.thinkless'), `fresh state should use .thinkless, got ${freshPaths.wici}`);
    assert(freshPaths.goalDoc.endsWith('/fresh/GOAL.md'), `fresh explicit target GOAL.md should be target-root, got ${freshPaths.goalDoc}`);
    assert(freshPaths.plan.endsWith('/fresh/PLAN.md'), `fresh explicit target PLAN.md should be target-root, got ${freshPaths.plan}`);
    await ensureRunDirs(freshPaths);
    assert(existsSync(join(fresh, '.thinkless', 'artifacts')), 'ensureRunDirs did not create .thinkless artifacts');
    assert(!existsSync(join(fresh, '.wici')), 'fresh state should not create .wici');

    const inertLegacy = join(root, 'inert-legacy');
    await mkdir(join(inertLegacy, '.wici'), { recursive: true });
    await writeFile(join(inertLegacy, '.wici', 'chat.jsonl'), '{}\n');
    const inertLegacyPaths = runPaths(inertLegacy);
    assert(inertLegacyPaths.wici.endsWith('/.thinkless'), `inert legacy state should not be reused, got ${inertLegacyPaths.wici}`);

    const numbered = join(root, 'numbered');
    await mkdir(join(numbered, '.thinkless1'), { recursive: true });
    await mkdir(join(numbered, '.thinkless2'), { recursive: true });
    await writeFile(join(numbered, '.thinkless1', 'chat.jsonl'), '{}\n');
    let numberedPaths = runPaths(numbered);
    assert(numberedPaths.wici.endsWith('/.thinkless1'), `numbered session should use .thinkless1, got ${numberedPaths.wici}`);
    assert(numberedPaths.plan.endsWith('/.thinkless1/PLAN.md'), `numbered PLAN.md should be session-local, got ${numberedPaths.plan}`);
    assert(numberedPaths.goalDoc.endsWith('/.thinkless1/GOAL.md'), `numbered GOAL.md should be session-local, got ${numberedPaths.goalDoc}`);
    await mkdir(join(numbered, '.thinkless3'), { recursive: true });
    await writeFile(join(numbered, '.thinkless3', 'goal.json'), '{}\n');
    numberedPaths = runPaths(numbered);
    assert(numberedPaths.wici.endsWith('/.thinkless3'), `latest non-empty numbered session should win, got ${numberedPaths.wici}`);
    assert(latestNumberedRunSessionDir(numbered)?.endsWith('/.thinkless3'), 'latest numbered run session should ignore chat-only numbered sessions');

    const preferCurrent = join(root, 'prefer-current-over-chat-numbered');
    await mkdir(join(preferCurrent, '.thinkless1'), { recursive: true });
    await mkdir(join(preferCurrent, '.thinkless'), { recursive: true });
    await writeFile(join(preferCurrent, '.thinkless1', 'runtime-selection.json'), '{}\n');
    await writeFile(join(preferCurrent, '.thinkless', 'checkpoint.json'), '{}\n');
    const preferCurrentPaths = runPaths(preferCurrent);
    assert(preferCurrentPaths.wici.endsWith('/.thinkless'), `durable current run should beat chat-only numbered session, got ${preferCurrentPaths.wici}`);

    const preferLegacy = join(root, 'prefer-legacy-over-chat-numbered');
    await mkdir(join(preferLegacy, '.thinkless1'), { recursive: true });
    await mkdir(join(preferLegacy, '.wici'), { recursive: true });
    await writeFile(join(preferLegacy, '.thinkless1', 'chat.jsonl'), '{}\n');
    await writeFile(join(preferLegacy, '.wici', 'checkpoint.json'), '{}\n');
    const preferLegacyPaths = runPaths(preferLegacy);
    assert(preferLegacyPaths.wici.endsWith('/.wici'), `durable legacy run should beat chat-only numbered session, got ${preferLegacyPaths.wici}`);

    process.env[THINKLESS_SESSION_DIR_ENV] = join(numbered, '.thinkless4');
    const overridePaths = runPaths(numbered);
    assert(overridePaths.wici.endsWith('/.thinkless4'), `session env override should win, got ${overridePaths.wici}`);
    assert(overridePaths.plan.endsWith('/.thinkless4/PLAN.md'), `session env PLAN.md should be session-local, got ${overridePaths.plan}`);
    delete process.env[THINKLESS_SESSION_DIR_ENV];

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
    assert(gitignore.includes('.thinkless*/'), '.gitignore missing numbered .thinkless*/');
    assert(gitignore.includes('.wici/'), '.gitignore missing legacy .wici/');

    const cliSource = await readFile(resolve('src/cli.tsx'), 'utf8');
    assert(cliSource.includes('migrateCompatibleWorkspaceRun(current)'), 'resume target does not migrate compatible legacy workspaces');
    assert(cliSource.includes('migrated-from-fixture:true'), 'migration plan must mark fixture completion as not product completion');

    console.log(JSON.stringify({ ok: true, fresh_state: '.thinkless', numbered_state: '.thinklessN', legacy_state: '.wici' }, null, 2));
  } finally {
    if (priorSessionDir === undefined) delete process.env[THINKLESS_SESSION_DIR_ENV];
    else process.env[THINKLESS_SESSION_DIR_ENV] = priorSessionDir;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  await main();
} finally {
  await rm(root, { recursive: true, force: true });
}
