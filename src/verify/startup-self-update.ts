import { readFile } from 'node:fs/promises';
import {
  compareReleaseVersions,
  runThinklessStartupSelfUpdate,
  type ThinklessReleaseInfo
} from '../supervisor/selfupdate.js';

async function main(): Promise<void> {
  assert(compareReleaseVersions('0.1.4', 'v0.1.5') < 0, 'release comparison should normalize v-prefixed tags');
  assert(compareReleaseVersions('v0.1.5', '0.1.5') === 0, 'same release versions should compare equal');
  const packageVersion = (JSON.parse(await readFile('package.json', 'utf8')) as { version: string }).version;
  const nextRelease = nextPatchVersion(packageVersion);
  const nextReleaseTag = `v${nextRelease}`;

  const disabled = await runThinklessStartupSelfUpdate({ THINKLESS_SELF_UPDATE: '0' });
  assert(disabled.action === 'disabled' && disabled.checked === false, `self-update disable failed: ${JSON.stringify(disabled)}`);

  const failOpen = await runThinklessStartupSelfUpdate({}, {
    latestRelease: async () => {
      throw new Error('network unavailable');
    },
    runCommand: commandRecorder([]).run
  });
  assert(failOpen.action === 'failed-open' && failOpen.error?.includes('network unavailable'), `network errors must fail open: ${JSON.stringify(failOpen)}`);

  const current = await runThinklessStartupSelfUpdate({}, {
    latestRelease: latest(packageVersion),
    runCommand: commandRecorder([]).run
  });
  assert(current.action === 'current', `current version should not update: ${JSON.stringify(current)}`);

  const dirtyCommands: Array<{ command: string; args: string[] }> = [];
  const dirty = await runThinklessStartupSelfUpdate({}, {
    latestRelease: latest(nextRelease),
    runCommand: commandRecorder(dirtyCommands, { git: true, dirty: true }).run
  });
  assert(dirty.action === 'skipped-dirty-checkout', `dirty checkouts must not update: ${JSON.stringify(dirty)}`);
  assert(!dirtyCommands.some((call) => call.command === 'npm'), `dirty checkout should not run npm: ${JSON.stringify(dirtyCommands)}`);

  const globalCommands: Array<{ command: string; args: string[] }> = [];
  const globalInstall = await runThinklessStartupSelfUpdate({}, {
    latestRelease: latest(nextRelease),
    runCommand: commandRecorder(globalCommands, { git: false }).run
  });
  assert(globalInstall.action === 'updated-global-install', `non-git installs should update globally: ${JSON.stringify(globalInstall)}`);
  assert(
    globalCommands.some((call) => call.command === 'npm' && call.args.includes('install') && call.args.includes('-g') && call.args.includes('https://example.invalid/thinkless.tgz')),
    `global install did not use release tarball: ${JSON.stringify(globalCommands)}`
  );

  const parentGitCommands: Array<{ command: string; args: string[] }> = [];
  const parentGitInstall = await runThinklessStartupSelfUpdate({}, {
    latestRelease: latest(nextRelease),
    runCommand: commandRecorder(parentGitCommands, { git: true, gitTopLevelMatches: false }).run
  });
  assert(parentGitInstall.action === 'updated-global-install', `installs under a parent git worktree should update globally: ${JSON.stringify(parentGitInstall)}`);
  assert(
    parentGitCommands.some((call) => call.command === 'npm' && call.args.includes('install') && call.args.includes('-g') && call.args.includes('https://example.invalid/thinkless.tgz')),
    `parent git install did not use release tarball: ${JSON.stringify(parentGitCommands)}`
  );

  const gitCommands: Array<{ command: string; args: string[] }> = [];
  const gitInstall = await runThinklessStartupSelfUpdate({}, {
    latestRelease: latest(nextRelease),
    runCommand: commandRecorder(gitCommands, { git: true, dirty: false }).run
  });
  assert(gitInstall.action === 'updated-git-checkout', `clean git checkout should update from release tag: ${JSON.stringify(gitInstall)}`);
  assert(gitCommands.some((call) => call.command === 'git' && call.args.includes('fetch') && call.args.includes(nextReleaseTag)), `git update should fetch latest tag: ${JSON.stringify(gitCommands)}`);
  assert(gitCommands.some((call) => call.command === 'git' && call.args.includes('checkout') && call.args.includes(nextReleaseTag)), `git update should checkout latest tag: ${JSON.stringify(gitCommands)}`);
  assert(gitCommands.some((call) => call.command === 'npm' && call.args.join(' ') === 'install'), `git update should install dependencies: ${JSON.stringify(gitCommands)}`);
  assert(gitCommands.some((call) => call.command === 'npm' && call.args.join(' ') === 'run build'), `git update should rebuild: ${JSON.stringify(gitCommands)}`);

  const cli = await readFile('src/cli.tsx', 'utf8');
  assert(cli.includes('runThinklessStartupSelfUpdate') && cli.includes('maybeRunThinklessStartupSelfUpdate'), 'CLI must run startup self-update before command handling');
  assert(
    cli.includes('spawnSync(process.execPath, process.argv.slice(1)') &&
      cli.includes('THINKLESS_SELF_UPDATE_REEXECED') &&
      cli.includes("updated-global-install") &&
      cli.includes("updated-git-checkout"),
    'CLI must restart the current command after a successful Thinkless self-update'
  );

  console.log(JSON.stringify({ ok: true, fail_open: true, dirty_skip: true, global_install: true, git_update: true, reexec_after_update: true }, null, 2));
}

function latest(version: string): () => Promise<ThinklessReleaseInfo> {
  return async () => ({
    version,
    tagName: version.startsWith('v') ? version : `v${version}`,
    tarballUrl: 'https://example.invalid/thinkless.tgz'
  });
}

function nextPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`package version must be semver-like for self-update verifier: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function commandRecorder(
  calls: Array<{ command: string; args: string[] }>,
  options: { git?: boolean; dirty?: boolean; gitTopLevelMatches?: boolean } = {}
): { run: (command: string, args: string[]) => Promise<{ exitCode: number; stdout: string; all: string }> } {
  return {
    run: async (command, args) => {
      calls.push({ command, args });
      if (command === 'git' && args.includes('rev-parse')) {
        if (args.includes('--show-toplevel')) {
          const stdout = options.gitTopLevelMatches === false ? '/tmp/parent-worktree\n' : `${process.cwd()}\n`;
          return { exitCode: 0, stdout, all: stdout };
        }
        return { exitCode: options.git === false ? 1 : 0, stdout: options.git === false ? '' : 'true\n', all: options.git === false ? '' : 'true\n' };
      }
      if (command === 'git' && args.includes('status')) {
        const stdout = options.dirty ? ' M src/local-dev.ts\n' : '';
        return { exitCode: 0, stdout, all: stdout };
      }
      return { exitCode: 0, stdout: 'ok\n', all: 'ok\n' };
    }
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
