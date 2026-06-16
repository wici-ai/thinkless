import { execa } from 'execa';
import { readFile } from 'node:fs/promises';
import { TOOL_ROOT } from '../shared/paths.js';
import type { Checkpoint, WiCiConfig } from '../shared/types.js';

export interface ToolHealth {
  command: string;
  available: boolean;
  version?: string;
  doctor?: string;
  updatePending?: boolean;
  error?: string;
}

export interface ToolHealthReport {
  codex: ToolHealth;
  claude: ToolHealth;
}

export interface ToolHealthOptions {
  probeClaude?: boolean;
}

export interface ToolVersionDriftReport {
  accepted: string[];
}

export async function checkToolHealth(config: WiCiConfig, options: ToolHealthOptions = {}): Promise<ToolHealthReport> {
  const [codex, claude] = await Promise.all([
    inspectTool(config.tools.executor.command, ['--version'], ['doctor']),
    inspectClaude(config.tools.planner.command, options.probeClaude === true)
  ]);
  return { codex, claude };
}

export function assertRealToolsReady(config: WiCiConfig, report: ToolHealthReport): void {
  if (config.tools.mode !== 'real') return;
  const failures = [report.codex, report.claude]
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
    wici: await inspectWiCiVersion(),
    checked_at: new Date().toISOString()
  };
}

export function shouldAutoUpdateToolsAtBoundary(config: WiCiConfig, checkpoint: Checkpoint): boolean {
  if (config.tools.mode === 'stub') return false;
  if (config.tools.auto_update === false) return false;
  return !checkpoint.tool_versions || checkpoint.supervisor_state === 'STOP' || checkpoint.supervisor_state === 'FAILED';
}

export function reconcileToolVersionDrift(checkpoint: Checkpoint, current: NonNullable<Checkpoint['tool_versions']>): ToolVersionDriftReport {
  if (!checkpoint.tool_versions) return { accepted: [] };
  if (checkpoint.supervisor_state === 'STOP' || checkpoint.supervisor_state === 'FAILED') return { accepted: [] };

  const pinned = checkpoint.tool_versions;
  const accepted: string[] = [];
  const rejected: string[] = [];
  if (pinned.mode !== current.mode) rejected.push(`mode ${pinned.mode} -> ${current.mode}`);
  if (pinned.codex !== current.codex) accepted.push(`codex ${pinned.codex ?? 'unknown'} -> ${current.codex ?? 'unknown'}`);
  if (pinned.claude !== current.claude) accepted.push(`claude ${pinned.claude ?? 'unknown'} -> ${current.claude ?? 'unknown'}`);
  if (pinned.wici) {
    if (pinned.wici.package_version !== current.wici?.package_version) {
      rejected.push(`wici package ${pinned.wici.package_version ?? 'unknown'} -> ${current.wici?.package_version ?? 'unknown'}`);
    }
    if (pinned.wici.git_commit !== current.wici?.git_commit) {
      rejected.push(`wici git ${pinned.wici.git_commit ?? 'unknown'} -> ${current.wici?.git_commit ?? 'unknown'}`);
    }
    if (pinned.wici.git_dirty !== current.wici?.git_dirty) {
      rejected.push(`wici dirty ${String(pinned.wici.git_dirty)} -> ${String(current.wici?.git_dirty)}`);
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
    updatePending: doctorOutput ? parseCodexUpdatePending(doctorOutput) : undefined,
    error: version.exitCode === 0 ? parseCodexDoctorError(doctorOutput, doctor?.exitCode ?? 0) : 'tool reported a non-zero version check'
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
  const result = await execa('command', ['-v', command], { shell: true, reject: false });
  return result.exitCode === 0;
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
