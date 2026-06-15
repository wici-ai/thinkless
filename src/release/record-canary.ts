import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { scanFilesForSecrets } from '../verify/secret-scan.js';
import { inspectCodexSshTranscript } from '../verify/ssh-evidence.js';

interface Args {
  name: string;
  target: string;
  status: 'passed' | 'failed';
  tagAllowed: boolean;
  firstChat: string;
  startedFromEmptyTui: boolean;
  operatorManualExecution: boolean;
  codexAttemptedSsh: boolean;
  failureReason?: string;
  nextRequiredAction?: string;
  targetValue?: number;
  observedValue?: number;
  unit?: string;
  outDir: string;
}

interface ArtifactDigest {
  sha256: string;
  bytes: number;
}

const requiredArtifacts = [
  'GOAL.md',
  'PLAN.md',
  '.wici/events.jsonl',
  'ledger.jsonl',
  '.wici/codex-run.jsonl',
  '.wici/artifacts/planner-initial.stdout.jsonl'
];

const optionalArtifacts = ['.opt/checks.sh', '.opt/measure.sh', '.opt/benchmark.json'];

async function assertSourceArtifactsHaveNoSecrets(target: string): Promise<void> {
  const artifactPaths: string[] = [];
  for (const relativePath of [...requiredArtifacts, ...optionalArtifacts]) {
    const source = join(target, relativePath);
    if (await exists(source)) artifactPaths.push(source);
  }
  const findings = await scanFilesForSecrets(artifactPaths);
  if (findings.length > 0) {
    throw new Error(`Refusing to record canary evidence with potential secret material:\n${findings.map((item) => `${item.path}:${item.line} ${item.pattern}`).join('\n')}`);
  }
}

async function assertCodexSshAttestationSupported(target: string, args: Args): Promise<void> {
  if (!args.codexAttemptedSsh) return;
  const transcriptPath = join(target, '.wici/codex-run.jsonl');
  const transcript = await readText(transcriptPath);
  const expectedText = [args.firstChat, await readText(join(target, 'GOAL.md')), await readText(join(target, 'PLAN.md'))].join('\n');
  const evidence = inspectCodexSshTranscript(transcript, expectedText);
  if (!evidence.hasSshAttempt) {
    throw new Error(`Refusing to record --codex-attempted-ssh true without SSH evidence in ${transcriptPath}`);
  }
}

export async function recordCanaryEvidence(args: Args): Promise<{ markdown: string; evidence: string; artifacts: string[] }> {
  validateCanaryArgs(args);
  const target = resolve(args.target);
  const canaryName = args.name.replace(/\.md$/, '');
  const evidenceDir = join(args.outDir, canaryName);
  const artifactRoot = join(evidenceDir, 'artifacts');
  const markdownPath = join(args.outDir, `${canaryName}.md`);
  const evidencePath = join(evidenceDir, 'evidence.json');

  await assertSourceArtifactsHaveNoSecrets(target);
  await assertCodexSshAttestationSupported(target, args);

  const goal = await readText(join(target, 'GOAL.md'));
  const plan = await readText(join(target, 'PLAN.md'));
  const events = await readJsonLines<Record<string, unknown>>(join(target, '.wici/events.jsonl'));
  const ledger = await readJsonLines<Record<string, unknown>>(join(target, 'ledger.jsonl'));
  const checkpoint = await readJsonMaybe<Record<string, unknown>>(join(target, '.wici/checkpoint.json'));
  const toolVersions = checkpoint?.tool_versions as Record<string, unknown> | undefined;
  const wiciVersion = toolVersions?.wici as Record<string, unknown> | undefined;
  const targetHead = await git(target, ['rev-parse', 'HEAD']);
  const bestRef = await git(target, ['rev-parse', '--verify', 'refs/tags/wici/best']);
  const targetGitDirty = await gitDirty(target);
  const checkpointBestCommit = typeof checkpoint?.best_commit === 'string' ? checkpoint.best_commit : null;
  const goalSource = typeof checkpoint?.goal_source === 'string' ? checkpoint.goal_source : null;
  const executeProgress = latestEvent(events, 'EXECUTE_PROGRESS');
  const executeDone = latestEvent(events, 'EXECUTE_DONE');
  const executeFailed = latestEvent(events, 'EXECUTE_FAILED');

  validatePassedSourceEvidence(args, toolVersions, wiciVersion, targetGitDirty, goalSource);

  await rm(evidenceDir, { recursive: true, force: true });
  await mkdir(artifactRoot, { recursive: true });

  const generated: Record<string, ArtifactDigest> = {};
  const copied: string[] = [];
  for (const relativePath of requiredArtifacts) {
    const copiedPath = await copyArtifact(target, artifactRoot, relativePath, true);
    copied.push(copiedPath);
    generated[relativePath] = await digest(copiedPath);
  }
  for (const relativePath of optionalArtifacts) {
    const copiedPath = await copyArtifact(target, artifactRoot, relativePath, false);
    if (!copiedPath) continue;
    copied.push(copiedPath);
    generated[relativePath] = await digest(copiedPath);
  }

  const evidence = {
    version: 1,
    status: args.status,
    tag_allowed: args.tagAllowed,
    target: args.target,
    first_chat: args.firstChat,
    started_from_empty_tui: args.startedFromEmptyTui,
    operator_manual_execution: args.operatorManualExecution,
    codex_attempted_ssh: args.codexAttemptedSsh,
    version_point: {
      tool_mode: typeof toolVersions?.mode === 'string' ? toolVersions.mode : null,
      wici_package_version: typeof wiciVersion?.package_version === 'string' ? wiciVersion.package_version : null,
      wici_git_commit: typeof wiciVersion?.git_commit === 'string' ? wiciVersion.git_commit : null,
      wici_git_dirty: typeof wiciVersion?.git_dirty === 'boolean' ? wiciVersion.git_dirty : true,
      codex: typeof toolVersions?.codex === 'string' ? toolVersions.codex : null,
      claude: typeof toolVersions?.claude === 'string' ? toolVersions.claude : null,
      checked_at: typeof toolVersions?.checked_at === 'string' ? toolVersions.checked_at : null
    },
    rollback: {
      target_head: targetHead || null,
      target_git_dirty: targetGitDirty,
      wici_best_ref: bestRef || null,
      checkpoint_best_commit: checkpointBestCommit,
      rollback_command: `npx tsx src/cli.tsx rollback --target ${args.target} --confirm`
    },
    run_checkpoint: {
      supervisor_state: typeof checkpoint?.supervisor_state === 'string' ? checkpoint.supervisor_state : null,
      goal_source: goalSource,
      iter: typeof checkpoint?.iter === 'number' ? checkpoint.iter : null,
      plan_hash: typeof checkpoint?.plan_hash === 'string' ? checkpoint.plan_hash : null,
      events_seq: typeof checkpoint?.events_seq === 'number' ? checkpoint.events_seq : null,
      ledger_seq: typeof checkpoint?.ledger_seq === 'number' ? checkpoint.ledger_seq : null
    },
    generated_artifacts: generated,
    goal_summary: {
      contains_first_chat: goal.includes(args.firstChat),
      target: args.targetValue ?? null,
      unit: args.unit ?? null
    },
    plan_summary: {
      mentions_ssh_target: planMentionsExpectedSshTarget(plan, `${args.firstChat}\n${goal}`),
      mentions_target_threshold: args.targetValue === undefined ? false : plan.includes(String(args.targetValue)),
      mentions_measure_script: plan.includes('.opt/measure.sh') || plan.includes('measure')
    },
    events: {
      PLAN_USAGE: events.filter((event) => event.type === 'PLAN_USAGE').map((event) => String(event.message ?? '')),
      PLAN_DONE: events.some((event) => event.type === 'PLAN_DONE'),
      EXECUTE_PROGRESS: summarizeExecuteProgress(executeProgress),
      EXECUTE_DONE: executeDone ? { message: String(executeDone.message ?? '') } : undefined,
      EXECUTE_FAILED: executeFailed ? { message: String(executeFailed.message ?? '') } : undefined
    },
    ledger: ledger.map((entry) => ({
      id: String(entry.id ?? ''),
      step_id: String(entry.step_id ?? ''),
      status: String(entry.status ?? ''),
      tokens_input: numberFromPath(entry, ['cost', 'tokens_input']),
      tokens_output: numberFromPath(entry, ['cost', 'tokens_output']),
      reflection: typeof entry.reflection === 'string' ? entry.reflection : undefined
    })),
    result: {
      reached_target: args.status === 'passed',
      ...(args.observedValue !== undefined ? { observed_value: args.observedValue, observed_unit: args.unit ?? null } : {}),
      ...(args.failureReason ? { failure_reason: args.failureReason } : {}),
      ...(args.nextRequiredAction ? { next_required_action: args.nextRequiredAction } : {})
    }
  };

  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, markdownFor(args, canaryName, evidencePath));
  return { markdown: markdownPath, evidence: evidencePath, artifacts: copied };
}

function markdownFor(args: Args, canaryName: string, evidencePath: string): string {
  const evidenceBullets = [
    args.startedFromEmptyTui
      ? '- Started real local TUI from an empty Goal/Execution state.'
      : '- Empty local TUI start was not operator-attested for this canary.',
    '- First Chat message triggered `GOAL.md` creation and Claude Code plan mode.',
    '- Planner emitted `PLAN_USAGE` events.',
    '- Codex execution emitted `EXECUTE_PROGRESS` with token usage.',
    args.codexAttemptedSsh
      ? '- Codex attempted the SSH connection itself when the plan required SSH.'
      : '- Codex SSH attempt was not operator-attested for this canary.',
    args.operatorManualExecution
      ? '- Operator manual SSH, deployment, setup, or measurement was used during this canary.'
      : '- No manual SSH, deployment, model setup, or measurement was performed outside WiCi.'
  ];
  const resultLines = args.status === 'passed'
    ? ['The canary passed and reached the requested target.', '', args.tagAllowed ? 'Tag gate may allow a release if version and artifact checks also pass.' : 'Tagging is still not allowed for this recorded canary.']
    : [
        'The canary did not reach the requested target. The current release must not be tagged or pushed as verified.',
        '',
        ...(args.failureReason ? [`Failure reason: ${args.failureReason}`, ''] : []),
        ...(args.nextRequiredAction ? [`Next required action: ${args.nextRequiredAction}`] : [])
      ];

  return [
    `# Release Canary: ${canaryName}`,
    '',
    `status: ${args.status}`,
    `tag_allowed: ${String(args.tagAllowed)}`,
    `target: ${args.target}`,
    `evidence_bundle: ${evidencePath}`,
    `first_chat: ${args.firstChat}`,
    ...(args.failureReason ? [`failure_reason: ${args.failureReason}`] : []),
    ...(args.nextRequiredAction ? [`next_required_action: ${args.nextRequiredAction}`] : []),
    '',
    '## Evidence',
    '',
    ...evidenceBullets,
    '',
    '## Result',
    '',
    ...resultLines,
    '',
    '## Artifacts',
    '',
    `Committed evidence bundle: \`${evidencePath}\``,
    '',
    `Committed artifact files: \`${dirname(evidencePath)}/artifacts/\``,
    '',
    '- `GOAL.md`',
    '- `PLAN.md`',
    '- `.wici/events.jsonl`',
    '- `ledger.jsonl`',
    '- `.wici/codex-run.jsonl`',
    '- `.wici/artifacts/planner-initial.stdout.jsonl`',
    '- optional planner artifacts under `.opt/` when present',
    ''
  ].join('\n');
}

async function copyArtifact(target: string, artifactRoot: string, relativePath: string, required: boolean): Promise<string> {
  const source = join(target, relativePath);
  if (!(await exists(source))) {
    if (required) throw new Error(`Missing required canary artifact: ${source}`);
    return '';
  }
  const destination = join(artifactRoot, ...relativePath.split('/'));
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  return destination;
}

async function digest(path: string): Promise<ArtifactDigest> {
  const raw = await readFile(path);
  return {
    sha256: createHash('sha256').update(raw).digest('hex'),
    bytes: raw.byteLength
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readText(path: string): Promise<string> {
  return (await exists(path)) ? readFile(path, 'utf8') : '';
}

async function readJsonMaybe<T>(path: string): Promise<T | null> {
  if (!(await exists(path))) return null;
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  const raw = await readText(path);
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function latestEvent(events: Record<string, unknown>[], type: string): Record<string, unknown> | null {
  return [...events].reverse().find((event) => event.type === type) ?? null;
}

function summarizeExecuteProgress(event: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!event) return undefined;
  const progress = event.data && typeof event.data === 'object' ? ((event.data as Record<string, unknown>).progress as Record<string, unknown> | undefined) : undefined;
  const usage = event.data && typeof event.data === 'object' ? ((event.data as Record<string, unknown>).usage as Record<string, unknown> | undefined) : undefined;
  const progressUsage = progress?.usage && typeof progress.usage === 'object' ? (progress.usage as Record<string, unknown>) : undefined;
  return {
    turn_completed:
      String(event.message ?? '').includes('turn.completed') ||
      progress?.completed_turns === 1 ||
      progressUsage?.completed_turns === 1,
    tokens_input:
      numberFromObject(progress, 'tokens_input') ??
      numberFromObject(progressUsage, 'tokens_input') ??
      numberFromObject(usage, 'tokens_input'),
    tokens_output:
      numberFromObject(progress, 'tokens_output') ??
      numberFromObject(progressUsage, 'tokens_output') ??
      numberFromObject(usage, 'tokens_output')
  };
}

function numberFromPath(value: Record<string, unknown>, path: string[]): number | undefined {
  let current: unknown = value;
  for (const part of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'number' ? current : undefined;
}

function numberFromObject(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'number' ? candidate : undefined;
}

function planMentionsExpectedSshTarget(plan: string, expectedText: string): boolean {
  if (!canaryExpectsSsh(expectedText)) return false;
  const expected = inspectCodexSshTranscript('', expectedText).expectedHostTerms;
  return /\bssh\b/i.test(plan) || expected.some((term) => plan.includes(term));
}

function canaryExpectsSsh(text: string): boolean {
  return /\bssh\b/i.test(text) || inspectCodexSshTranscript('', text).expectedHostTerms.length > 0;
}

async function git(target: string, args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { reject: false });
  return result.exitCode === 0 ? result.stdout.trim() : '';
}

async function gitDirty(target: string): Promise<boolean> {
  const result = await execa('git', ['-C', target, 'status', '--porcelain'], { reject: false });
  return result.exitCode !== 0 || result.stdout.trim().length > 0;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    values.set(key.slice(2), value);
    index += 1;
  }
  const status = values.get('status');
  if (status !== 'passed' && status !== 'failed') throw new Error('--status must be passed or failed');
  const name = values.get('name');
  const target = values.get('target');
  const firstChat = values.get('first-chat');
  if (!name || !target || !firstChat) {
    throw new Error(
      'Usage: record-canary --name <name> --target <target> --status <passed|failed> --tag-allowed <true|false> --first-chat <text> --started-from-empty-tui <true|false> --operator-manual-execution <true|false> --codex-attempted-ssh <true|false>'
    );
  }
  const tagAllowed = requiredBoolean(values, 'tag-allowed');
  const failureReason = values.get('failure-reason');
  const nextRequiredAction = values.get('next-required-action');
  const targetValue = optionalFiniteNumber(values, 'target-value');
  const observedValue = optionalFiniteNumber(values, 'observed-value');
  const unit = values.get('unit');
  validateStatusArgs(status, tagAllowed, failureReason, nextRequiredAction);
  validateTargetArgs(status, values.has('target-value'), targetValue, values.has('observed-value'), observedValue, unit);
  validateAttestationArgs(
    status,
    requiredBoolean(values, 'started-from-empty-tui'),
    requiredBoolean(values, 'operator-manual-execution')
  );
  return {
    name,
    target,
    status,
    tagAllowed,
    firstChat,
    startedFromEmptyTui: requiredBoolean(values, 'started-from-empty-tui'),
    operatorManualExecution: requiredBoolean(values, 'operator-manual-execution'),
    codexAttemptedSsh: requiredBoolean(values, 'codex-attempted-ssh'),
    failureReason,
    nextRequiredAction,
    targetValue,
    observedValue,
    unit,
    outDir: values.get('out-dir') ?? 'docs/release-canaries'
  };
}

function validateCanaryArgs(args: Args): void {
  validateStatusArgs(args.status, args.tagAllowed, args.failureReason, args.nextRequiredAction);
  validateTargetArgs(args.status, args.targetValue !== undefined, args.targetValue, args.observedValue !== undefined, args.observedValue, args.unit);
  validateAttestationArgs(args.status, args.startedFromEmptyTui, args.operatorManualExecution);
}

function validateTargetArgs(
  status: Args['status'],
  hasTargetValue: boolean,
  targetValue: number | undefined,
  hasObservedValue: boolean,
  observedValue: number | undefined,
  unit: string | undefined
): void {
  if (hasTargetValue && targetValue === undefined) throw new Error('--target-value must be a finite number');
  if (hasObservedValue && observedValue === undefined) throw new Error('--observed-value must be a finite number');
  if (hasTargetValue && !unit) throw new Error('--unit is required when --target-value is provided');
  if (!hasTargetValue && unit) throw new Error('--target-value is required when --unit is provided');
  if (hasObservedValue && !hasTargetValue) throw new Error('--target-value is required when --observed-value is provided');
  if (status === 'passed' && hasTargetValue && observedValue === undefined) throw new Error('--observed-value is required when --status passed and --target-value is provided');
  if (status === 'passed' && targetValue !== undefined && observedValue !== undefined && observedValue < targetValue) {
    throw new Error('--observed-value must be greater than or equal to --target-value when --status passed');
  }
}

function validateStatusArgs(status: Args['status'], tagAllowed: boolean, failureReason: string | undefined, nextRequiredAction: string | undefined): void {
  if (status === 'failed') {
    if (tagAllowed) throw new Error('--tag-allowed must be false when --status failed');
    if (!failureReason) throw new Error('--failure-reason is required when --status failed');
    if (!nextRequiredAction) throw new Error('--next-required-action is required when --status failed');
  } else {
    if (failureReason) throw new Error('--failure-reason must be omitted when --status passed');
    if (nextRequiredAction) throw new Error('--next-required-action must be omitted when --status passed');
  }
}

function validateAttestationArgs(status: Args['status'], startedFromEmptyTui: boolean, operatorManualExecution: boolean): void {
  if (status !== 'passed') return;
  if (!startedFromEmptyTui) throw new Error('--started-from-empty-tui must be true when --status passed');
  if (operatorManualExecution) throw new Error('--operator-manual-execution must be false when --status passed');
}

function validatePassedSourceEvidence(
  args: Args,
  toolVersions: Record<string, unknown> | undefined,
  wiciVersion: Record<string, unknown> | undefined,
  targetGitDirty: boolean,
  goalSource: string | null
): void {
  if (args.status !== 'passed') return;
  if (toolVersions?.mode !== 'real') throw new Error('--status passed requires checkpoint tool mode real');
  if (wiciVersion?.git_dirty !== false) throw new Error('--status passed requires clean WiCi checkout evidence');
  if (targetGitDirty !== false) throw new Error('--status passed requires clean target git checkout');
  if (goalSource !== 'tui_chat') throw new Error('--status passed requires checkpoint goal_source tui_chat');
}

function optionalFiniteNumber(values: Map<string, string>, name: string): number | undefined {
  if (!values.has(name)) return undefined;
  const value = Number(values.get(name));
  if (!Number.isFinite(value)) return undefined;
  return value;
}

function requiredBoolean(values: Map<string, string>, name: string): boolean {
  const value = values.get(name);
  if (value !== 'true' && value !== 'false') throw new Error(`--${name} must be true or false`);
  return value === 'true';
}

if (process.argv[1]?.endsWith('record-canary.ts') || process.argv[1]?.endsWith('record-canary.js')) {
  const result = await recordCanaryEvidence(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
