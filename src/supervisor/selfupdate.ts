import { execa } from 'execa';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { resolve } from 'node:path';
import { commandExists } from '../shared/commands.js';
import { TOOL_ROOT } from '../shared/paths.js';
import type { Checkpoint, WiCiConfig } from '../shared/types.js';

export interface ToolHealth {
  command: string;
  available: boolean;
  version?: string;
  doctor?: string;
  doctorError?: string;
  updatePending?: boolean;
  error?: string;
}

export interface ToolHealthReport {
  codex: ToolHealth;
  claude: ToolHealth;
  github: ToolHealth;
}

export interface ToolHealthOptions {
  probeClaude?: boolean;
}

export interface ToolVersionDriftReport {
  accepted: string[];
}

export interface ToolVersionDriftOptions {
  allowWiCiBoundary?: boolean;
}

export interface ThinklessReleaseInfo {
  version: string;
  tagName: string;
  tarballUrl: string;
}

export type ThinklessSelfUpdateAction =
  | 'disabled'
  | 'current'
  | 'skipped-dirty-checkout'
  | 'updated-git-checkout'
  | 'updated-global-install'
  | 'failed-open';

export interface ThinklessSelfUpdateResult {
  checked: boolean;
  action: ThinklessSelfUpdateAction;
  currentVersion?: string;
  latestVersion?: string;
  message?: string;
  error?: string;
}

interface ThinklessSelfUpdateCommandResult {
  exitCode: number;
  stdout: string;
  all?: string;
}

interface ThinklessSelfUpdateOptions {
  latestRelease?: () => Promise<ThinklessReleaseInfo>;
  runCommand?: (command: string, args: string[], options?: { cwd?: string }) => Promise<ThinklessSelfUpdateCommandResult>;
}

export async function checkToolHealth(config: WiCiConfig, options: ToolHealthOptions = {}): Promise<ToolHealthReport> {
  const [codex, claude, github] = await Promise.all([
    inspectTool(config.tools.executor.command, ['--version'], ['doctor']),
    inspectClaude(config.tools.planner.command, options.probeClaude === true),
    inspectTool('gh', ['--version'], [])
  ]);
  return { codex, claude, github };
}

export function assertRealToolsReady(config: WiCiConfig, report: ToolHealthReport): void {
  if (config.tools.mode !== 'real') return;
  const failures = [report.codex, report.claude, report.github]
    .filter((tool) => !tool.available || tool.error)
    .map((tool) => `${tool.command}: ${tool.error ?? 'unavailable'}`);
  if (failures.length > 0) {
    throw new Error(`Real mode requires healthy tools: ${failures.join('; ')}`);
  }
}

export async function toolVersionsFromHealth(config: WiCiConfig, report: ToolHealthReport | null): Promise<NonNullable<Checkpoint['tool_versions']>> {
  return {
    mode: config.tools.mode,
    codex: report?.codex.version,
    claude: report?.claude.version,
    github: report?.github.version,
    wici: await inspectWiCiVersion(),
    checked_at: new Date().toISOString()
  };
}

export function shouldAutoUpdateToolsAtBoundary(config: WiCiConfig, checkpoint: Checkpoint): boolean {
  if (config.tools.mode === 'stub') return false;
  if (config.tools.auto_update === false) return false;
  return !checkpoint.tool_versions || checkpoint.supervisor_state === 'STOP' || checkpoint.supervisor_state === 'FAILED';
}

export function reconcileToolVersionDrift(
  checkpoint: Checkpoint,
  current: NonNullable<Checkpoint['tool_versions']>,
  options: ToolVersionDriftOptions = {}
): ToolVersionDriftReport {
  if (!checkpoint.tool_versions) return { accepted: [] };
  if (checkpoint.supervisor_state === 'STOP' || checkpoint.supervisor_state === 'FAILED') return { accepted: [] };

  const pinned = checkpoint.tool_versions;
  const accepted: string[] = [];
  const rejected: string[] = [];
  if (pinned.mode !== current.mode) {
    const item = `mode ${pinned.mode} -> ${current.mode}`;
    if (options.allowWiCiBoundary) accepted.push(item);
    else rejected.push(item);
  }
  if (pinned.codex !== current.codex) accepted.push(`codex ${pinned.codex ?? 'unknown'} -> ${current.codex ?? 'unknown'}`);
  if (pinned.claude !== current.claude) accepted.push(`claude ${pinned.claude ?? 'unknown'} -> ${current.claude ?? 'unknown'}`);
  if (pinned.github !== current.github) accepted.push(`github ${pinned.github ?? 'unknown'} -> ${current.github ?? 'unknown'}`);
  if (pinned.wici) {
    if (pinned.wici.package_version !== current.wici?.package_version) {
      const item = `wici package ${pinned.wici.package_version ?? 'unknown'} -> ${current.wici?.package_version ?? 'unknown'}`;
      if (options.allowWiCiBoundary) accepted.push(item);
      else rejected.push(item);
    }
    if (pinned.wici.git_commit !== current.wici?.git_commit) {
      const item = `wici git ${pinned.wici.git_commit ?? 'unknown'} -> ${current.wici?.git_commit ?? 'unknown'}`;
      if (options.allowWiCiBoundary) accepted.push(item);
      else rejected.push(item);
    }
    if (pinned.wici.git_dirty !== current.wici?.git_dirty) {
      const item = `wici dirty ${String(pinned.wici.git_dirty)} -> ${String(current.wici?.git_dirty)}`;
      if (options.allowWiCiBoundary) accepted.push(item);
      else rejected.push(item);
    }
  }

  if (rejected.length > 0) {
    throw new Error(`Non-recoverable tool version drift detected during active run; roll WiCi back to the checkpointed git commit or start a new run boundary: ${rejected.join('; ')}`);
  }
  return { accepted };
}

export function assertNoActiveToolVersionDrift(checkpoint: Checkpoint, current: NonNullable<Checkpoint['tool_versions']>): void {
  void reconcileToolVersionDrift(checkpoint, current);
}

export async function updateToolsBetweenRuns(config: WiCiConfig): Promise<ToolHealthReport> {
  const codexAvailable = await commandAvailable(config.tools.executor.command);
  if (codexAvailable) {
    await execa(config.tools.executor.command, ['update'], { reject: false, all: true });
  }

  const claudeAvailable = await commandAvailable(config.tools.planner.command);
  if (claudeAvailable) {
    await execa(config.tools.planner.command, ['update'], { reject: false, all: true });
  }

  return checkToolHealth(config);
}

export async function runThinklessStartupSelfUpdate(env: NodeJS.ProcessEnv = process.env, options: ThinklessSelfUpdateOptions = {}): Promise<ThinklessSelfUpdateResult> {
  if (env.THINKLESS_SELF_UPDATE === '0') {
    return { checked: false, action: 'disabled', message: 'disabled by THINKLESS_SELF_UPDATE=0' };
  }

  const currentVersion = await readPackageVersion();
  if (!currentVersion) {
    return { checked: true, action: 'failed-open', message: 'package version unavailable' };
  }

  let latest: ThinklessReleaseInfo;
  try {
    latest = options.latestRelease ? await options.latestRelease() : await fetchLatestThinklessRelease(env);
  } catch (error) {
    return {
      checked: true,
      action: 'failed-open',
      currentVersion,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  if (compareReleaseVersions(currentVersion, latest.version) >= 0) {
    return { checked: true, action: 'current', currentVersion, latestVersion: latest.version };
  }

  const runCommand = options.runCommand ?? runSelfUpdateCommand;
  const git = await gitCheckoutStatus(runCommand);
  if (git.isGit && git.dirty) {
    return {
      checked: true,
      action: 'skipped-dirty-checkout',
      currentVersion,
      latestVersion: latest.version,
      message: 'local Thinkless checkout has uncommitted changes'
    };
  }

  if (env.THINKLESS_SELF_UPDATE_DRY_RUN === '1') {
    return {
      checked: true,
      action: git.isGit ? 'updated-git-checkout' : 'updated-global-install',
      currentVersion,
      latestVersion: latest.version,
      message: 'dry run; no update command executed'
    };
  }

  try {
    if (git.isGit) {
      const tagRef = latest.tagName;
      await requireCommandOk(runCommand, 'git', ['-C', TOOL_ROOT, 'fetch', '--tags', 'origin', tagRef]);
      await requireCommandOk(runCommand, 'git', ['-C', TOOL_ROOT, 'checkout', '--detach', tagRef]);
      await requireCommandOk(runCommand, 'npm', ['install'], { cwd: TOOL_ROOT });
      await requireCommandOk(runCommand, 'npm', ['run', 'build'], { cwd: TOOL_ROOT });
      return { checked: true, action: 'updated-git-checkout', currentVersion, latestVersion: latest.version };
    }

    await requireCommandOk(runCommand, 'npm', ['install', '-g', '--foreground-scripts', '--ignore-scripts=false', latest.tarballUrl]);
    return { checked: true, action: 'updated-global-install', currentVersion, latestVersion: latest.version };
  } catch (error) {
    return {
      checked: true,
      action: 'failed-open',
      currentVersion,
      latestVersion: latest.version,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function fetchLatestThinklessRelease(env: NodeJS.ProcessEnv = process.env): Promise<ThinklessReleaseInfo> {
  const repo = env.THINKLESS_RELEASE_REPO?.trim() || 'wici-ai/thinkless';
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const json = await httpsJson(url, Number(env.THINKLESS_SELF_UPDATE_TIMEOUT_MS ?? 5_000));
  const record = json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : {};
  const tagName = typeof record.tag_name === 'string' ? record.tag_name : '';
  if (!tagName) throw new Error('GitHub latest release response did not include tag_name');
  const version = normalizeReleaseVersion(tagName);
  const assets = Array.isArray(record.assets) ? record.assets : [];
  const assetUrl = assets
    .map((asset) => asset && typeof asset === 'object' ? asset as Record<string, unknown> : null)
    .find((asset) => asset && asset.name === 'thinkless.tgz')?.browser_download_url;
  const tarballUrl = typeof assetUrl === 'string'
    ? assetUrl
    : (env.THINKLESS_TARBALL_URL?.trim() || `https://github.com/${repo}/releases/latest/download/thinkless.tgz`);
  return { version, tagName, tarballUrl };
}

export function compareReleaseVersions(left: string, right: string): number {
  return compareVersionStrings(normalizeReleaseVersion(left), normalizeReleaseVersion(right));
}

function normalizeReleaseVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

async function gitCheckoutStatus(runCommand: NonNullable<ThinklessSelfUpdateOptions['runCommand']>): Promise<{ isGit: boolean; dirty: boolean }> {
  const inside = await runCommand('git', ['-C', TOOL_ROOT, 'rev-parse', '--is-inside-work-tree']);
  if (inside.exitCode !== 0 || !inside.stdout.trim().includes('true')) return { isGit: false, dirty: false };
  const topLevel = await runCommand('git', ['-C', TOOL_ROOT, 'rev-parse', '--show-toplevel']);
  if (topLevel.exitCode !== 0 || resolve(topLevel.stdout.trim()) !== resolve(TOOL_ROOT)) {
    return { isGit: false, dirty: false };
  }
  const status = await runCommand('git', ['-C', TOOL_ROOT, 'status', '--porcelain']);
  return { isGit: true, dirty: status.exitCode !== 0 || status.stdout.trim().length > 0 };
}

async function requireCommandOk(
  runCommand: NonNullable<ThinklessSelfUpdateOptions['runCommand']>,
  command: string,
  args: string[],
  options?: { cwd?: string }
): Promise<void> {
  const result = await runCommand(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.exitCode}: ${(result.all ?? result.stdout).trim()}`);
  }
}

async function runSelfUpdateCommand(command: string, args: string[], options: { cwd?: string } = {}): Promise<ThinklessSelfUpdateCommandResult> {
  const result = await execa(command, args, { reject: false, all: true, cwd: options.cwd });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    all: result.all
  };
}

function httpsJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          'user-agent': 'thinkless-self-update',
          accept: 'application/vnd.github+json'
        },
        timeout: timeoutMs
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            reject(new Error(`GitHub release check returned HTTP ${response.statusCode ?? 'unknown'}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as unknown);
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on('timeout', () => {
      request.destroy(new Error(`GitHub release check timed out after ${timeoutMs}ms`));
    });
    request.on('error', reject);
  });
}

async function inspectTool(command: string, versionArgs: string[], doctorArgs: string[]): Promise<ToolHealth> {
  if (!(await commandAvailable(command))) {
    return { command, available: false, error: 'not found on PATH' };
  }

  const version = await execa(command, versionArgs, { reject: false, all: true });
  const doctor = doctorArgs.length > 0 ? await execa(command, doctorArgs, { reject: false, all: true, timeout: 30_000 }) : null;
  const doctorOutput = doctor ? (doctor.all ?? doctor.stdout).trim() : undefined;
  return {
    command,
    available: true,
    version: (version.all ?? version.stdout).trim(),
    doctor: doctorOutput,
    doctorError: parseCodexDoctorError(doctorOutput, doctor?.exitCode ?? 0),
    updatePending: doctorOutput ? parseCodexUpdatePending(doctorOutput) : undefined,
    error: version.exitCode === 0 ? undefined : 'tool reported a non-zero version check'
  };
}

export function parseCodexDoctorError(doctorOutput: string | undefined, exitCode: number): string | undefined {
  if (!doctorOutput || exitCode === 0) return undefined;
  const summary = /(\d+)\s+fail degraded/i.exec(doctorOutput);
  if (summary && Number(summary[1]) === 0) return undefined;
  return 'tool reported a non-zero health check';
}

export function parseCodexUpdatePending(doctorOutput: string): boolean | undefined {
  const status = /latest version status\s+(.+)/i.exec(doctorOutput)?.[1]?.trim().toLowerCase();
  if (status) {
    if (status.includes('current version is not older') || status.includes('up to date')) return false;
    if (status.includes('older') || status.includes('update') || status.includes('behind')) return true;
  }

  const current = /(?:^|\n)\s*version\s+([0-9]+(?:\.[0-9]+){1,3})\b/i.exec(doctorOutput)?.[1];
  const latest = /(?:^|\n)\s*latest version\s+([0-9]+(?:\.[0-9]+){1,3})\b/i.exec(doctorOutput)?.[1];
  if (!current || !latest) return undefined;
  return compareVersionStrings(current, latest) < 0;
}

function compareVersionStrings(left: string, right: string): number {
  const a = left.split('.').map((part) => Number(part));
  const b = right.split('.').map((part) => Number(part));
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

async function inspectClaude(command: string, probe: boolean): Promise<ToolHealth> {
  const health = await inspectTool(command, ['--version'], []);
  if (!health.available || !probe) return health;

  const schema = JSON.stringify({
    type: 'object',
    required: ['ok'],
    properties: {
      ok: { type: 'boolean' }
    },
    additionalProperties: false
  });
  const probeResult = await execa(
    command,
    buildClaudeProbeArgs(schema),
    { reject: false, all: true, timeout: 60_000, maxBuffer: 1024 * 1024 * 5 }
  );
  const probeError = parseClaudeProbeError(probeResult.stdout || probeResult.all || '', probeResult.exitCode ?? 1);
  return {
    ...health,
    error: probeError ?? health.error
  };
}

export function buildClaudeProbeArgs(schema: string): string[] {
  return [
    '-p',
    'Return JSON with ok=true.',
    '--output-format',
    'json',
    '--json-schema',
    schema,
    '--permission-mode',
    'plan'
  ];
}

export function parseClaudeProbeError(output: string, exitCode: number): string | undefined {
  const trimmed = output.trim();
  if (!trimmed && exitCode !== 0) return `claude probe exited with code ${exitCode}`;
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as { is_error?: boolean; result?: string; subtype?: string };
      if (parsed.is_error) return parsed.result || parsed.subtype || 'claude probe reported an error';
    } catch {
      if (/not logged in/i.test(trimmed)) return 'Not logged in';
    }
  }
  if (exitCode !== 0) return `claude probe exited with code ${exitCode}`;
  return undefined;
}

async function commandAvailable(command: string): Promise<boolean> {
  return commandExists(command);
}

async function inspectWiCiVersion(): Promise<NonNullable<NonNullable<Checkpoint['tool_versions']>['wici']>> {
  const packageVersion = await readPackageVersion();
  const commit = await execa('git', ['-C', TOOL_ROOT, 'rev-parse', 'HEAD'], { reject: false, all: true });
  const status = await execa('git', ['-C', TOOL_ROOT, 'status', '--porcelain'], { reject: false, all: true });
  return {
    package_version: packageVersion,
    git_commit: commit.exitCode === 0 ? (commit.all ?? commit.stdout).trim() : null,
    git_dirty: status.exitCode === 0 ? (status.all ?? status.stdout).trim().length > 0 : undefined
  };
}

async function readPackageVersion(): Promise<string | undefined> {
  const raw = await readFile(`${TOOL_ROOT}/package.json`, 'utf8').catch(() => '');
  if (!raw) return undefined;
  return (JSON.parse(raw) as { version?: string }).version;
}
