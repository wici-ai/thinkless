import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { execa } from 'execa';

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'thinkless-clean-install-'));
  const home = join(temp, 'home');
  const prefix = join(temp, 'npm-prefix');
  const fakeBin = join(temp, 'agent-tools');
  const workspace = join(temp, 'workspace');
  const packDir = join(temp, 'pack');

  try {
    await mkdir(home, { recursive: true });
    await mkdir(prefix, { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await mkdir(packDir, { recursive: true });
    await writeFakeCommands(fakeBin);

    const build = await execa('npm', ['run', 'build'], { all: true, reject: false, timeout: 120_000 });
    assert(build.exitCode === 0, `build failed before clean install:\n${build.all}`);

    const pack = await execa('npm', ['pack', '--pack-destination', packDir], { all: true, reject: false, timeout: 60_000 });
    assert(pack.exitCode === 0, `npm pack failed:\n${pack.all}`);
    const tarballName = pack.stdout.trim().split('\n').filter(Boolean).at(-1);
    assert(tarballName, `npm pack did not report a tarball name:\n${pack.all}`);
    const tarball = join(packDir, tarballName);
    assert(existsSync(tarball), `packed tarball missing: ${tarball}`);

    const installEnv = {
      ...process.env,
      HOME: home,
      USER: 'thinkless-test',
      CI: '1',
      NPM_CONFIG_PREFIX: prefix,
      npm_config_prefix: prefix,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      THINKLESS_TARBALL_URL: `file://${tarball}`,
      THINKLESS_AUTH_ONBOARDING: '0',
      THINKLESS_SELF_UPDATE: '0',
      FORCE_COLOR: '0',
      TERM: 'xterm-256color'
    };

    const install = await execa('bash', ['scripts/install.sh'], {
      cwd: resolve('.'),
      env: installEnv,
      all: true,
      reject: false,
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 10
    });
    assert(install.exitCode === 0, `first clean install failed with ${install.exitCode}:\n${install.all}`);
    assert((install.all ?? '').includes('verified node, npm, thinkless, codex, claude, and gh on PATH'), `installer did not verify all commands:\n${install.all}`);

    const zprofile = await readFile(join(home, '.zprofile'), 'utf8').catch(() => '');
    const zshrc = await readFile(join(home, '.zshrc'), 'utf8').catch(() => '');
    if (process.platform === 'darwin') {
      assert(zprofile.includes(fakeBin) && zshrc.includes(fakeBin), `zsh startup files must include discovered nonstandard CLI bin:\n.zprofile=${zprofile}\n.zshrc=${zshrc}`);
      assert(zprofile.includes('/npm-prefix/bin') && zshrc.includes('/npm-prefix/bin'), 'zsh startup files must include npm global bin');
    }

    const version = await runCleanShell(home, workspace, 'thinkless --version');
    assert(version.exitCode === 0, `clean shell could not run thinkless --version:\n${version.all}`);

    const initRepo = await execa('git', ['-C', workspace, 'init'], { all: true, reject: false, timeout: 30_000 });
    assert(initRepo.exitCode === 0, `could not init clean-shell workspace git repo:\n${initRepo.all}`);

    const bare = await runCleanShell(
      home,
      workspace,
      'THINKLESS_SELF_UPDATE=0 WICI_TUI_RENDER_ONCE=1 WICI_TUI_RENDER_ONCE_DELAY_MS=0 FORCE_COLOR=0 TERM=xterm-256color thinkless'
    );
    const ui = stripAnsi(bare.all ?? '');
    assert(bare.exitCode === 0, `bare thinkless failed in clean shell with ${bare.exitCode}:\n${ui}`);
    assert(ui.includes('CHAT agent=claude') && ui.includes('effort=high'), `bare thinkless did not load default chat runtime params:\n${ui}`);
    assert(ui.includes('Current goal: none'), `bare thinkless did not render the fresh default TUI state:\n${ui}`);
    assert(existsSync(join(workspace, '.thinkless1')), 'bare thinkless did not allocate .thinkless1/ in the current git root');
    assert(!existsSync(join(workspace, '.thinkless')), 'bare thinkless should not allocate the default .thinkless/ directory');

    const bareAgain = await runCleanShell(
      home,
      workspace,
      'THINKLESS_SELF_UPDATE=0 WICI_TUI_RENDER_ONCE=1 WICI_TUI_RENDER_ONCE_DELAY_MS=0 FORCE_COLOR=0 TERM=xterm-256color thinkless'
    );
    assert(bareAgain.exitCode === 0, `second bare thinkless failed in clean shell with ${bareAgain.exitCode}:\n${stripAnsi(bareAgain.all ?? '')}`);
    assert(existsSync(join(workspace, '.thinkless2')), 'second bare thinkless did not allocate .thinkless2/ in the current git root');

    console.log(
      JSON.stringify(
        {
          ok: true,
          clean_home_install: true,
          first_install_exposes_thinkless: true,
          bare_thinkless_loads_defaults: true,
          bare_thinkless_allocates_numbered_sessions: true,
          fake_cli_bin_discovered: fakeBin
        },
        null,
        2
      )
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function writeFakeCommands(fakeBin: string): Promise<void> {
  await Promise.all([
    writeExecutable(
      join(fakeBin, 'codex'),
      `#!/usr/bin/env sh
echo "codex 0.0.0"
`
    ),
    writeExecutable(
      join(fakeBin, 'claude'),
      `#!/usr/bin/env sh
echo "claude 0.0.0"
`
    ),
    writeExecutable(
      join(fakeBin, 'gh'),
      `#!/usr/bin/env sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
echo "gh 0.0.0"
`
    ),
    writeExecutable(
      join(fakeBin, 'brew'),
      `#!/usr/bin/env sh
case "$1" in
  --version) echo "Homebrew 0.0.0"; exit 0 ;;
  update|install) exit 0 ;;
  shellenv) exit 0 ;;
esac
echo "brew 0.0.0"
`
    )
  ]);
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

async function runCleanShell(home: string, cwd: string, command: string): Promise<{ exitCode: number; all?: string }> {
  const env = {
    HOME: home,
    USER: 'thinkless-test',
    CI: '1',
    SHELL: process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
    PATH: process.platform === 'darwin' ? '/usr/bin:/bin:/usr/sbin:/sbin' : `${join(dirname(process.execPath))}${delimiter}${process.env.PATH ?? ''}`,
    THINKLESS_SELF_UPDATE: '0',
    FORCE_COLOR: '0',
    TERM: 'xterm-256color'
  };
  if (process.platform === 'darwin' && existsSync('/bin/zsh')) {
    const result = await execa('/bin/zsh', ['-lc', command], { cwd, env, all: true, reject: false, timeout: 30_000, maxBuffer: 1024 * 1024 * 5 });
    return { exitCode: result.exitCode ?? 1, all: result.all };
  }
  const prefix = join(home, '..', 'npm-prefix', 'bin');
  const result = await execa('/bin/bash', ['-lc', `export PATH="${prefix}:$PATH"; ${command}`], { cwd, env, all: true, reject: false, timeout: 30_000, maxBuffer: 1024 * 1024 * 5 });
  return { exitCode: result.exitCode ?? 1, all: result.all };
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B[=>]/g, '');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
