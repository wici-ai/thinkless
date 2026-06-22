import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import { runSupervisor } from '../supervisor/index.js';
import { recordCanaryEvidence } from '../release/record-canary.js';

const target = resolve('fixture/canary-evidence-target');
const outDir = resolve('fixture/canary-evidence-docs');
const cliOutDir = resolve('fixture/canary-evidence-cli-docs');
const secretTarget = resolve('fixture/canary-evidence-secret-target');
const secretOutDir = resolve('fixture/canary-evidence-secret-docs');
const noSshTarget = resolve('fixture/canary-evidence-no-ssh-target');
const noSshOutDir = resolve('fixture/canary-evidence-no-ssh-docs');
const wrongSshTarget = resolve('fixture/canary-evidence-wrong-ssh-target');
const wrongSshOutDir = resolve('fixture/canary-evidence-wrong-ssh-docs');
const passedDirtyTarget = resolve('fixture/canary-evidence-passed-dirty-target');
const passedDirtyOutDir = resolve('fixture/canary-evidence-passed-dirty-docs');
const nonSshPassedTarget = resolve('fixture/canary-evidence-non-ssh-passed-target');
const nonSshPassedOutDir = resolve('fixture/canary-evidence-non-ssh-passed-docs');
const nonTuiPassedTarget = resolve('fixture/canary-evidence-non-tui-passed-target');
const nonTuiPassedOutDir = resolve('fixture/canary-evidence-non-tui-passed-docs');

async function main(): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  await rm(cliOutDir, { recursive: true, force: true });
  await rm(secretTarget, { recursive: true, force: true });
  await rm(secretOutDir, { recursive: true, force: true });
  await rm(noSshTarget, { recursive: true, force: true });
  await rm(noSshOutDir, { recursive: true, force: true });
  await rm(wrongSshTarget, { recursive: true, force: true });
  await rm(wrongSshOutDir, { recursive: true, force: true });
  await rm(passedDirtyTarget, { recursive: true, force: true });
  await rm(passedDirtyOutDir, { recursive: true, force: true });
  await rm(nonSshPassedTarget, { recursive: true, force: true });
  await rm(nonSshPassedOutDir, { recursive: true, force: true });
  await rm(nonTuiPassedTarget, { recursive: true, force: true });
  await rm(nonTuiPassedOutDir, { recursive: true, force: true });
  await createSampleTarget(target, true);
  const firstChat = '听说diffusionGemma很快，在ssh -p 23276 root@116.127.115.18 -L 8080:localhost:8080试试，要求达到700 token/s以上';
  const run = await runSupervisor({
    target,
    goal: firstChat,
    goalSource: 'tui_chat',
    maxIters: 1,
    mode: 'stub'
  });
  assert(run.state === 'STOP', `stub canary run should stop cleanly: ${JSON.stringify(run)}`);
  await writePlannerTranscript(target);
  await appendFakeExecuteProgress(target);
  await appendFakeSshTranscript(target);

  const recorded = await recordCanaryEvidence({
    name: 'fixture-canary',
    target,
    status: 'failed',
    tagAllowed: false,
    firstChat,
    startedFromEmptyTui: true,
    operatorManualExecution: false,
    codexAttemptedSsh: true,
    failureReason: 'Fixture run did not perform the real remote measurement.',
    nextRequiredAction: 'Run the real Chat-first canary before tagging.',
    targetValue: 700,
    unit: 'token/s',
    outDir
  });

  const evidence = JSON.parse(await readFile(recorded.evidence, 'utf8')) as {
    generated_artifacts: Record<string, { sha256: string; bytes: number }>;
    first_chat: string;
    started_from_empty_tui: boolean;
    operator_manual_execution: boolean;
    codex_attempted_ssh: boolean;
    events: { EXECUTE_PROGRESS?: { tokens_input?: number; tokens_output?: number } };
    goal_summary: { contains_first_chat: boolean; target: number; unit: string };
    run_checkpoint: { goal_source: string | null };
    rollback: { target_git_dirty: boolean };
    result: { reached_target: boolean; failure_reason: string; next_required_action: string };
  };
  assert(evidence.first_chat === firstChat, 'recorded evidence must preserve first Chat verbatim');
  assert(evidence.started_from_empty_tui === true, 'recorded evidence must preserve empty-TUI operator attestation');
  assert(evidence.operator_manual_execution === false, 'recorded evidence must preserve no-manual-execution operator attestation');
  assert(evidence.codex_attempted_ssh === true, 'recorded evidence must preserve Codex SSH-attempt operator attestation');
  assert(
    (evidence.events.EXECUTE_PROGRESS?.tokens_input ?? 0) > 0 && (evidence.events.EXECUTE_PROGRESS?.tokens_output ?? 0) > 0,
    'recorded evidence must preserve executor token usage'
  );
  assert(evidence.goal_summary.contains_first_chat === true, 'GOAL.md summary should prove first Chat was preserved');
  assert(evidence.run_checkpoint.goal_source === 'tui_chat', 'recorded evidence should prove first Chat came from TUI Chat intake');
  assert(evidence.goal_summary.target === 700 && evidence.goal_summary.unit === 'token/s', 'recorded evidence should preserve canary target metadata');
  assert(evidence.rollback.target_git_dirty === false, 'recorded evidence should preserve target git cleanliness');
  assert(evidence.result.reached_target === false, 'failed fixture canary should not claim target reached');

  for (const [relativePath, expected] of Object.entries(evidence.generated_artifacts)) {
    const path = `${outDir}/fixture-canary/artifacts/${relativePath}`;
    const raw = await readFile(path);
    const sha256 = createHash('sha256').update(raw).digest('hex');
    assert(sha256 === expected.sha256, `${relativePath} sha256 mismatch`);
    assert(raw.byteLength === expected.bytes, `${relativePath} byte length mismatch`);
  }
  const markdown = await readFile(recorded.markdown, 'utf8');
  assert(markdown.includes('evidence_bundle:'), 'recorded markdown should reference the evidence bundle');
  assert(markdown.includes('Committed artifact files'), 'recorded markdown should document copied artifacts');
  assert(markdown.includes('## Result'), 'recorded markdown should include a human-readable result section');
  assert(markdown.includes('The canary did not reach the requested target'), 'failed recorded markdown should state that the target was not reached');
  assert(markdown.includes('Next required action: Run the real Chat-first canary before tagging.'), 'failed recorded markdown should surface the next required action');
  assert(markdown.includes('`.wici/codex-run.jsonl`'), 'recorded markdown should list the Codex transcript artifact');
  assert(markdown.includes('Started real local TUI from an empty Goal/Execution state.'), 'recorded markdown should include attested empty-TUI evidence');
  assert(markdown.includes('Codex attempted the SSH connection itself'), 'recorded markdown should include attested Codex SSH evidence');
  assert(markdown.includes('No manual SSH'), 'recorded markdown should include attested no-manual-execution evidence');
  assert(recorded.artifacts.length >= 6, `expected required artifacts to be copied, got ${recorded.artifacts.length}`);
  await stat(`${outDir}/fixture-canary/artifacts/.wici/codex-run.jsonl`);
  await assertExecutable(`${outDir}/fixture-canary/artifacts/.opt/checks.sh`);
  await assertExecutable(`${outDir}/fixture-canary/artifacts/.opt/measure.sh`);
  await verifyCliRecorder(firstChat);
  await verifyCliRecorderRejectsMissingAttestation(firstChat);
  await verifyCliRecorderRejectsContradictoryStatus(firstChat);
  await verifyCliRecorderRejectsInvalidTargetMetadata(firstChat);
  await verifyCliRecorderRejectsInvalidPassedObservedValue(firstChat);
  await verifyCliRecorderRejectsInvalidPassedAttestation(firstChat);
  await verifyRecorderRejectsUnsupportedSshAttestation(firstChat);
  await verifyRecorderRejectsWrongSshTarget(firstChat);
  await verifyRecorderRejectsSourceSecrets(firstChat);
  await verifyTagGateRejectsPassedDirtyTarget(firstChat);
  await verifyNonTuiPassedCanaryRejected(firstChat);
  await verifyTagGateHandlesNonSshPassedCanary();

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        evidence: recorded.evidence,
        artifacts: Object.keys(evidence.generated_artifacts).length,
        hashes_verified: true,
        cli_recorder: true,
        cli_requires_attestation: true,
        cli_rejects_contradictory_status: true,
        cli_rejects_invalid_target_metadata: true,
        cli_rejects_invalid_passed_observed_value: true,
        cli_rejects_invalid_passed_attestation: true,
        recorder_rejects_unsupported_ssh_attestation: true,
        recorder_rejects_wrong_ssh_target: true,
        recorder_rejects_source_secrets: true,
        target_clean_recorded: true,
        recorder_rejects_stub_mode_passed_canary: true,
        recorder_rejects_dirty_target_passed_canary: true,
        tag_gate_rejects_passed_dirty_target: true,
        recorder_rejects_non_tui_passed_canary: true,
        tag_gate_rejects_non_tui_passed_canary: true,
        tag_gate_rejects_stub_mode_passed_canary: true,
        tag_gate_handles_non_ssh_canary: true
      },
      null,
      2
    )
  );
}

async function verifyCliRecorderRejectsInvalidPassedAttestation(firstChat: string): Promise<void> {
  await expectRecorderFailure(
    [
      '--name',
      'fixture-canary-passed-not-empty-tui',
      '--target',
      target,
      '--status',
      'passed',
      '--tag-allowed',
      'true',
      '--first-chat',
      firstChat,
      '--started-from-empty-tui',
      'false',
      '--operator-manual-execution',
      'false',
      '--codex-attempted-ssh',
      'true',
      '--target-value',
      '700',
      '--observed-value',
      '701',
      '--unit',
      'token/s',
      '--out-dir',
      cliOutDir
    ],
    '--started-from-empty-tui must be true when --status passed'
  );
  await expectRecorderFailure(
    [
      '--name',
      'fixture-canary-passed-manual-execution',
      '--target',
      target,
      '--status',
      'passed',
      '--tag-allowed',
      'true',
      '--first-chat',
      firstChat,
      '--started-from-empty-tui',
      'true',
      '--operator-manual-execution',
      'true',
      '--codex-attempted-ssh',
      'true',
      '--target-value',
      '700',
      '--observed-value',
      '701',
      '--unit',
      'token/s',
      '--out-dir',
      cliOutDir
    ],
    '--operator-manual-execution must be false when --status passed'
  );
}

async function verifyTagGateHandlesNonSshPassedCanary(): Promise<void> {
  const firstChat = 'Build a tiny local CLI and verify the generated artifact works from the terminal.';
  try {
    await createSampleTarget(nonSshPassedTarget, true);
    const run = await runSupervisor({
      target: nonSshPassedTarget,
      goal: firstChat,
      goalSource: 'tui_chat',
      maxIters: 1,
      mode: 'stub'
    });
    assert(run.state === 'STOP', `non-ssh fixture run should stop cleanly: ${JSON.stringify(run)}`);
    await forceCheckpointToolMode(nonSshPassedTarget, 'stub', { wiciGitDirty: false });
    await writePlannerTranscript(nonSshPassedTarget);
    await appendFakeExecuteProgress(nonSshPassedTarget);
    let recorderRejectedStubPassed = false;
    try {
      await recordCanaryEvidence({
        name: 'fixture-non-ssh-passed-stub-rejected',
        target: nonSshPassedTarget,
        status: 'passed',
        tagAllowed: true,
        firstChat,
        startedFromEmptyTui: true,
        operatorManualExecution: false,
        codexAttemptedSsh: false,
        outDir: nonSshPassedOutDir
      });
    } catch (error) {
      recorderRejectedStubPassed = String((error as Error).message).includes('checkpoint tool mode real');
    }
    assert(recorderRejectedStubPassed, 'recorder should reject passed canary evidence recorded from stub tool mode');
    await forceCheckpointToolMode(nonSshPassedTarget, 'real', { wiciGitDirty: false });
    await recordCanaryEvidence({
      name: 'fixture-non-ssh-passed',
      target: nonSshPassedTarget,
      status: 'passed',
      tagAllowed: true,
      firstChat,
      startedFromEmptyTui: true,
      operatorManualExecution: false,
      codexAttemptedSsh: false,
      outDir: nonSshPassedOutDir
    });
    await mutateEvidence(`${nonSshPassedOutDir}/fixture-non-ssh-passed/evidence.json`, (evidence) => {
      evidence.version_point = {
        ...(typeof evidence.version_point === 'object' && evidence.version_point ? evidence.version_point : {}),
        tool_mode: 'stub'
      };
    });
    const result = await execa(process.execPath, ['--import', 'tsx', 'src/verify/tag-gate.ts'], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        WICI_CANARY_DIR: nonSshPassedOutDir
      },
      all: true,
      reject: false,
      timeout: 30_000
    });
    const report = parseJsonReport(result.all ?? result.stdout);
    const missingEvidence = report.missing_evidence as string[] | undefined;
    const artifact = report.artifact_evidence as {
      ok?: boolean;
      canary_expects_ssh?: boolean;
      codex_transcript_has_ssh_attempt?: boolean;
      canary_tool_mode?: string;
      canary_goal_source?: string;
    } | undefined;
    assert(!missingEvidence?.includes('Codex attempted the SSH connection itself'), `non-SSH canary should not require SSH markdown evidence:\n${result.all}`);
    assert(artifact?.canary_expects_ssh === false, `tag gate should classify this canary as non-SSH:\n${result.all}`);
    assert(artifact?.codex_transcript_has_ssh_attempt === true, `non-SSH canary should not fail transcript SSH evidence:\n${result.all}`);
    assert(artifact?.canary_tool_mode === 'stub', `fixture should expose stub tool mode:\n${result.all}`);
    assert(artifact?.canary_goal_source === 'tui_chat', `tag gate should expose TUI Chat goal source:\n${result.all}`);
    assert(artifact?.ok === false, `tag gate must reject passed canaries recorded from stub mode:\n${result.all}`);
  } finally {
    await rm(nonSshPassedTarget, { recursive: true, force: true });
    await rm(nonSshPassedOutDir, { recursive: true, force: true });
  }
}

async function writePlannerTranscript(root: string): Promise<void> {
  const paths = runPaths(root);
  await mkdir(paths.artifacts, { recursive: true });
  await writeFile(`${paths.artifacts}/planner-initial.stdout.jsonl`, `${JSON.stringify({ type: 'result', result: 'stub planner transcript' })}\n`);
}

async function appendFakeExecuteProgress(root: string): Promise<void> {
  await appendFile(
    runPaths(root).events,
    `${JSON.stringify({
      seq: 999,
      ts: '2026-06-14T20:52:54.999Z',
      type: 'EXECUTE_PROGRESS',
      level: 'info',
      message: 'Codex event turn.completed events=2 turns=1 items=1 tokens in=127 out=23',
      data: {
        progress: {
          usage: {
            completed_turns: 1,
            tokens_input: 127,
            tokens_output: 23
          }
        }
      }
    })}\n`
  );
}

async function forceCheckpointToolMode(root: string, mode: 'stub' | 'real', options: { wiciGitDirty?: boolean } = {}): Promise<void> {
  const checkpointPath = runPaths(root).checkpoint;
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as Record<string, unknown>;
  const existing = checkpoint.tool_versions && typeof checkpoint.tool_versions === 'object' ? (checkpoint.tool_versions as Record<string, unknown>) : {};
  const wici = existing.wici && typeof existing.wici === 'object' ? (existing.wici as Record<string, unknown>) : {};
  checkpoint.tool_versions = {
    ...existing,
    mode,
    codex: 'fixture-codex',
    claude: 'fixture-claude',
    checked_at: typeof existing.checked_at === 'string' ? existing.checked_at : '2026-06-14T20:52:54.999Z',
    wici: {
      package_version: typeof wici.package_version === 'string' ? wici.package_version : '0.1.3',
      git_commit: typeof wici.git_commit === 'string' ? wici.git_commit : null,
      git_dirty: options.wiciGitDirty ?? (typeof wici.git_dirty === 'boolean' ? wici.git_dirty : true)
    }
  };
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

async function setCheckpointGoalSource(root: string, goalSource: string): Promise<void> {
  const checkpointPath = runPaths(root).checkpoint;
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as Record<string, unknown>;
  checkpoint.goal_source = goalSource;
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

async function verifyTagGateRejectsPassedDirtyTarget(firstChat: string): Promise<void> {
  try {
    await createSampleTarget(passedDirtyTarget, true);
    const run = await runSupervisor({
      target: passedDirtyTarget,
      goal: firstChat,
      goalSource: 'tui_chat',
      maxIters: 1,
      mode: 'stub'
    });
    assert(run.state === 'STOP', `passed-dirty fixture run should stop cleanly: ${JSON.stringify(run)}`);
    await forceCheckpointToolMode(passedDirtyTarget, 'real', { wiciGitDirty: false });
    await writePlannerTranscript(passedDirtyTarget);
    await appendFakeExecuteProgress(passedDirtyTarget);
    await appendFakeSshTranscript(passedDirtyTarget);
    await recordCanaryEvidence({
      name: 'fixture-passed-dirty-target',
      target: passedDirtyTarget,
      status: 'passed',
      tagAllowed: true,
      firstChat,
      startedFromEmptyTui: true,
      operatorManualExecution: false,
      codexAttemptedSsh: true,
      targetValue: 700,
      observedValue: 701,
      unit: 'token/s',
      outDir: passedDirtyOutDir
    });
    await mutateEvidence(`${passedDirtyOutDir}/fixture-passed-dirty-target/evidence.json`, (evidence) => {
      const rollback = typeof evidence.rollback === 'object' && evidence.rollback ? evidence.rollback : {};
      evidence.rollback = {
        ...rollback,
        target_git_dirty: true
      };
    });
    const result = await execa(process.execPath, ['--import', 'tsx', 'src/verify/tag-gate.ts'], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        WICI_CANARY_DIR: passedDirtyOutDir
      },
      all: true,
      reject: false,
      timeout: 30_000
    });
    assert(result.exitCode !== 0, `tag gate should reject a passed canary with dirty target evidence:\n${result.all}`);
    const report = parseJsonReport(result.all ?? result.stdout);
    const artifact = report.artifact_evidence as { ok?: boolean; canary_target_git_dirty?: boolean; passed_observed_target?: boolean } | undefined;
    assert(artifact?.canary_target_git_dirty === true, `tag gate report should expose dirty target evidence:\n${result.all}`);
    assert(artifact?.passed_observed_target === true, `fixture should otherwise satisfy observed target evidence:\n${result.all}`);
    assert(artifact?.ok === false, `dirty target should make artifact evidence fail:\n${result.all}`);
    await writeFile(`${passedDirtyTarget}/uncommitted-target-change.txt`, 'dirty target state must block passed release canary\n');
    let recorderRejectedDirtyTarget = false;
    try {
      await recordCanaryEvidence({
        name: 'fixture-passed-dirty-target-rejected',
        target: passedDirtyTarget,
        status: 'passed',
        tagAllowed: true,
        firstChat,
        startedFromEmptyTui: true,
        operatorManualExecution: false,
        codexAttemptedSsh: true,
        targetValue: 700,
        observedValue: 701,
        unit: 'token/s',
        outDir: passedDirtyOutDir
      });
    } catch (error) {
      recorderRejectedDirtyTarget = String((error as Error).message).includes('clean target git checkout');
    }
    assert(recorderRejectedDirtyTarget, 'recorder should reject passed canary evidence from a dirty target checkout before writing');
  } finally {
    await rm(passedDirtyTarget, { recursive: true, force: true });
    await rm(passedDirtyOutDir, { recursive: true, force: true });
  }
}

async function verifyNonTuiPassedCanaryRejected(firstChat: string): Promise<void> {
  try {
    await createSampleTarget(nonTuiPassedTarget, true);
    const run = await runSupervisor({
      target: nonTuiPassedTarget,
      goal: firstChat,
      goalSource: 'api_goal',
      maxIters: 1,
      mode: 'stub'
    });
    assert(run.state === 'STOP', `non-tui fixture run should stop cleanly: ${JSON.stringify(run)}`);
    await forceCheckpointToolMode(nonTuiPassedTarget, 'real', { wiciGitDirty: false });
    await writePlannerTranscript(nonTuiPassedTarget);
    await appendFakeExecuteProgress(nonTuiPassedTarget);
    await appendFakeSshTranscript(nonTuiPassedTarget);
    let recorderRejectedNonTui = false;
    try {
      await recordCanaryEvidence({
        name: 'fixture-non-tui-passed',
        target: nonTuiPassedTarget,
        status: 'passed',
        tagAllowed: true,
        firstChat,
        startedFromEmptyTui: true,
        operatorManualExecution: false,
        codexAttemptedSsh: true,
        targetValue: 700,
        observedValue: 701,
        unit: 'token/s',
        outDir: nonTuiPassedOutDir
      });
    } catch (error) {
      recorderRejectedNonTui = String((error as Error).message).includes('checkpoint goal_source tui_chat');
    }
    assert(recorderRejectedNonTui, 'recorder should reject passed canary evidence not launched from TUI Chat intake');
    await setCheckpointGoalSource(nonTuiPassedTarget, 'tui_chat');
    await recordCanaryEvidence({
      name: 'fixture-non-tui-passed-mutated',
      target: nonTuiPassedTarget,
      status: 'passed',
      tagAllowed: true,
      firstChat,
      startedFromEmptyTui: true,
      operatorManualExecution: false,
      codexAttemptedSsh: true,
      targetValue: 700,
      observedValue: 701,
      unit: 'token/s',
      outDir: nonTuiPassedOutDir
    });
    await mutateEvidence(`${nonTuiPassedOutDir}/fixture-non-tui-passed-mutated/evidence.json`, (evidence) => {
      const runCheckpoint = typeof evidence.run_checkpoint === 'object' && evidence.run_checkpoint ? evidence.run_checkpoint : {};
      evidence.run_checkpoint = {
        ...runCheckpoint,
        goal_source: 'cli_goal'
      };
    });
    const result = await execa(process.execPath, ['--import', 'tsx', 'src/verify/tag-gate.ts'], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        WICI_CANARY_DIR: nonTuiPassedOutDir
      },
      all: true,
      reject: false,
      timeout: 30_000
    });
    assert(result.exitCode !== 0, `tag gate should reject a passed canary with non-TUI goal_source evidence:\n${result.all}`);
    const report = parseJsonReport(result.all ?? result.stdout);
    const artifact = report.artifact_evidence as { ok?: boolean; canary_goal_source?: string; passed_observed_target?: boolean } | undefined;
    assert(artifact?.canary_goal_source === 'cli_goal', `tag gate report should expose non-TUI goal source:\n${result.all}`);
    assert(artifact?.passed_observed_target === true, `fixture should otherwise satisfy observed target evidence:\n${result.all}`);
    assert(artifact?.ok === false, `non-TUI goal source should make artifact evidence fail:\n${result.all}`);
  } finally {
    await rm(nonTuiPassedTarget, { recursive: true, force: true });
    await rm(nonTuiPassedOutDir, { recursive: true, force: true });
  }
}

async function appendFakeOtherSshTranscript(root: string): Promise<void> {
  await appendFile(
    runPaths(root).codexRun,
    [
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: "/bin/zsh -lc \"ssh root@203.0.113.10 'echo OK'\"",
          aggregated_output: 'root@203.0.113.10: Permission denied (publickey).',
          exit_code: 255
        }
      }),
      ''
    ].join('\n')
  );
}

async function verifyCliRecorderRejectsInvalidPassedObservedValue(firstChat: string): Promise<void> {
  await expectRecorderFailure(
    [
      '--name',
      'fixture-canary-passed-missing-observed',
      '--target',
      target,
      '--status',
      'passed',
      '--tag-allowed',
      'true',
      '--first-chat',
      firstChat,
      '--started-from-empty-tui',
      'true',
      '--operator-manual-execution',
      'false',
      '--codex-attempted-ssh',
      'true',
      '--target-value',
      '700',
      '--unit',
      'token/s',
      '--out-dir',
      cliOutDir
    ],
    '--observed-value is required when --status passed and --target-value is provided'
  );
  await expectRecorderFailure(
    [
      '--name',
      'fixture-canary-passed-below-target',
      '--target',
      target,
      '--status',
      'passed',
      '--tag-allowed',
      'true',
      '--first-chat',
      firstChat,
      '--started-from-empty-tui',
      'true',
      '--operator-manual-execution',
      'false',
      '--codex-attempted-ssh',
      'true',
      '--target-value',
      '700',
      '--observed-value',
      '699',
      '--unit',
      'token/s',
      '--out-dir',
      cliOutDir
    ],
    '--observed-value must be greater than or equal to --target-value when --status passed'
  );
}

async function appendFakeSshTranscript(root: string): Promise<void> {
  await appendFile(
    runPaths(root).codexRun,
    [
      JSON.stringify({
        type: 'item.started',
        item: {
          type: 'command_execution',
          command: "/bin/zsh -lc \"ssh -p 23276 root@116.127.115.18 'echo OK'\""
        }
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: "/bin/zsh -lc \"ssh -p 23276 root@116.127.115.18 'echo OK'\"",
          aggregated_output: 'root@116.127.115.18: Permission denied (publickey).',
          exit_code: 255
        }
      }),
      ''
    ].join('\n')
  );
}

async function verifyRecorderRejectsUnsupportedSshAttestation(firstChat: string): Promise<void> {
  try {
    await createSampleTarget(noSshTarget, true);
    const run = await runSupervisor({
      target: noSshTarget,
      goal: firstChat,
      goalSource: 'tui_chat',
      maxIters: 1,
      mode: 'stub'
    });
    assert(run.state === 'STOP', `no-ssh fixture run should stop cleanly: ${JSON.stringify(run)}`);
    await writePlannerTranscript(noSshTarget);
    let failed = false;
    try {
      await recordCanaryEvidence({
        name: 'fixture-no-ssh-canary',
        target: noSshTarget,
        status: 'failed',
        tagAllowed: false,
        firstChat,
        startedFromEmptyTui: true,
        operatorManualExecution: false,
        codexAttemptedSsh: true,
        failureReason: 'Fixture run did not perform the real remote measurement.',
        nextRequiredAction: 'Run the real Chat-first canary before tagging.',
        targetValue: 700,
        unit: 'token/s',
        outDir: noSshOutDir
      });
    } catch (error) {
      failed = String((error as Error).message).includes('without SSH evidence');
    }
    assert(failed, 'recorder should reject codexAttemptedSsh=true when the Codex transcript has no SSH attempt');
  } finally {
    await rm(noSshTarget, { recursive: true, force: true });
    await rm(noSshOutDir, { recursive: true, force: true });
  }
}

async function verifyRecorderRejectsWrongSshTarget(firstChat: string): Promise<void> {
  try {
    await createSampleTarget(wrongSshTarget, true);
    const run = await runSupervisor({
      target: wrongSshTarget,
      goal: firstChat,
      goalSource: 'tui_chat',
      maxIters: 1,
      mode: 'stub'
    });
    assert(run.state === 'STOP', `wrong-ssh fixture run should stop cleanly: ${JSON.stringify(run)}`);
    await writePlannerTranscript(wrongSshTarget);
    await appendFakeOtherSshTranscript(wrongSshTarget);
    let failed = false;
    try {
      await recordCanaryEvidence({
        name: 'fixture-wrong-ssh-canary',
        target: wrongSshTarget,
        status: 'failed',
        tagAllowed: false,
        firstChat,
        startedFromEmptyTui: true,
        operatorManualExecution: false,
        codexAttemptedSsh: true,
        failureReason: 'Fixture run did not perform the real remote measurement.',
        nextRequiredAction: 'Run the real Chat-first canary before tagging.',
        targetValue: 700,
        unit: 'token/s',
        outDir: wrongSshOutDir
      });
    } catch (error) {
      failed = String((error as Error).message).includes('without SSH evidence');
    }
    assert(failed, 'recorder should reject codexAttemptedSsh=true when the transcript SSH target does not match the canary target');
  } finally {
    await rm(wrongSshTarget, { recursive: true, force: true });
    await rm(wrongSshOutDir, { recursive: true, force: true });
  }
}

async function verifyRecorderRejectsSourceSecrets(firstChat: string): Promise<void> {
  try {
    await createSampleTarget(secretTarget, true);
    const run = await runSupervisor({
      target: secretTarget,
      goal: firstChat,
      goalSource: 'tui_chat',
      maxIters: 1,
      mode: 'stub'
    });
    assert(run.state === 'STOP', `secret fixture run should stop cleanly: ${JSON.stringify(run)}`);
    await writePlannerTranscript(secretTarget);
    const fakeToken = ['sk', 'fake'.padEnd(40, 'A')].join('-');
    await appendFile(`${secretTarget}/GOAL.md`, `\nDo not record this fake token: ${fakeToken}\n`);
    let failed = false;
    try {
      await recordCanaryEvidence({
        name: 'fixture-secret-canary',
        target: secretTarget,
        status: 'failed',
        tagAllowed: false,
        firstChat,
        startedFromEmptyTui: true,
        operatorManualExecution: false,
        codexAttemptedSsh: true,
        failureReason: 'Fixture run did not perform the real remote measurement.',
        nextRequiredAction: 'Run the real Chat-first canary before tagging.',
        targetValue: 700,
        unit: 'token/s',
        outDir: secretOutDir
      });
    } catch (error) {
      failed = String((error as Error).message).includes('potential secret material');
    }
    assert(failed, 'recorder should reject source artifacts containing potential secret material before copying evidence');
  } finally {
    await rm(secretTarget, { recursive: true, force: true });
    await rm(secretOutDir, { recursive: true, force: true });
  }
}

async function verifyCliRecorderRejectsInvalidTargetMetadata(firstChat: string): Promise<void> {
  await expectRecorderFailure(
    [
      '--name',
      'fixture-canary-bad-target-value',
      '--target',
      target,
      '--status',
      'failed',
      '--tag-allowed',
      'false',
      '--first-chat',
      firstChat,
      '--started-from-empty-tui',
      'true',
      '--operator-manual-execution',
      'false',
      '--codex-attempted-ssh',
      'true',
      '--target-value',
      'not-a-number',
      '--unit',
      'token/s',
      '--failure-reason',
      'Fixture CLI recorder run did not perform the real remote measurement.',
      '--next-required-action',
      'Run the real Chat-first canary before tagging.',
      '--out-dir',
      cliOutDir
    ],
    '--target-value must be a finite number'
  );
  await expectRecorderFailure(
    [
      '--name',
      'fixture-canary-missing-unit',
      '--target',
      target,
      '--status',
      'failed',
      '--tag-allowed',
      'false',
      '--first-chat',
      firstChat,
      '--started-from-empty-tui',
      'true',
      '--operator-manual-execution',
      'false',
      '--codex-attempted-ssh',
      'true',
      '--target-value',
      '700',
      '--failure-reason',
      'Fixture CLI recorder run did not perform the real remote measurement.',
      '--next-required-action',
      'Run the real Chat-first canary before tagging.',
      '--out-dir',
      cliOutDir
    ],
    '--unit is required when --target-value is provided'
  );
  await expectRecorderFailure(
    [
      '--name',
      'fixture-canary-missing-target-value',
      '--target',
      target,
      '--status',
      'failed',
      '--tag-allowed',
      'false',
      '--first-chat',
      firstChat,
      '--started-from-empty-tui',
      'true',
      '--operator-manual-execution',
      'false',
      '--codex-attempted-ssh',
      'true',
      '--unit',
      'token/s',
      '--failure-reason',
      'Fixture CLI recorder run did not perform the real remote measurement.',
      '--next-required-action',
      'Run the real Chat-first canary before tagging.',
      '--out-dir',
      cliOutDir
    ],
    '--target-value is required when --unit is provided'
  );
}

async function verifyCliRecorderRejectsContradictoryStatus(firstChat: string): Promise<void> {
  await expectRecorderFailure(
    [
      '--name',
      'fixture-canary-failed-tag-allowed',
      '--target',
      target,
      '--status',
      'failed',
      '--tag-allowed',
      'true',
      '--first-chat',
      firstChat,
      '--started-from-empty-tui',
      'true',
      '--operator-manual-execution',
      'false',
      '--codex-attempted-ssh',
      'true',
      '--failure-reason',
      'Fixture CLI recorder run did not perform the real remote measurement.',
      '--next-required-action',
      'Run the real Chat-first canary before tagging.',
      '--out-dir',
      cliOutDir
    ],
    '--tag-allowed must be false when --status failed'
  );
  await expectRecorderFailure(
    [
      '--name',
      'fixture-canary-failed-missing-next',
      '--target',
      target,
      '--status',
      'failed',
      '--tag-allowed',
      'false',
      '--first-chat',
      firstChat,
      '--started-from-empty-tui',
      'true',
      '--operator-manual-execution',
      'false',
      '--codex-attempted-ssh',
      'true',
      '--failure-reason',
      'Fixture CLI recorder run did not perform the real remote measurement.',
      '--out-dir',
      cliOutDir
    ],
    '--next-required-action is required when --status failed'
  );
  await expectRecorderFailure(
    [
      '--name',
      'fixture-canary-passed-with-failure',
      '--target',
      target,
      '--status',
      'passed',
      '--tag-allowed',
      'true',
      '--first-chat',
      firstChat,
      '--started-from-empty-tui',
      'true',
      '--operator-manual-execution',
      'false',
      '--codex-attempted-ssh',
      'true',
      '--failure-reason',
      'Fixture should not mix passed status with a failure reason.',
      '--out-dir',
      cliOutDir
    ],
    '--failure-reason must be omitted when --status passed'
  );
}

async function verifyCliRecorder(firstChat: string): Promise<void> {
  const result = await execa(
    'npm',
    [
      'run',
      'release:record-canary',
      '--',
      '--name',
      'fixture-canary-cli',
      '--target',
      target,
      '--status',
      'failed',
      '--tag-allowed',
      'false',
      '--first-chat',
      firstChat,
      '--started-from-empty-tui',
      'true',
      '--operator-manual-execution',
      'false',
      '--codex-attempted-ssh',
      'true',
      '--target-value',
      '700',
      '--unit',
      'token/s',
      '--failure-reason',
      'Fixture CLI recorder run did not perform the real remote measurement.',
      '--next-required-action',
      'Run the real Chat-first canary before tagging.',
      '--out-dir',
      cliOutDir
    ],
    {
      cwd: resolve('.'),
      all: true,
      reject: false,
      timeout: 30_000
    }
  );
  assert(result.exitCode === 0, `release:record-canary CLI failed:\n${result.all}`);
  const evidencePath = `${cliOutDir}/fixture-canary-cli/evidence.json`;
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as {
    first_chat: string;
    started_from_empty_tui: boolean;
    operator_manual_execution: boolean;
    codex_attempted_ssh: boolean;
    events: { EXECUTE_PROGRESS?: { tokens_input?: number; tokens_output?: number } };
    generated_artifacts: Record<string, { sha256: string; bytes: number }>;
    rollback: { target_git_dirty: boolean };
  };
  assert(evidence.first_chat === firstChat, 'CLI recorder must preserve first Chat verbatim');
  assert(evidence.started_from_empty_tui === true, 'CLI recorder must preserve empty-TUI attestation');
  assert(evidence.operator_manual_execution === false, 'CLI recorder must preserve no-manual-execution attestation');
  assert(evidence.codex_attempted_ssh === true, 'CLI recorder must preserve Codex SSH attestation');
  assert(
    (evidence.events.EXECUTE_PROGRESS?.tokens_input ?? 0) > 0 && (evidence.events.EXECUTE_PROGRESS?.tokens_output ?? 0) > 0,
    'CLI recorder must preserve executor token usage'
  );
  assert(evidence.rollback.target_git_dirty === false, 'CLI recorder must preserve target git cleanliness');
  const codex = await readFile(`${cliOutDir}/fixture-canary-cli/artifacts/.wici/codex-run.jsonl`);
  const expected = evidence.generated_artifacts['.wici/codex-run.jsonl'];
  assert(expected !== undefined, 'CLI recorder evidence missing codex transcript digest');
  assert(createHash('sha256').update(codex).digest('hex') === expected.sha256, 'CLI recorder codex transcript sha256 mismatch');
  assert(codex.byteLength === expected.bytes, 'CLI recorder codex transcript byte length mismatch');
}

async function verifyCliRecorderRejectsMissingAttestation(firstChat: string): Promise<void> {
  await expectRecorderFailure(
    [
      '--name',
      'fixture-canary-missing-attestation',
      '--target',
      target,
      '--status',
      'failed',
      '--tag-allowed',
      'false',
      '--first-chat',
      firstChat,
      '--operator-manual-execution',
      'false',
      '--codex-attempted-ssh',
      'true',
      '--failure-reason',
      'Fixture CLI recorder run did not perform the real remote measurement.',
      '--next-required-action',
      'Run the real Chat-first canary before tagging.',
      '--out-dir',
      cliOutDir
    ],
    '--started-from-empty-tui must be true or false'
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectRecorderFailure(args: string[], expectedMessage: string): Promise<void> {
  const result = await execa('npm', ['run', 'release:record-canary', '--', ...args], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(result.exitCode !== 0, `release:record-canary CLI should fail for invalid evidence args:\n${result.all}`);
  assert(result.all?.includes(expectedMessage), `recorder failure should include ${expectedMessage}:\n${result.all}`);
}

function parseJsonReport(output: string): Record<string, unknown> {
  const start = output.indexOf('{');
  assert(start >= 0, `expected JSON report in output:\n${output}`);
  return JSON.parse(output.slice(start)) as Record<string, unknown>;
}

async function mutateEvidence(path: string, update: (evidence: Record<string, unknown>) => void): Promise<void> {
  const evidence = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  update(evidence);
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function assertExecutable(path: string): Promise<void> {
  const mode = (await stat(path)).mode;
  assert((mode & 0o111) !== 0, `${path} should remain executable in copied canary artifacts`);
}

await main();
