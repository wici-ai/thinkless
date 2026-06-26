import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { execa } from 'execa';

const repo = resolve('fixture/release-tag-target');
const fakeBin = resolve('fixture/release-tag-bin');
const releaseTagScript = resolve('src/release/tag.ts');

async function main(): Promise<void> {
  await rm(repo, { recursive: true, force: true });
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(repo, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFakeNpm();
  await git(['init']);
  await git(['config', 'user.name', 'WiCi Verify']);
  await git(['config', 'user.email', 'verify@example.invalid']);
  await writeFile(join(repo, 'README.md'), '# release tag fixture\n');
  await git(['add', 'README.md']);
  await git(['commit', '-m', 'test: initial release tag fixture']);

  const blocked = await runTag('999.999.998', '7');
  assert(blocked.exitCode !== 0, `release tag should fail when preflight fails:\n${blocked.all}`);
  assert((blocked.all ?? '').includes('release:tag blocked: release:preflight failed; no tag created for 999.999.998.'), `blocked release tag should explain that no tag was created:\n${blocked.all}`);
  assert((await tags('999.999.998')).trim() === '', 'release tag command created a tag after failed preflight');

  const passed = await runTag('999.999.997', '0');
  assert(passed.exitCode === 0, `release tag should create a tag after preflight succeeds:\n${passed.all}`);
  assert((await tags('999.999.997')).trim() === '999.999.997', 'release tag command did not create the expected local tag after preflight success');
  const tagObjectType = (await git(['cat-file', '-t', '999.999.997'])).trim();
  assert(tagObjectType === 'tag', `release tag must be annotated, got git object type ${tagObjectType}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target: repo,
        blocked_failed_preflight: true,
        no_tag_after_failed_preflight: true,
        creates_annotated_tag_after_preflight: true,
        pushed: false
      },
      null,
      2
    )
  );
}

async function writeFakeNpm(): Promise<void> {
  const path = join(fakeBin, 'npm');
  await writeFile(
    path,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "run" && "$2" == "release:preflight" ]]; then
  exit "\${WICI_FAKE_PREFLIGHT_EXIT:-0}"
fi
echo "unexpected fake npm invocation: $*" >&2
exit 64
`
  );
  await chmod(path, 0o755);
  await writeFile(
    join(fakeBin, 'npm.cmd'),
    '@echo off\r\nif "%~1"=="run" if "%~2"=="release:preflight" exit /b %WICI_FAKE_PREFLIGHT_EXIT%\r\necho unexpected fake npm invocation: %* 1>&2\r\nexit /b 64\r\n'
  );
}

async function runTag(tag: string, preflightExit: string): Promise<{ exitCode?: number; all?: string }> {
  return execa(process.execPath, ['--import', 'tsx', releaseTagScript, tag], {
    cwd: repo,
    all: true,
    reject: false,
    env: {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      WICI_FAKE_PREFLIGHT_EXIT: preflightExit
    },
    timeout: 30_000
  });
}

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', repo, ...args], { all: true });
  return result.all ?? result.stdout;
}

async function tags(pattern: string): Promise<string> {
  return git(['tag', '--list', pattern]);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
