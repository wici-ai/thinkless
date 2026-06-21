#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFile, chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const INSTALL_SKIP_VALUES = new Set(['0', 'false', 'no']);
const REQUIRED_COMMANDS = ['brew', 'git', 'node', 'npm', 'gh', 'codex', 'claude'];
const BREW_INIT = 'eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null || brew shellenv)"';
const SUDO_PREFLIGHT = 'sudo -v || { echo "thinkless postinstall: sudo access is required on macOS to install Homebrew and system dependencies. Run from an admin account, or install dependencies manually and rerun with THINKLESS_BOOTSTRAP=0."; exit 1; }';
const HOMEBREW_INSTALL = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
const CODEX_INSTALL = 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh';
const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

export function buildPostinstallPlan(env = process.env, options = {}) {
  const platform = env.THINKLESS_BOOTSTRAP_TEST_PLATFORM || process.platform;
  const home = options.home || env.THINKLESS_BOOTSTRAP_TEST_HOME || homedir();
  const skipReason = bootstrapSkipReason(env, platform);
  const missing = skipReason ? [] : missingCommands(env);
  const steps = skipReason ? [] : installStepsForMissing(missing);
  const configCopies = skipReason ? [] : collectConfigCopies(env, home);
  return {
    platform,
    skipped: Boolean(skipReason),
    skipReason,
    missing,
    steps,
    configCopies,
    requiredCommands: REQUIRED_COMMANDS
  };
}

export async function applyConfigCopies(configCopies, env = process.env) {
  const force = env.THINKLESS_BOOTSTRAP_FORCE === '1';
  const results = [];
  for (const item of configCopies) {
    const source = resolve(item.source);
    const destination = item.destination;
    if (!existsSync(source)) {
      results.push({ ...item, status: 'missing-source' });
      continue;
    }
    if (existsSync(destination) && !force) {
      results.push({ ...item, status: 'skipped-existing' });
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    await chmod(destination, item.mode);
    results.push({ ...item, status: 'copied' });
  }
  return results;
}

export async function runPostinstall(env = process.env, args = process.argv.slice(2)) {
  const plan = buildPostinstallPlan(env);
  if (args.includes('--plan-json')) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }

  if (plan.skipped) {
    console.log(`thinkless postinstall: ${plan.skipReason}`);
    return 0;
  }

  if (env.THINKLESS_BOOTSTRAP_DRY_RUN === '1' || args.includes('--dry-run')) {
    printPlan(plan);
    return 0;
  }

  for (const step of plan.steps) {
    console.log(`thinkless postinstall: ${step.title}`);
    const result = runShell(step.command, step.env);
    if (result.status !== 0) {
      console.error(result.output);
      return result.status || 1;
    }
  }

  const copyResults = await applyConfigCopies(plan.configCopies, env);
  for (const result of copyResults) {
    console.log(`thinkless postinstall: ${result.status} ${result.destination}`);
  }

  const verify = runShell('brew --version && git --version && node --version && npm --version && gh --version && codex --version && claude --version');
  if (verify.status !== 0) {
    console.error(verify.output);
    return verify.status || 1;
  }
  console.log(verify.output.trim());
  console.log('thinkless postinstall: dependency bootstrap complete');
  return 0;
}

function bootstrapSkipReason(env, platform) {
  const flag = env.THINKLESS_BOOTSTRAP ?? env.THINKLESS_INSTALL_BOOTSTRAP;
  if (flag && INSTALL_SKIP_VALUES.has(flag.toLowerCase())) return 'dependency bootstrap disabled by THINKLESS_BOOTSTRAP=0';
  if (env.THINKLESS_SKIP_BOOTSTRAP === '1') return 'dependency bootstrap disabled by THINKLESS_SKIP_BOOTSTRAP=1';
  if (platform !== 'darwin') return `dependency bootstrap skipped on ${platform}; macOS only`;
  if (env.CI && env.THINKLESS_BOOTSTRAP_CI !== '1') return 'dependency bootstrap skipped in CI';
  return null;
}

function installStepsForMissing(missing) {
  const steps = [];
  const needsBrew = missing.includes('brew');
  const needsBrewPackage = missing.some((command) => ['git', 'node', 'npm', 'gh'].includes(command));
  if (needsBrew) {
    steps.push({
      id: 'verify-sudo',
      title: 'Verify macOS sudo access',
      command: SUDO_PREFLIGHT
    });
    steps.push({
      id: 'install-homebrew',
      title: 'Install Homebrew',
      command: HOMEBREW_INSTALL,
      env: { NONINTERACTIVE: '1' }
    });
  }
  if (needsBrew || needsBrewPackage) {
    steps.push({
      id: 'install-brew-packages',
      title: 'Install git, GitHub CLI, and Node.js/npm with Homebrew',
      command: `${BREW_INIT} && brew update && brew install git node gh`
    });
  }
  if (missing.includes('codex')) {
    steps.push({
      id: 'install-codex',
      title: 'Install Codex CLI',
      command: CODEX_INSTALL
    });
  }
  if (missing.includes('claude')) {
    steps.push({
      id: 'install-claude',
      title: 'Install Claude Code CLI',
      command: CLAUDE_INSTALL
    });
  }
  return steps;
}

function missingCommands(env) {
  if (env.THINKLESS_BOOTSTRAP_TEST_MISSING !== undefined) {
    return env.THINKLESS_BOOTSTRAP_TEST_MISSING.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return REQUIRED_COMMANDS.filter((command) => !commandExists(command));
}

function commandExists(command) {
  return runShell(`command -v ${shellQuote(command)} >/dev/null 2>&1`).status === 0;
}

function runShell(command, extraEnv = {}) {
  const path = [
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    extraEnv.PATH || process.env.PATH || ''
  ].filter(Boolean).join(':');
  const result = spawnSync('/bin/bash', ['-lc', command], {
    env: { ...process.env, ...extraEnv, PATH: path },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 10
  });
  return {
    status: result.status ?? 1,
    output: [result.stdout, result.stderr].filter(Boolean).join('')
  };
}

function collectConfigCopies(env, home) {
  const bundle = env.THINKLESS_CONFIG_BUNDLE ? resolve(env.THINKLESS_CONFIG_BUNDLE) : null;
  const copies = [];
  pushCopy(copies, env.THINKLESS_CODEX_CONFIG || firstExisting(bundle, ['.codex/config.toml', 'codex/config.toml']), join(home, '.codex', 'config.toml'), 0o600, 'codex-config');
  pushCopy(copies, env.THINKLESS_CODEX_AUTH || firstExisting(bundle, ['.codex/auth.json', 'codex/auth.json']), join(home, '.codex', 'auth.json'), 0o600, 'codex-auth');
  pushCopy(copies, env.THINKLESS_CLAUDE_SETTINGS || firstExisting(bundle, ['.claude/settings.json', 'claude/settings.json']), join(home, '.claude', 'settings.json'), 0o600, 'claude-settings');
  pushCopy(copies, env.THINKLESS_CLAUDE_CREDENTIALS || firstExisting(bundle, ['.claude/.credentials.json', 'claude/.credentials.json']), join(home, '.claude', '.credentials.json'), 0o600, 'claude-credentials');
  return copies;
}

function firstExisting(bundle, relativePaths) {
  if (!bundle) return undefined;
  for (const relativePath of relativePaths) {
    const candidate = join(bundle, ...relativePath.split('/'));
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function pushCopy(copies, source, destination, mode, id) {
  if (!source) return;
  copies.push({ id, source, destination, mode });
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function printPlan(plan) {
  console.log('thinkless postinstall dry run');
  for (const step of plan.steps) {
    console.log(`- ${step.title}: ${step.command}`);
  }
  for (const copy of plan.configCopies) {
    console.log(`- copy ${copy.source} -> ${copy.destination}`);
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const status = await runPostinstall();
  process.exitCode = status;
}
