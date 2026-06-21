import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

async function main(): Promise<void> {
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
    name: string;
    bin: Record<string, string>;
    scripts: Record<string, string>;
  };
  assert(pkg.name === 'thinkless', `package name must be thinkless, got ${pkg.name}`);
  assert(pkg.scripts.postinstall === 'node scripts/postinstall.mjs', 'package install must run the Thinkless dependency bootstrap hook');
  assert(Object.keys(pkg.bin).length === 1 && Boolean(pkg.bin.thinkless), `package must expose only the thinkless binary: ${JSON.stringify(pkg.bin)}`);

  const temp = await mkdtemp(join(tmpdir(), 'thinkless-install-bootstrap-'));
  try {
    const bundle = join(temp, 'bundle');
    const home = join(temp, 'home');
    await mkdir(join(bundle, '.codex'), { recursive: true });
    await mkdir(join(bundle, '.claude'), { recursive: true });
    await writeFile(join(bundle, '.codex', 'config.toml'), 'model = "gpt-5.5"\n');
    await writeFile(join(bundle, '.codex', 'auth.json'), '{"tokens":"redacted"}\n');
    await writeFile(join(bundle, '.claude', 'settings.json'), '{"permissions":{"allow":[]}}\n');
    await writeFile(join(bundle, '.claude', '.credentials.json'), '{"credentials":"redacted"}\n');

    const planResult = await execa(process.execPath, ['scripts/postinstall.mjs', '--plan-json'], {
      all: true,
      reject: false,
      env: {
        THINKLESS_BOOTSTRAP_TEST_PLATFORM: 'darwin',
        THINKLESS_BOOTSTRAP_TEST_MISSING: 'brew,git,node,npm,gh,codex,claude',
        THINKLESS_BOOTSTRAP_TEST_HOME: home,
        THINKLESS_CONFIG_BUNDLE: bundle
      }
    });
    assert(planResult.exitCode === 0, `postinstall plan failed:\n${planResult.all}`);
    const plan = JSON.parse(planResult.stdout) as {
      missing: string[];
      steps: Array<{ id: string; command: string }>;
      configCopies: Array<{ id: string; source: string; destination: string; mode: number }>;
    };
    for (const command of ['brew', 'git', 'node', 'npm', 'gh', 'codex', 'claude']) {
      assert(plan.missing.includes(command), `plan must inventory missing ${command}: ${JSON.stringify(plan.missing)}`);
    }
    const stepIds = plan.steps.map((step) => step.id);
    assert(stepIds.indexOf('ensure-xcode-tools') !== -1 && stepIds.indexOf('ensure-xcode-tools') < stepIds.indexOf('verify-sudo'), `plan must wait for Apple Command Line Tools before sudo/Homebrew: ${JSON.stringify(stepIds)}`);
    assert(stepIds.indexOf('verify-sudo') !== -1 && stepIds.indexOf('verify-sudo') < stepIds.indexOf('install-homebrew'), `plan must verify sudo before Homebrew install: ${JSON.stringify(stepIds)}`);
    assert(plan.steps.some((step) => step.id === 'ensure-xcode-tools' && step.command.includes('xcode-select --install') && step.command.includes('THINKLESS_XCODE_WAIT_SECONDS')), 'plan must wait for the Apple Command Line Tools installer instead of exiting');
    assert(plan.steps.some((step) => step.id === 'verify-sudo' && step.command.includes('sudo -v')), 'plan must check sudo access before macOS host mutation');
    assert(plan.steps.some((step) => step.id === 'install-homebrew' && step.command.includes('Homebrew/install/HEAD/install.sh')), 'plan must install missing Homebrew');
    assert(plan.steps.some((step) => step.id === 'install-brew-packages' && step.command.includes('brew install git node gh')), 'plan must use Homebrew to install git, Node.js/npm, and GitHub CLI');
    assert(plan.steps.some((step) => step.id === 'install-codex' && step.command.includes('https://chatgpt.com/codex/install.sh')), 'plan must install Codex CLI from the official installer');
    assert(plan.steps.some((step) => step.id === 'install-claude' && step.command.includes('https://claude.ai/install.sh')), 'plan must install Claude Code CLI from the official installer');
    assert(plan.configCopies.some((copy) => copy.id === 'codex-config' && copy.destination.endsWith(join('.codex', 'config.toml'))), 'plan must copy Codex config.toml to user home');
    assert(plan.configCopies.some((copy) => copy.id === 'codex-auth' && copy.destination.endsWith(join('.codex', 'auth.json')) && copy.mode === 0o600), 'plan must copy Codex auth.json with private file mode');
    assert(plan.configCopies.some((copy) => copy.id === 'claude-settings' && copy.destination.endsWith(join('.claude', 'settings.json'))), 'plan must copy Claude settings.json to user home');
    assert(plan.configCopies.some((copy) => copy.id === 'claude-credentials' && copy.destination.endsWith(join('.claude', '.credentials.json')) && copy.mode === 0o600), 'plan must copy Claude credentials with private file mode');

    const userToolPlan = await execa(process.execPath, ['scripts/postinstall.mjs', '--plan-json'], {
      all: true,
      reject: false,
      env: {
        THINKLESS_BOOTSTRAP_TEST_PLATFORM: 'darwin',
        THINKLESS_BOOTSTRAP_TEST_MISSING: 'codex,claude',
        THINKLESS_BOOTSTRAP_TEST_HOME: home
      }
    });
    assert(userToolPlan.exitCode === 0, `postinstall user-tool plan failed:\n${userToolPlan.all}`);
    const userToolStepIds = (JSON.parse(userToolPlan.stdout) as { steps: Array<{ id: string }> }).steps.map((step) => step.id);
    assert(!userToolStepIds.includes('ensure-xcode-tools') && !userToolStepIds.includes('verify-sudo'), `Codex/Claude-only installs must not require CLT or sudo: ${JSON.stringify(userToolStepIds)}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }

  const bootstrap = await readFile('scripts/bootstrap-macos.sh', 'utf8');
  const postinstall = await readFile('scripts/postinstall.mjs', 'utf8');
  const publicInstaller = await readFile('scripts/install.sh', 'utf8');
  const publicReleaseWorkflow = await readFile('.github/workflows/public-release.yml', 'utf8');
  const oldReleaseRepoName = ['thinkless', 'releases'].join('-');
  const oldDevRepoName = ['thinkless', 'dev'].join('-');
  const oldSplitTokenName = ['THINKLESS', 'PUBLIC', 'RELEASE', 'TOKEN'].join('_');
  const oldSplitInputName = ['public', 'repo'].join('_');
  const forbiddenSudoNpm = ['sudo', 'npm'].join(' ');
  const installTail = 'verify_required_commands\nprint_path_activation_note\nrun_auth_onboarding';
  const authPrompts = ['Sign in to Codex now?', 'Sign in to GitHub CLI now?', 'Sign in to Claude Code now?'];
  assert(postinstall.includes("join(homedir(), '.local', 'bin')") && postinstall.includes('/opt/homebrew/bin'), 'postinstall must check common native installer paths before verification');
  assert(postinstall.includes('xcode-select --install') && postinstall.includes('THINKLESS_XCODE_WAIT_SECONDS'), 'postinstall must wait for Apple Command Line Tools when Homebrew is needed');
  assert(postinstall.includes('sudo access is required on macOS') && postinstall.includes('sudo -v'), 'postinstall must require sudo access before installing Homebrew on macOS');
  assert(bootstrap.includes('brew install "${packages[@]}"') && bootstrap.includes('command_exists gh'), 'zero-npm macOS bootstrap must install missing Node/npm, git, and GitHub CLI through Homebrew even when npm already exists');
  assert(bootstrap.includes('https://chatgpt.com/codex/install.sh') && bootstrap.includes('https://claude.ai/install.sh'), 'zero-npm macOS bootstrap must explicitly install Codex and Claude CLIs instead of relying only on npm postinstall');
  assert(bootstrap.includes('ensure_xcode_tools') && bootstrap.includes('xcode-select --install') && bootstrap.includes('THINKLESS_XCODE_WAIT_SECONDS'), 'zero-npm macOS bootstrap must wait for Apple Command Line Tools instead of requiring a rerun');
  assert(bootstrap.includes('npm prefix -g') && bootstrap.includes('$HOME/.zprofile') && bootstrap.includes('$HOME/.zshrc'), 'zero-npm macOS bootstrap must persist the npm global bin path to common zsh startup files');
  assert(bootstrap.includes('print_path_activation_note') && bootstrap.includes('open a new terminal') && bootstrap.includes('export PATH=\\"$bin:\\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\\$PATH\\"') && bootstrap.includes('&& thinkless'), 'zero-npm macOS bootstrap must tell users how to activate PATH and launch Thinkless in the current terminal');
  assert(bootstrap.includes('env -i HOME="$HOME"') && bootstrap.includes('/bin/zsh -lc') && bootstrap.includes('/bin/zsh -ic') && bootstrap.includes('for cmd in thinkless codex claude gh') && bootstrap.includes('codex --version >/dev/null') && bootstrap.includes('claude --version >/dev/null'), 'zero-npm macOS bootstrap must verify Thinkless, Codex, Claude, and GitHub CLI from clean zsh login and interactive shells');
  assert(bootstrap.includes(installTail), 'zero-npm macOS bootstrap must verify commands, print PATH guidance, and run auth onboarding before reporting success');
  assert(bootstrap.includes('THINKLESS_AUTH_ONBOARDING') && bootstrap.includes('true 2>/dev/null < /dev/tty > /dev/tty') && bootstrap.includes('gh auth login') && bootstrap.includes('run_tty "$codex_cmd"') && bootstrap.includes('run_tty "claude"') && authPrompts.every((prompt) => bootstrap.includes(prompt)), 'zero-npm macOS bootstrap must offer terminal-backed auth onboarding for Codex, Claude, and GitHub CLI');
  assert(bootstrap.includes('auth onboarding status') && bootstrap.includes('setup command: gh auth login') && bootstrap.includes('auth onboarding skipped') && bootstrap.includes('THINKLESS_AUTH_PENDING=1') && bootstrap.includes('auth is pending') && bootstrap.includes('OPENAI_API_KEY') && bootstrap.includes('ANTHROPIC_API_KEY'), 'zero-npm macOS bootstrap must distinguish installed commands from pending auth and print setup commands');
  assert(bootstrap.includes('require_sudo_access') && bootstrap.includes('npm link failed') && !bootstrap.includes(forbiddenSudoNpm), 'zero-npm macOS bootstrap must verify sudo without running npm under elevated privileges');
  assert(bootstrap.includes('git@github.com:wici-ai/thinkless.git'), 'zero-npm macOS bootstrap must clone from the public thinkless source repo by default');
  assert(bootstrap.includes('npm ci --foreground-scripts --ignore-scripts=false') && bootstrap.includes('npm link'), 'zero-npm macOS bootstrap must install with lifecycle scripts enabled and expose the Thinkless command');
  assert(publicInstaller.includes('THINKLESS_TARBALL_URL') && publicInstaller.includes('npm install -g --foreground-scripts --ignore-scripts=false "$pkg"'), 'public installer must install from a release tarball without git history and with lifecycle scripts enabled');
  assert(publicInstaller.includes('brew install "${packages[@]}"') && publicInstaller.includes('command_exists gh'), 'public installer must install missing Node/npm, git, and GitHub CLI through Homebrew even when npm already exists');
  assert(publicInstaller.includes('https://chatgpt.com/codex/install.sh') && publicInstaller.includes('https://claude.ai/install.sh'), 'public installer must explicitly install Codex and Claude CLIs before declaring success');
  assert(publicInstaller.includes('ensure_xcode_tools') && publicInstaller.includes('xcode-select --install') && publicInstaller.includes('THINKLESS_XCODE_WAIT_SECONDS'), 'public installer must wait for Apple Command Line Tools instead of requiring a rerun');
  assert(publicInstaller.includes('npm prefix -g') && publicInstaller.includes('$HOME/.zprofile') && publicInstaller.includes('$HOME/.zshrc'), 'public installer must persist the npm global bin path to common zsh startup files');
  assert(publicInstaller.includes('print_path_activation_note') && publicInstaller.includes('open a new terminal') && publicInstaller.includes('export PATH=\\"$bin:\\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\\$PATH\\"') && publicInstaller.includes('&& thinkless'), 'public installer must tell users how to activate PATH and launch Thinkless in the current terminal');
  assert(publicInstaller.includes('env -i HOME="$HOME"') && publicInstaller.includes('/bin/zsh -lc') && publicInstaller.includes('/bin/zsh -ic') && publicInstaller.includes('for cmd in thinkless codex claude gh') && publicInstaller.includes('codex --version >/dev/null') && publicInstaller.includes('claude --version >/dev/null'), 'public installer must verify Thinkless, Codex, Claude, and GitHub CLI from clean zsh login and interactive shells');
  assert(publicInstaller.includes(installTail), 'public installer must verify commands, print PATH guidance, and run auth onboarding before reporting success');
  assert(publicInstaller.includes('THINKLESS_AUTH_ONBOARDING') && publicInstaller.includes('true 2>/dev/null < /dev/tty > /dev/tty') && publicInstaller.includes('gh auth login') && publicInstaller.includes('run_tty "$codex_cmd"') && publicInstaller.includes('run_tty "claude"') && authPrompts.every((prompt) => publicInstaller.includes(prompt)), 'public installer must offer terminal-backed auth onboarding for Codex, Claude, and GitHub CLI');
  assert(publicInstaller.includes('auth onboarding status') && publicInstaller.includes('setup command: gh auth login') && publicInstaller.includes('auth onboarding skipped') && publicInstaller.includes('THINKLESS_AUTH_PENDING=1') && publicInstaller.includes('auth is pending') && publicInstaller.includes('OPENAI_API_KEY') && publicInstaller.includes('ANTHROPIC_API_KEY'), 'public installer must distinguish installed commands from pending auth and print setup commands');
  assert(publicInstaller.includes('require_sudo_access') && publicInstaller.includes('npm global install failed') && !publicInstaller.includes(forbiddenSudoNpm), 'public installer must verify sudo without running npm under elevated privileges');
  assert(publicInstaller.includes('https://github.com/wici-ai/thinkless/releases/latest/download'), 'public installer must default to the public thinkless release repo');
  assert(publicReleaseWorkflow.includes('workflow_dispatch:'), 'public release workflow must be manually triggered');
  assert(!publicReleaseWorkflow.includes('push:') && !publicReleaseWorkflow.includes('pull_request:'), 'public release workflow must not run on pushes or pull requests');
  assert(publicReleaseWorkflow.includes('permissions:') && publicReleaseWorkflow.includes('contents: write'), 'public release workflow must be able to publish releases in this repo');
  assert(publicReleaseWorkflow.includes('GH_TOKEN: ${{ github.token }}') && publicReleaseWorkflow.includes('--repo "$GITHUB_REPOSITORY"'), 'public release workflow must publish to the current public repo');
  assert(!publicReleaseWorkflow.includes(oldSplitTokenName) && !publicReleaseWorkflow.includes(oldSplitInputName), 'public release workflow must not require old split release credentials');
  assert(publicReleaseWorkflow.includes('ref: ${{ inputs.version }}'), 'public release workflow must build from the explicitly selected release tag');
  assert(!publicReleaseWorkflow.includes(oldReleaseRepoName), 'release workflow must not reference the old split repo name');
  assert(!publicReleaseWorkflow.includes(oldDevRepoName), 'public release workflow must not reference the old dev repo name');

  const readme = await readFile('README.md', 'utf8');
  assert(readme.includes('## macOS Bootstrap'), 'README must document macOS bootstrap');
  assert(readme.includes('scripts/postinstall.mjs') && readme.includes('postinstall'), 'README must document install-time bootstrap');
  assert(readme.includes('scripts/bootstrap-macos.sh') && readme.includes('no `npm` yet'), 'README must document the no-npm bootstrap path');
  assert(readme.includes('THINKLESS_CONFIG_BUNDLE') && readme.includes('THINKLESS_BOOTSTRAP=0'), 'README must document config bundle and opt-out environment variables');
  assert(readme.includes('curl -fsSL https://github.com/wici-ai/thinkless/releases/latest/download/install.sh | bash'), 'README must document the one-line public release installer');
  assert(readme.includes('git clone git@github.com:wici-ai/thinkless.git'), 'README must document the public thinkless source repo');
  assert(!readme.includes(oldReleaseRepoName), 'README must not reference the old split repo name');
  assert(!readme.includes(oldDevRepoName), 'README must not reference the old dev repo name');
  assert(readme.includes('authenticate Codex, Claude, and GitHub CLI') && readme.includes('Codex, Claude, and GitHub CLI commands'), 'README must include GitHub CLI in auth and real-mode health wording');
  assert(readme.includes('~/.codex/config.toml') && readme.includes('~/.codex/auth.json'), 'README must document Codex config/auth destinations');
  assert(readme.includes('~/.claude/settings.json') && readme.includes('~/.claude/.credentials.json'), 'README must document Claude config destinations');
  assert(readme.includes('Apple Command Line Tools') && readme.includes('~/.zprofile') && readme.includes('~/.zshrc') && readme.includes('`thinkless`, `codex`, `claude`, and `gh`') && readme.includes('clean zsh login and interactive shells') && readme.includes('export PATH=... && thinkless'), 'README must document first-run CLT waiting and full zsh command exposure');
  assert(readme.includes('auth onboarding status') && readme.includes('codex login') && readme.includes('THINKLESS_AUTH_ONBOARDING=0') && readme.includes('/dev/tty') && readme.includes('auth is pending'), 'README must document installer auth onboarding, opt-out, and pending-auth state');

  console.log(
    JSON.stringify(
      {
        ok: true,
        postinstall_bootstrap: true,
        no_npm_bootstrap: true,
        config_bundle_copy_plan: true,
        github_cli_bootstrap: true,
        public_release_installer: true,
        thinkless_only_bin: true
      },
      null,
      2
    )
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
