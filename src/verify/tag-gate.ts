import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { scanFilesForSecrets } from './secret-scan.js';
import { inspectCodexSshTranscript } from './ssh-evidence.js';

const canaryDir = process.env.WICI_CANARY_DIR ?? 'docs/release-canaries';

async function main(): Promise<void> {
  const latest = await latestCanary();
  const content = await readFile(latest.path, 'utf8');
  const status = field(content, 'status');
  const tagAllowed = field(content, 'tag_allowed');
  const target = field(content, 'target');
  const evidenceBundle = field(content, 'evidence_bundle');
  const firstChat = field(content, 'first_chat');
  const failureReason = field(content, 'failure_reason');
  const nextRequiredAction = field(content, 'next_required_action');
  const localTags = await gitTags();
  const currentWiCi = await currentWiCiState();
  const artifactEvidence = evidenceBundle
    ? await inspectEvidenceBundle(evidenceBundle, firstChat, status, tagAllowed, failureReason, nextRequiredAction)
    : await inspectArtifacts(target, firstChat);

  const markdownExpectsSsh = canaryExpectsSsh(firstChat);
  const requiredEvidence = [
    'empty Goal/Execution',
    'PLAN_USAGE',
    'EXECUTE_PROGRESS',
    ...(markdownExpectsSsh ? ['Codex attempted the SSH connection itself'] : []),
    'No manual SSH'
  ];
  const missingEvidence = requiredEvidence.filter((item) => !content.includes(item));
  const releaseVersion = releaseVersionEvidence(currentWiCi, artifactEvidence);
  const passed =
    status === 'passed' &&
    tagAllowed === 'true' &&
    missingEvidence.length === 0 &&
    artifactEvidence.ok &&
    releaseVersion.ok;

  const report = {
    ok: passed,
    release_action: passed ? 'tag_allowed' : 'blocked_do_not_tag_or_push',
    latest_canary: latest.name,
    status,
    tag_allowed: tagAllowed,
    target,
    evidence_bundle: evidenceBundle || null,
    first_chat_present: firstChat.length > 0,
    failure_reason: artifactEvidence.failure_reason || failureReason || null,
    next_required_action: artifactEvidence.next_required_action || nextRequiredAction || null,
    missing_evidence: missingEvidence,
    artifact_evidence: artifactEvidence,
    release_version: releaseVersion,
    local_release_tags: localTags,
    local_release_tag_note: !passed && localTags.length > 0 ? 'Existing local release tags are not evidence that the current worktree is releasable.' : null
  };
  console.log(JSON.stringify(report, null, 2));

  if (!passed) {
    process.exitCode = 1;
  }
}

interface ArtifactEvidence {
  ok: boolean;
  source: 'bundle' | 'target';
  missing_files: string[];
  events: {
    plan_usage: boolean;
    plan_done: boolean;
    execute_progress: boolean;
    execute_done: boolean;
    execute_failed: boolean;
  };
  goal_contains_first_chat: boolean;
  plan_mentions_target: boolean;
  ledger_rows: number;
  ledger_has_token_usage: boolean;
  ledger_has_ssh_attempt_result: boolean;
  canary_expects_ssh: boolean;
  codex_ssh_attempt_attested: boolean;
  codex_transcript_has_ssh_attempt: boolean;
  codex_transcript_present: boolean;
  planner_transcript_present: boolean;
  version_point_present: boolean;
  rollback_present: boolean;
  optional_planner_artifacts: string[];
  optional_planner_scripts_executable: boolean;
  optional_planner_scripts_not_executable: string[];
  artifact_files_verified: boolean;
  artifact_files_missing: string[];
  artifact_hash_mismatches: string[];
  secret_scan_ok: boolean;
  secret_findings: string[];
  target_value: number | null;
  target_unit: string | null;
  observed_value: number | null;
  observed_unit: string | null;
  passed_observed_target: boolean | null;
  failure_reason: string | null;
  next_required_action: string | null;
  canary_target_git_dirty: boolean | null;
  canary_tool_mode: string | null;
  canary_goal_source: string | null;
  canary_wici_git_commit: string | null;
  canary_wici_git_dirty: boolean | null;
}

interface CurrentWiCiState {
  git_commit: string | null;
  git_dirty: boolean;
}

interface ReleaseVersionEvidence {
  ok: boolean;
  current_wici_git_commit: string | null;
  current_wici_git_dirty: boolean;
  canary_wici_git_commit: string | null;
  canary_wici_git_dirty: boolean | null;
  canary_matches_current: boolean;
  reason: string | null;
}

interface CanaryEvidenceBundle {
  version: number;
  status: string;
  tag_allowed: boolean;
  target: string;
  first_chat: string;
  started_from_empty_tui: boolean;
  operator_manual_execution: boolean;
  codex_attempted_ssh?: boolean;
  version_point?: {
    tool_mode?: string | null;
    wici_package_version?: string;
    wici_git_commit?: string | null;
    wici_git_dirty?: boolean;
    codex?: string;
    claude?: string;
    checked_at?: string;
  };
  rollback?: {
    target_head?: string;
    target_git_dirty?: boolean;
    wici_best_ref?: string;
    checkpoint_best_commit?: string | null;
    rollback_command?: string;
  };
  run_checkpoint?: {
    supervisor_state?: string;
    goal_source?: string | null;
    iter?: number;
    plan_hash?: string;
    events_seq?: number;
    ledger_seq?: number;
  };
  generated_artifacts: Record<string, { sha256: string; bytes: number }>;
  goal_summary: {
    contains_first_chat: boolean;
    target: number | null;
    unit: string | null;
  };
  plan_summary: {
    mentions_ssh_target: boolean;
    mentions_measure_script?: boolean;
    mentions_target_threshold: boolean;
  };
  events: {
    PLAN_USAGE?: string[];
    PLAN_DONE?: boolean;
    EXECUTE_PROGRESS?: {
      turn_completed?: boolean;
      tokens_input?: number;
      tokens_output?: number;
    };
    EXECUTE_DONE?: {
      message?: string;
    };
    EXECUTE_FAILED?: unknown;
  };
  ledger: Array<{
    id: string;
    status: string;
    tokens_input?: number;
    tokens_output?: number;
    reflection?: string;
  }>;
  result: {
    reached_target: boolean;
    observed_value?: number;
    observed_unit?: string | null;
    failure_reason?: string;
    next_required_action?: string;
  };
}

async function inspectEvidenceBundle(
  path: string,
  firstChat: string,
  markdownStatus: string,
  markdownTagAllowed: string,
  failureReason: string,
  nextRequiredAction: string
): Promise<ArtifactEvidence> {
  if (!(await exists(path))) {
    return emptyArtifactEvidence('bundle', [path]);
  }
  const evidence = JSON.parse(await readFile(path, 'utf8')) as CanaryEvidenceBundle;
  const requiredArtifacts = [
    'GOAL.md',
    'PLAN.md',
    '.wici/events.jsonl',
    'ledger.jsonl',
    '.wici/codex-run.jsonl',
    '.wici/artifacts/planner-initial.stdout.jsonl'
  ];
  const optionalPlannerArtifactNames = ['.opt/checks.sh', '.opt/measure.sh', '.opt/benchmark.json'];
  const missingRequiredFiles = requiredArtifacts.filter((name) => {
    const item = evidence.generated_artifacts?.[name];
    return !item || !item.sha256 || !(item.bytes > 0);
  });
  const invalidOptionalFiles = optionalPlannerArtifactNames.filter((name) => {
    const item = evidence.generated_artifacts?.[name];
    return Boolean(item) && (!item?.sha256 || !(item.bytes > 0));
  });
  const optionalPlannerArtifacts = optionalPlannerArtifactNames.filter((name) => {
    const item = evidence.generated_artifacts?.[name];
    return Boolean(item?.sha256 && item.bytes > 0);
  });
  const optionalPlannerScriptPaths = optionalPlannerArtifacts.filter((name) => name.endsWith('.sh'));
  const missingFiles = [...missingRequiredFiles, ...invalidOptionalFiles];
  const artifactFiles = await verifyGeneratedArtifactFiles(path, evidence.generated_artifacts ?? {});
  const optionalPlannerScripts = await verifyExecutableArtifacts(path, optionalPlannerScriptPaths);
  const secretScan = await scanEvidenceFilesForSecrets(path, evidence.generated_artifacts ?? {});
  const codexTranscript = await readGeneratedArtifactText(path, '.wici/codex-run.jsonl', evidence.generated_artifacts ?? {});
  const ledgerText = evidence.ledger.map((entry) => entry.reflection ?? '').join('\n');
  const evidenceText = [
    evidence.first_chat,
    ledgerText,
    evidence.events.EXECUTE_DONE?.message ?? '',
    evidence.result.failure_reason ?? '',
    evidence.result.next_required_action ?? ''
  ].join('\n');
  const hasTokenUsage = evidence.ledger.some((entry) => typeof entry.tokens_input === 'number' || typeof entry.tokens_output === 'number');
  const versionPointPresent = hasVersionPoint(evidence);
  const realModeForPassed = evidence.status === 'passed' ? evidence.version_point?.tool_mode === 'real' : true;
  const rollbackPresent = hasRollbackPoint(evidence);
  const bundleFailureReason = evidence.result.failure_reason ?? '';
  const bundleNextRequiredAction = evidence.result.next_required_action ?? '';
  const failureReasonMatches = statusAllowsOmittedBlocker(evidence.status)
    ? true
    : Boolean(bundleFailureReason) && failureReason === bundleFailureReason;
  const nextRequiredActionMatches = statusAllowsOmittedBlocker(evidence.status)
    ? true
    : Boolean(bundleNextRequiredAction) && nextRequiredAction === bundleNextRequiredAction;
  const statusMatches = evidence.status === markdownStatus;
  const tagAllowedMatches = String(evidence.tag_allowed) === markdownTagAllowed;
  const expectsSsh = canaryExpectsSsh(`${evidence.first_chat}\n${evidenceText}`);
  const passedTargetEvidence = evidence.status === 'passed' ? passedObservedTargetEvidence(evidence) : null;
  const targetCleanForPassed = evidence.status === 'passed' ? evidence.rollback?.target_git_dirty === false : true;
  const tuiChatForPassed = evidence.status === 'passed' ? evidence.run_checkpoint?.goal_source === 'tui_chat' : true;
  const resultMatchesStatus = evidence.status === 'passed'
    ? evidence.result.reached_target === true && passedTargetEvidence === true
    : evidence.result.reached_target === false && Boolean(bundleFailureReason) && Boolean(bundleNextRequiredAction);
  const hasSshAttemptEvidence = expectsSsh ? /\bssh\b|publickey/i.test(evidenceText) : true;
  const hasCodexTranscriptSshAttempt = inspectCodexSshTranscript(codexTranscript, `${evidence.first_chat}\n${evidenceText}`).hasSshAttempt;
  return {
    ok:
      evidence.version === 1 &&
      statusMatches &&
      tagAllowedMatches &&
      evidence.first_chat === firstChat &&
      evidence.started_from_empty_tui === true &&
      evidence.operator_manual_execution === false &&
      (!expectsSsh || evidence.codex_attempted_ssh === true) &&
      versionPointPresent &&
      realModeForPassed &&
      rollbackPresent &&
      missingFiles.length === 0 &&
      artifactFiles.verified &&
      optionalPlannerScripts.executable &&
      secretScan.ok &&
      evidence.goal_summary.contains_first_chat === true &&
      targetMetadataValid(evidence) &&
      (!expectsSsh || evidence.plan_summary.mentions_ssh_target === true) &&
      (evidence.goal_summary.target === null || evidence.plan_summary.mentions_target_threshold === true) &&
      (evidence.events.PLAN_USAGE?.length ?? 0) > 0 &&
      evidence.events.PLAN_DONE === true &&
      evidence.events.EXECUTE_PROGRESS?.turn_completed === true &&
      (evidence.events.EXECUTE_PROGRESS.tokens_input ?? 0) > 0 &&
      (evidence.events.EXECUTE_PROGRESS.tokens_output ?? 0) > 0 &&
      evidence.ledger.length > 0 &&
      hasTokenUsage &&
      hasSshAttemptEvidence &&
      (!expectsSsh || hasCodexTranscriptSshAttempt) &&
      targetCleanForPassed &&
      tuiChatForPassed &&
      resultMatchesStatus &&
      failureReasonMatches &&
      nextRequiredActionMatches,
    source: 'bundle',
    missing_files: missingFiles,
    events: {
      plan_usage: (evidence.events.PLAN_USAGE?.length ?? 0) > 0,
      plan_done: evidence.events.PLAN_DONE === true,
      execute_progress: evidence.events.EXECUTE_PROGRESS?.turn_completed === true,
      execute_done: Boolean(evidence.events.EXECUTE_DONE),
      execute_failed: Boolean(evidence.events.EXECUTE_FAILED)
    },
    goal_contains_first_chat: evidence.goal_summary.contains_first_chat === true && evidence.first_chat === firstChat,
    plan_mentions_target: evidence.plan_summary.mentions_target_threshold === true,
    ledger_rows: evidence.ledger.length,
    ledger_has_token_usage: hasTokenUsage,
    ledger_has_ssh_attempt_result: hasSshAttemptEvidence,
    canary_expects_ssh: expectsSsh,
    codex_ssh_attempt_attested: evidence.codex_attempted_ssh === true,
    codex_transcript_has_ssh_attempt: expectsSsh ? hasCodexTranscriptSshAttempt : true,
    codex_transcript_present: Boolean(evidence.generated_artifacts?.['.wici/codex-run.jsonl']),
    planner_transcript_present: Boolean(evidence.generated_artifacts?.['.wici/artifacts/planner-initial.stdout.jsonl']),
    version_point_present: versionPointPresent,
    rollback_present: rollbackPresent,
    optional_planner_artifacts: optionalPlannerArtifacts,
    optional_planner_scripts_executable: optionalPlannerScripts.executable,
    optional_planner_scripts_not_executable: optionalPlannerScripts.notExecutable,
    artifact_files_verified: artifactFiles.verified,
    artifact_files_missing: artifactFiles.missing,
    artifact_hash_mismatches: artifactFiles.mismatches,
    secret_scan_ok: secretScan.ok,
    secret_findings: secretScan.findings,
    target_value: finiteOrNull(evidence.goal_summary.target),
    target_unit: evidence.goal_summary.unit ?? null,
    observed_value: finiteOrNull(evidence.result.observed_value),
    observed_unit: evidence.result.observed_unit ?? null,
    passed_observed_target: passedTargetEvidence,
    failure_reason: bundleFailureReason || null,
    next_required_action: bundleNextRequiredAction || null,
    canary_target_git_dirty: evidence.rollback?.target_git_dirty ?? null,
    canary_tool_mode: evidence.version_point?.tool_mode ?? null,
    canary_goal_source: evidence.run_checkpoint?.goal_source ?? null,
    canary_wici_git_commit: evidence.version_point?.wici_git_commit ?? null,
    canary_wici_git_dirty: evidence.version_point?.wici_git_dirty ?? null
  };
}

function passedObservedTargetEvidence(evidence: CanaryEvidenceBundle): boolean {
  if (evidence.status !== 'passed') return true;
  const target = evidence.goal_summary.target;
  const unit = evidence.goal_summary.unit;
  if (target === null) return true;
  return (
    typeof target === 'number' &&
    Number.isFinite(target) &&
    typeof unit === 'string' &&
    unit.length > 0 &&
    typeof evidence.result.observed_value === 'number' &&
    Number.isFinite(evidence.result.observed_value) &&
    evidence.result.observed_value >= target &&
    evidence.result.observed_unit === unit
  );
}

function targetMetadataValid(evidence: CanaryEvidenceBundle): boolean {
  const target = evidence.goal_summary.target;
  const unit = evidence.goal_summary.unit;
  if (target === null) return unit === null;
  return typeof target === 'number' && Number.isFinite(target) && typeof unit === 'string' && unit.length > 0;
}

function canaryExpectsSsh(text: string): boolean {
  return /\bssh\b/i.test(text) || inspectCodexSshTranscript('', text).expectedHostTerms.length > 0;
}

function planMentionsNumericTerms(plan: string, firstChat: string): boolean {
  const terms = [...new Set([...firstChat.matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0]))];
  return terms.length === 0 || terms.some((term) => plan.includes(term));
}

function statusAllowsOmittedBlocker(status: string): boolean {
  return status === 'passed';
}

function hasVersionPoint(evidence: CanaryEvidenceBundle): boolean {
  const version = evidence.version_point;
  const checkpoint = evidence.run_checkpoint;
  return Boolean(
    version?.wici_package_version &&
      (version.wici_git_commit === null || /^[0-9a-f]{40}$/.test(version.wici_git_commit ?? '')) &&
      typeof version?.wici_git_dirty === 'boolean' &&
      version?.codex &&
      version?.claude &&
      version?.checked_at &&
      checkpoint?.supervisor_state &&
      Number.isInteger(checkpoint.iter) &&
      checkpoint.plan_hash &&
      Number.isInteger(checkpoint.events_seq) &&
      Number.isInteger(checkpoint.ledger_seq)
  );
}

function hasRollbackPoint(evidence: CanaryEvidenceBundle): boolean {
  const rollback = evidence.rollback;
  return Boolean(
    /^[0-9a-f]{40}$/.test(rollback?.target_head ?? '') &&
      /^[0-9a-f]{40}$/.test(rollback?.wici_best_ref ?? '') &&
      (rollback?.checkpoint_best_commit === null || /^[0-9a-f]{40}$/.test(rollback?.checkpoint_best_commit ?? '')) &&
      rollback?.rollback_command?.includes('rollback --target')
  );
}

async function inspectArtifacts(target: string, firstChat: string): Promise<ArtifactEvidence> {
  const paths = {
    goal: join(target, 'GOAL.md'),
    plan: join(target, 'PLAN.md'),
    events: join(target, '.wici', 'events.jsonl'),
    ledger: join(target, 'ledger.jsonl'),
    plannerTranscript: join(target, '.wici', 'artifacts', 'planner-initial.stdout.jsonl'),
    codexTranscript: join(target, '.wici', 'codex-run.jsonl')
  };
  const missingFiles = (
    await Promise.all(
      Object.values(paths).map(async (path) => {
        return (await exists(path)) ? null : path;
      })
    )
  ).filter((path): path is string => Boolean(path));

  const goal = await readText(paths.goal);
  const plan = await readText(paths.plan);
  const events = (await readJsonLines<Record<string, unknown>>(paths.events));
  const ledger = await readJsonLines<{ cost?: Record<string, unknown>; reflection?: string; guards?: Record<string, unknown> }>(paths.ledger);
  const eventTypes = new Set(events.map((event) => String(event.type ?? '')));
  const ledgerText = ledger.map((entry) => `${entry.reflection ?? ''} ${String(entry.guards?.reason ?? '')}`).join('\n');
  const codexTranscript = await readText(paths.codexTranscript);
  const expectsSsh = canaryExpectsSsh(`${firstChat}\n${goal}\n${plan}`);
  const hasSshAttemptEvidence = expectsSsh ? /\bssh\b|publickey/i.test(`${goal}\n${plan}\n${ledgerText}`) : true;
  const hasCodexTranscriptSshAttempt = inspectCodexSshTranscript(codexTranscript, `${goal}\n${plan}\n${firstChat}`).hasSshAttempt;
  const optionalPlannerScripts = await verifyExecutablePaths([join(target, '.opt', 'checks.sh'), join(target, '.opt', 'measure.sh')]);
  const secretScan = await scanExistingFilesForSecrets(Object.values(paths));
  const planMentionsTarget = planMentionsNumericTerms(plan, firstChat);

  return {
    ok:
      missingFiles.length === 0 &&
      goal.includes(firstChat) &&
      planMentionsTarget &&
      eventTypes.has('PLAN_USAGE') &&
      eventTypes.has('PLAN_DONE') &&
      eventTypes.has('EXECUTE_PROGRESS') &&
      (eventTypes.has('EXECUTE_DONE') || eventTypes.has('EXECUTE_FAILED')) &&
      ledger.length > 0 &&
      ledger.some((entry) => typeof entry.cost?.tokens_input === 'number' || typeof entry.cost?.tokens_output === 'number') &&
      hasSshAttemptEvidence &&
      (!expectsSsh || hasCodexTranscriptSshAttempt) &&
      optionalPlannerScripts.executable &&
      secretScan.ok,
    source: 'target',
    missing_files: missingFiles,
    events: {
      plan_usage: eventTypes.has('PLAN_USAGE'),
      plan_done: eventTypes.has('PLAN_DONE'),
      execute_progress: eventTypes.has('EXECUTE_PROGRESS'),
      execute_done: eventTypes.has('EXECUTE_DONE'),
      execute_failed: eventTypes.has('EXECUTE_FAILED')
    },
    goal_contains_first_chat: goal.includes(firstChat),
    plan_mentions_target: planMentionsTarget,
    ledger_rows: ledger.length,
    ledger_has_token_usage: ledger.some((entry) => typeof entry.cost?.tokens_input === 'number' || typeof entry.cost?.tokens_output === 'number'),
    ledger_has_ssh_attempt_result: hasSshAttemptEvidence,
    canary_expects_ssh: expectsSsh,
    codex_ssh_attempt_attested: false,
    codex_transcript_has_ssh_attempt: expectsSsh ? hasCodexTranscriptSshAttempt : true,
    codex_transcript_present: await exists(paths.codexTranscript),
    planner_transcript_present: await exists(paths.plannerTranscript),
    version_point_present: false,
    rollback_present: false,
    optional_planner_artifacts: [],
    optional_planner_scripts_executable: optionalPlannerScripts.executable,
    optional_planner_scripts_not_executable: optionalPlannerScripts.notExecutable,
    artifact_files_verified: true,
    artifact_files_missing: [],
    artifact_hash_mismatches: [],
    secret_scan_ok: secretScan.ok,
    secret_findings: secretScan.findings,
    target_value: null,
    target_unit: null,
    observed_value: null,
    observed_unit: null,
    passed_observed_target: null,
    failure_reason: null,
    next_required_action: null,
    canary_target_git_dirty: null,
    canary_tool_mode: null,
    canary_goal_source: null,
    canary_wici_git_commit: null,
    canary_wici_git_dirty: null
  };
}

function emptyArtifactEvidence(source: ArtifactEvidence['source'], missingFiles: string[]): ArtifactEvidence {
  return {
    ok: false,
    source,
    missing_files: missingFiles,
    events: {
      plan_usage: false,
      plan_done: false,
      execute_progress: false,
      execute_done: false,
      execute_failed: false
    },
    goal_contains_first_chat: false,
    plan_mentions_target: false,
    ledger_rows: 0,
    ledger_has_token_usage: false,
    ledger_has_ssh_attempt_result: false,
    canary_expects_ssh: false,
    codex_ssh_attempt_attested: false,
    codex_transcript_has_ssh_attempt: false,
    codex_transcript_present: false,
    planner_transcript_present: false,
    version_point_present: false,
    rollback_present: false,
    optional_planner_artifacts: [],
    optional_planner_scripts_executable: true,
    optional_planner_scripts_not_executable: [],
    artifact_files_verified: false,
    artifact_files_missing: [],
    artifact_hash_mismatches: [],
    secret_scan_ok: true,
    secret_findings: [],
    target_value: null,
    target_unit: null,
    observed_value: null,
    observed_unit: null,
    passed_observed_target: null,
    failure_reason: null,
    next_required_action: null,
    canary_target_git_dirty: null,
    canary_tool_mode: null,
    canary_goal_source: null,
    canary_wici_git_commit: null,
    canary_wici_git_dirty: null
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function scanEvidenceFilesForSecrets(
  bundlePath: string,
  artifacts: Record<string, { sha256: string; bytes: number }>
): Promise<{ ok: boolean; findings: string[] }> {
  const paths = [bundlePath, `${bundlePath.replace(/\/evidence\.json$/, '.md')}`];
  for (const name of Object.keys(artifacts)) {
    paths.push(join(dirname(bundlePath), 'artifacts', ...name.split('/')));
  }
  return scanExistingFilesForSecrets(paths);
}

async function readGeneratedArtifactText(
  bundlePath: string,
  relativePath: string,
  artifacts: Record<string, { sha256: string; bytes: number }>
): Promise<string> {
  if (!artifacts[relativePath]) return '';
  return readText(join(dirname(bundlePath), 'artifacts', ...relativePath.split('/')));
}

async function scanExistingFilesForSecrets(paths: string[]): Promise<{ ok: boolean; findings: string[] }> {
  const existing: string[] = [];
  for (const path of paths) {
    if (await exists(path)) existing.push(path);
  }
  const findings = await scanFilesForSecrets(existing);
  return {
    ok: findings.length === 0,
    findings: findings.map((item) => `${item.path}:${item.line} ${item.pattern}`)
  };
}

async function verifyExecutableArtifacts(bundlePath: string, relativePaths: string[]): Promise<{ executable: boolean; notExecutable: string[] }> {
  const paths = relativePaths.map((name) => join(dirname(bundlePath), 'artifacts', ...name.split('/')));
  return verifyExecutablePaths(paths);
}

async function verifyExecutablePaths(paths: string[]): Promise<{ executable: boolean; notExecutable: string[] }> {
  const notExecutable: string[] = [];
  for (const path of paths) {
    if (!(await exists(path))) continue;
    const mode = (await stat(path)).mode;
    if ((mode & 0o111) === 0) notExecutable.push(path);
  }
  return { executable: notExecutable.length === 0, notExecutable };
}

async function verifyGeneratedArtifactFiles(
  bundlePath: string,
  artifacts: Record<string, { sha256: string; bytes: number }>
): Promise<{ verified: boolean; missing: string[]; mismatches: string[] }> {
  const missing: string[] = [];
  const mismatches: string[] = [];
  for (const [name, expected] of Object.entries(artifacts)) {
    const path = join(dirname(bundlePath), 'artifacts', ...name.split('/'));
    if (!(await exists(path))) {
      missing.push(path);
      continue;
    }
    const raw = await readFile(path);
    const sha256 = createHash('sha256').update(raw).digest('hex');
    if (sha256 !== expected.sha256 || raw.byteLength !== expected.bytes) {
      mismatches.push(`${path}: expected ${expected.sha256}/${expected.bytes}, got ${sha256}/${raw.byteLength}`);
    }
  }
  return { verified: missing.length === 0 && mismatches.length === 0, missing, mismatches };
}

function releaseVersionEvidence(current: CurrentWiCiState, artifact: ArtifactEvidence): ReleaseVersionEvidence {
  const canaryMatchesCurrent = Boolean(current.git_commit && artifact.canary_wici_git_commit && current.git_commit === artifact.canary_wici_git_commit);
  const ok = canaryMatchesCurrent && current.git_dirty === false && artifact.canary_wici_git_dirty === false;
  let reason: string | null = null;
  if (!artifact.canary_wici_git_commit) reason = 'canary evidence does not record a WiCi git commit';
  else if (!current.git_commit) reason = 'current WiCi checkout has no git commit';
  else if (!canaryMatchesCurrent) reason = 'canary WiCi commit does not match current HEAD';
  else if (artifact.canary_wici_git_dirty !== false) reason = 'canary was recorded from a dirty WiCi checkout';
  else if (current.git_dirty) reason = 'current WiCi checkout is dirty';
  return {
    ok,
    current_wici_git_commit: current.git_commit,
    current_wici_git_dirty: current.git_dirty,
    canary_wici_git_commit: artifact.canary_wici_git_commit,
    canary_wici_git_dirty: artifact.canary_wici_git_dirty,
    canary_matches_current: canaryMatchesCurrent,
    reason
  };
}

async function currentWiCiState(): Promise<CurrentWiCiState> {
  const head = await execa('git', ['rev-parse', 'HEAD'], { reject: false });
  const status = await execa('git', ['status', '--porcelain'], { reject: false });
  return {
    git_commit: head.exitCode === 0 ? head.stdout.trim() : null,
    git_dirty: status.exitCode !== 0 || status.stdout.trim().length > 0
  };
}

async function latestCanary(): Promise<{ name: string; path: string }> {
  const entries = (await readdir(canaryDir))
    .filter((name) => name.endsWith('.md'))
    .sort();
  if (entries.length === 0) {
    throw new Error(`No release canary evidence files found in ${canaryDir}`);
  }
  const name = entries[entries.length - 1];
  return { name, path: join(canaryDir, name) };
}

function field(content: string, name: string): string {
  const line = content.split('\n').find((item) => item.startsWith(`${name}:`));
  return line?.slice(name.length + 1).trim() ?? '';
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

async function readJsonLines<T>(path: string): Promise<T[]> {
  const raw = await readText(path);
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function gitTags(): Promise<string[]> {
  const result = await execa('git', ['tag', '--list'], { all: true });
  return (result.all ?? result.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((tag) => /^v?\d+\.\d+\.\d+$/.test(tag))
    .sort();
}

await main();
