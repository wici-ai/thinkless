import { chmod } from 'node:fs/promises';
import { atomicWriteJson, acquireLock, exists, lineCount, readJsonFileMaybe, truncateJsonLines } from '../shared/atomic.js';
import { loadConfig } from '../shared/config.js';
import { ensureRunDirs, ensureTargetGitignore, runPaths } from '../shared/paths.js';
import type { BaselineFile, CheckpointSnapshot, GoalFile, RunOptions, WiCiConfig } from '../shared/types.js';
import { hashFile, loadCheckpoint, loadIterationSnapshot, restoreSnapshotRunFiles, saveCheckpoint, saveIterationSnapshot } from './checkpoint.js';
import { EventWriter } from './events.js';
import { applyInjections, drainInbox, injectionIds } from './inbox.js';
import { runExecutorStep } from './executor.js';
import { lockEvalScripts, runInitialPlanner, runPlanDiff, unlockEvalScripts, verifyEvalHashes } from './planner.js';
import { nextExecutableStep, readPlan, setPlanStepStatus } from './plan.js';
import { appendLedger, lastAccepted, readLedger } from './ledger.js';
import {
  evaluateCandidate,
  initializeBaseline,
  ledgerFromEvaluation,
  loadBaseline,
  updateBaselineAfterKeep
} from './evaluate.js';
import { commitAll, commitAllWithKey, currentCommit, ensureGitIdentity, ensureGitRepo, hasChanges, tagBest, tagPerf, revertToBest, resetToCommit } from './gitgate.js';
import { shouldStop } from './stop.js';
import {
  assertNoActiveToolVersionDrift,
  assertNoPendingToolUpdatesForLongRun,
  assertRealToolsReady,
  checkToolHealth,
  toolVersionsFromHealth
} from './selfupdate.js';
import { consecutiveGlobalFailures, shouldReplanStuckStep } from './stuck.js';
import { markOutboxAnswered, readOutbox, writeOutbox } from './outbox.js';
import { appendLessonFromLedger, formatLessonsForPrompt, readRecentLessons } from './lessons.js';
import { recordAvenueOutcome, selectAvenue } from './diversity.js';
import { runScorerSelftest } from './scorerSelftest.js';
import { combinePromptMemory, readContextForPrompt, writeContextSummary } from './context.js';
import { maybeInterrogateGoal } from './goalInterrogation.js';
import { ensureBenchmarkManifest, readBenchmarkForPrompt } from './benchmark.js';
import {
  ACCEPTANCE_CLARIFY_REPLY_KEY,
  ensureAcceptanceSpec,
  formatAcceptanceSpecForPrompt,
  verifyAcceptanceSpec
} from './acceptance.js';
import { commitLimitArtifact } from './finalArtifact.js';
import { recordAcceptedArchiveEntry, restoreLedgerFile, selectArchiveParent } from './archive.js';
import { formatSkillsForPrompt, recordSkillFromKeep, retrieveSkills } from './skills.js';
import { appendCurriculumSubgoal } from './curriculum.js';
import { codexUsageFromError } from './codexRun.js';

const EVAL_LOCK_REPLY_KEY = 'lock-eval';
const EVAL_LOCK_WAIT_REASON = 'awaiting eval lock approval';
const ACCEPTANCE_SPEC_WAIT_REASON = 'awaiting acceptance criteria clarification';

export interface SupervisorResult {
  state: 'STOP' | 'FAILED' | 'RUNNING';
  reason: string;
  iter: number;
}

export async function runSupervisor(options: RunOptions): Promise<SupervisorResult> {
  const config = await loadConfig(options.mode);
  if (options.lockMode) config.evaluation.lock_mode = options.lockMode;
  const paths = runPaths(options.target);
  await ensureRunDirs(paths);
  const releaseLock = await acquireLock(paths.lock);
  const events = new EventWriter(paths.events);

  try {
    await ensureGitRepo(paths, config);
    await ensureGitIdentity(paths, config);
    await ensureTargetGitignore(paths);

    let goal = await ensureGoal(paths.goal, options.goal, config);
    const maxIters = options.maxIters ?? goal.budget.max_iters ?? config.budget.max_iters;
    let checkpoint = await loadCheckpoint(paths, goal);
    let loadedSnapshot: CheckpointSnapshot | null = null;
    if (options.resumeIteration !== undefined) {
      loadedSnapshot = await loadIterationSnapshot(paths, options.resumeIteration);
      await resetToCommit(paths, loadedSnapshot.head_commit);
      await restoreSnapshotRunFiles(paths, loadedSnapshot);
      goal = loadedSnapshot.goal;
      checkpoint = loadedSnapshot.checkpoint;
      await truncateJsonLines(paths.events, checkpoint.events_seq);
      await truncateJsonLines(paths.ledger, checkpoint.ledger_seq);
      checkpoint.iter = checkpoint.ledger_seq;
    } else if (checkpoint.supervisor_state !== 'STOP' && checkpoint.supervisor_state !== 'FAILED') {
      await truncateJsonLines(paths.events, checkpoint.events_seq);
      await truncateJsonLines(paths.ledger, checkpoint.ledger_seq);
      checkpoint.iter = checkpoint.ledger_seq;
    }
    await events.init();
    if (loadedSnapshot) {
      await events.emit('RESUME_ITERATION_LOADED', `Loaded WiCi checkpoint snapshot for iteration ${loadedSnapshot.iter}`, {
        iteration: loadedSnapshot.iter,
        head_commit: loadedSnapshot.head_commit,
        best_commit: loadedSnapshot.best_commit,
        ledger_seq: checkpoint.ledger_seq,
        events_seq: checkpoint.events_seq
      });
      checkpoint = {
        ...checkpoint,
        events_seq: events.seq,
        ledger_seq: await lineCount(paths.ledger),
        iter: await lineCount(paths.ledger)
      };
    }
    await saveCheckpoint(paths, checkpoint);

    const toolHealth = config.tools.mode === 'stub' ? null : await checkToolHealth(config, { probeClaude: config.tools.mode === 'real' });
    if (toolHealth) assertRealToolsReady(config, toolHealth);
    assertNoPendingToolUpdatesForLongRun(config, toolHealth, maxIters);
    const currentToolVersions = toolVersionsFromHealth(config, toolHealth);
    assertNoActiveToolVersionDrift(checkpoint, currentToolVersions);
    checkpoint.tool_versions = currentToolVersions;
    await saveCheckpoint(paths, checkpoint);
    await events.emit('SUPERVISOR_START', `Starting WiCi supervisor in ${paths.target}`, {
      mode: config.tools.mode,
      lock_mode: config.evaluation.lock_mode,
      safety: config.safety.container_hint,
      tools: toolHealth
    });

    if (config.evaluation.lock_mode === 'manual' && !(await exists(paths.baseline))) {
      ({ goal, checkpoint } = await drainEvalLockAnswers(paths, goal, checkpoint, events));
    }

    const setup = await ensurePlanAndBaseline(paths, goal, config, events);
    let baseline = setup.baseline;
    if (!baseline) {
      checkpoint = {
        ...checkpoint,
        supervisor_state: 'STOP',
        goal_version: goal.version,
        plan_hash: await hashFile(paths.plan),
        ledger_seq: await lineCount(paths.ledger),
        events_seq: events.seq
      };
      await saveCheckpoint(paths, checkpoint);
      await events.emit('STOP', setup.waitReason);
      return { state: 'STOP', reason: setup.waitReason, iter: checkpoint.iter };
    }
    checkpoint = await recoverIncompleteAttempt(paths, checkpoint, baseline, events);
    await runStartupScorerSelftest(paths, goal, baseline, config, events);
    checkpoint = {
      ...checkpoint,
      supervisor_state: 'EXECUTE',
      goal_version: goal.version,
      plan_hash: await hashFile(paths.plan),
      ledger_seq: await lineCount(paths.ledger),
      events_seq: events.seq
    };
    await saveCheckpoint(paths, checkpoint);
    await saveStableIterationSnapshot(paths, goal, checkpoint, baseline);

    let steerText: string | undefined;

    while (checkpoint.iter < maxIters) {
      const backstop = await hardBackstop(paths, goal);
      if (backstop) {
        const artifact = await commitLimitArtifact(paths, goal, baseline, await readLedger(paths), backstop);
        await events.emit('LIMIT_ARTIFACT_COMMIT', artifact.reused ? `Reused limit artifact commit ${artifact.commit.slice(0, 7)}` : `Committed limit artifact ${artifact.commit.slice(0, 7)}`, artifact);
        checkpoint = {
          ...checkpoint,
          supervisor_state: 'FAILED',
          ledger_seq: await lineCount(paths.ledger),
          events_seq: events.seq
        };
        await saveCheckpoint(paths, checkpoint);
        await writeOutbox(paths, { kind: 'error', text: backstop, data: { limit_artifact: artifact } });
        await events.emit('FAILED', backstop, undefined, 'warn');
        return { state: 'FAILED', reason: backstop, iter: checkpoint.iter };
      }

      const iterationStarted = Date.now();
      const nextIter = checkpoint.iter + 1;
      const ledgerBeforeIteration = await readLedger(paths);
      const acceptanceSpec = await verifyAcceptanceSpec(paths, goal);
      const acceptanceText = formatAcceptanceSpecForPrompt(acceptanceSpec);
      const benchmarkText = await readBenchmarkForPrompt(paths);
      const skillText = formatSkillsForPrompt(await retrieveSkills(paths, skillQuery(goal, ledgerBeforeIteration)));
      const lessonsText = formatLessonsForPrompt(await readRecentLessons(paths));
      const contextText = await readContextForPrompt(paths);
      const memoryText = combinePromptMemory(acceptanceText, benchmarkText, skillText, contextText, lessonsText);
      const parentId = checkpoint.active_avenue?.parent_id ?? lastAccepted(ledgerBeforeIteration)?.id ?? null;
      const activeAvenue = checkpoint.active_avenue?.name;

      const injections = await drainInbox(paths, checkpoint.drained_inbox);
      if (injections.length > 0) {
        const applied = applyInjections(goal, injections);
        goal = applied.goal;
        steerText = applied.steerText;
        const drainedIds = injectionIds(injections);
        checkpoint.drained_inbox = [...checkpoint.drained_inbox, ...drainedIds];
        checkpoint.goal_version = goal.version;
        for (const answer of injections.filter((item) => item.kind === 'answer' && item.reply_to)) {
          const marked = await markOutboxAnswered(paths, answer.reply_to!, answer.text);
          await events.emit('OUTBOX_ANSWERED', `Applied answer for ${answer.reply_to}`, {
            reply_to: answer.reply_to,
            outbox_id: marked?.id ?? null
          });
        }
        await atomicWriteJson(paths.goal, goal);
        await events.emit(
          'INJECTION_DRAINED',
          `Applied ${drainedIds.length} chat injection(s)`,
          injections.map((item) => ({ id: item.id, ids: item.coalesced_ids ?? [item.id], kind: item.kind }))
        );
        if (applied.aborted) {
          checkpoint.supervisor_state = 'STOP';
          await saveCheckpoint(paths, checkpoint);
          await writeOutbox(paths, { kind: 'info', text: 'Urgent abort injection requested stop' });
          await events.emit('STOP', 'Urgent abort injection requested stop', undefined, 'warn');
          return { state: 'STOP', reason: 'urgent abort injection', iter: checkpoint.iter };
        }
        checkpoint.supervisor_state = 'PLAN';
        await saveCheckpoint(paths, checkpoint);
        const diff = await runPlanDiff(paths, goal, checkpoint.sessions.planner, withLessons(steerText ?? '', memoryText), config);
        checkpoint.sessions.planner = diff.sessionId ?? checkpoint.sessions.planner;
        checkpoint.plan_hash = await hashFile(paths.plan);
        if (await hasChanges(paths)) {
          const commit = await commitAll(paths, `chore: apply WiCi goal v${goal.version} plan update`);
          baseline = {
            ...baseline,
            best_commit: commit,
            plan_hash: checkpoint.plan_hash ?? baseline.plan_hash,
            updated_at: new Date().toISOString()
          };
          await atomicWriteJson(paths.baseline, baseline);
          if (await hasChanges(paths)) {
            await commitAll(paths, `chore: record WiCi goal v${goal.version} baseline anchor`);
          }
          await tagBest(paths);
        }
        await saveCheckpoint(paths, checkpoint);
        await events.emit('PLAN_DIFF_APPLIED', 'Planner applied a minimal plan diff for new input', { steerText });
      }

      const plan = await readPlan(paths);
      const step = nextExecutableStep(plan);
      if (!step) {
        const ledger = await readLedger(paths);
        const decision = await shouldStop(paths, goal, ledger, config);
        checkpoint.supervisor_state = decision.stop ? 'STOP' : 'FAILED';
        await saveCheckpoint(paths, checkpoint);
        await writeOutbox(paths, {
          kind: decision.stop ? (goal.stop.mode === 'ask' ? 'question' : 'stop_verdict') : 'error',
          text: decision.stop && goal.stop.mode === 'ask' ? `Stop candidate: ${decision.reason}. Type a new requirement or /steer continue to resume.` : decision.reason,
          replyKey: decision.stop && goal.stop.mode === 'ask' ? `stop-${goal.version}-${checkpoint.iter}` : undefined,
          data: { no_executable_step: true, stop_mode: goal.stop.mode, stop_analysis: decision.analysis, verdict: decision.verdict }
        });
        await events.emit(checkpoint.supervisor_state, decision.reason, undefined, decision.stop ? 'info' : 'warn');
        return {
          state: checkpoint.supervisor_state,
          reason: decision.reason,
          iter: checkpoint.iter
        };
      }

      checkpoint = {
        ...checkpoint,
        supervisor_state: 'EXECUTE',
        iter: nextIter,
        next_step: step.id,
        goal_version: goal.version,
        plan_hash: await hashFile(paths.plan),
        ledger_seq: await lineCount(paths.ledger),
        events_seq: events.seq
      };
      await setPlanStepStatus(paths, step.id, 'active', nextIter);
      await saveCheckpoint(paths, checkpoint);
      await events.emit('EXECUTE_START', `Iteration ${nextIter}: executing ${step.id}`, { step });

      let iterResult;
      try {
        iterResult = await runExecutorStep(paths, goal, step.id, nextIter, config, steerText, memoryText);
        checkpoint.sessions.executor = iterResult.invocation.sessionId ?? checkpoint.sessions.executor;
        await events.emit('EXECUTE_DONE', iterResult.notes, {
          step_done: iterResult.step_done,
          tests_pass: iterResult.tests_pass,
          changed_files: iterResult.changed_files,
          usage: iterResult.invocation.usage
        });
      } catch (error) {
        const usage = codexUsageFromError(error);
        await events.emit('EXECUTE_FAILED', error instanceof Error ? error.message : String(error), usage ? { usage } : undefined, 'error');
        await revertToBest(paths, baseline.best_commit);
        await setPlanStepStatus(paths, step.id, 'pending');
        const ledgerEntry = ledgerFromEvaluation({
          iter: nextIter,
          stepId: step.id,
          status: 'crash',
          hypothesis: step.text,
          commit: null,
          baseline: baseline.best_metric,
          evaluation: null,
          wallMs: Date.now() - iterationStarted,
          usage,
          reflection: 'executor crashed; reverted to best known commit',
          parentId,
          avenue: activeAvenue
        });
        await appendLedger(paths, ledgerEntry);
        await appendLessonFromLedger(paths, ledgerEntry);
        await refreshContextSummary(paths, goal, events);
        checkpoint = await recordActiveAvenueOutcome(paths, config, checkpoint, ledgerEntry, events);
        if (await hasChanges(paths)) {
          await commitAll(paths, `chore: record failed WiCi iteration ${nextIter}`);
          await tagBest(paths);
        }
        await saveCheckpoint(paths, checkpoint);
        if (options.once) break;
        continue;
      }

      checkpoint.supervisor_state = 'EVALUATE';
      await saveCheckpoint(paths, checkpoint);
      await events.emit('EVALUATE_START', `Running locked checks and measure for ${step.id}`);

      const evaluation = await evaluateCandidate(paths, goal, baseline, config);
      if (!evaluation.checks.ok) {
        await events.emit('CHECKS_FAILED', evaluation.reason, { output: evaluation.checks.output.slice(-4000) }, 'warn');
        await revertToBest(paths, baseline.best_commit);
        await setPlanStepStatus(paths, step.id, 'pending');
        const ledgerEntry = ledgerFromEvaluation({
          iter: nextIter,
          stepId: step.id,
          status: 'checks_failed',
          hypothesis: step.text,
          commit: null,
          baseline: baseline.best_metric,
          evaluation,
          wallMs: Date.now() - iterationStarted,
          usage: iterResult.invocation.usage,
          reflection: 'correctness gate failed; reverted',
          parentId,
          avenue: activeAvenue
        });
        await appendLedger(paths, ledgerEntry);
        await appendLessonFromLedger(paths, ledgerEntry);
        checkpoint = await recordActiveAvenueOutcome(paths, config, checkpoint, ledgerEntry, events);
        if (await hasChanges(paths)) {
          await commitAll(paths, `chore: record rejected WiCi iteration ${nextIter}`);
          await tagBest(paths);
        }
      } else if (evaluation.improved && evaluation.metric) {
        checkpoint.supervisor_state = 'COMMIT';
        await saveCheckpoint(paths, checkpoint);
        const previousMetric = baseline.best_metric;
        await setPlanStepStatus(paths, step.id, iterResult.step_done ? 'done' : 'pending', nextIter);
        const planHash = (await hashFile(paths.plan)) ?? '';
        const shortDelta = evaluation.deltaPct === null ? 'n/a' : `${(evaluation.deltaPct * 100).toFixed(1)}%`;
        const message = `perf: ${step.text} | p99 ${previousMetric.p99}->${evaluation.metric.p99}${evaluation.metric.unit} (${shortDelta}) | guards ok`;
        const commitKey = `run:${goal.run_id}:iter:${nextIter}:step:${step.id}`;
        const committed = await commitAllWithKey(paths, message, commitKey);
        const commit = committed.commit;
        await events.emit('GIT_COMMIT', committed.reused ? `Reused idempotent perf commit ${commit.slice(0, 7)}` : `Created perf commit ${commit.slice(0, 7)}`, {
          commit,
          key: commitKey,
          reused: committed.reused
        });
        baseline = updateBaselineAfterKeep(baseline, commit, evaluation.metric, planHash, evaluation.heldoutMetric);
        await atomicWriteJson(paths.baseline, baseline);
        const ledgerEntry = ledgerFromEvaluation({
          iter: nextIter,
          stepId: step.id,
          status: 'keep',
          hypothesis: step.text,
          commit,
          baseline: previousMetric,
          evaluation,
          wallMs: Date.now() - iterationStarted,
          usage: iterResult.invocation.usage,
          reflection: evaluation.reason,
          parentId,
          avenue: activeAvenue
        });
        await appendLedger(paths, ledgerEntry);
        await appendLessonFromLedger(paths, ledgerEntry);
        checkpoint = await recordActiveAvenueOutcome(paths, config, checkpoint, ledgerEntry, events);
        if (await hasChanges(paths)) {
          await commitAll(paths, `chore: record WiCi baseline and ledger for ${commit.slice(0, 7)}`);
        }
        await tagPerf(paths, `perf/p99-${Math.round(evaluation.metric.p99)}${evaluation.metric.unit}-${commit.slice(0, 7)}`);
        await tagBest(paths);
        const archiveState = await recordAcceptedArchiveEntry(paths, ledgerEntry, await currentCommit(paths), commit);
        await events.emit('ARCHIVE_RECORD', `Archived accepted stepping stone ${ledgerEntry.id}`, {
          ledger_id: ledgerEntry.id,
          commit: await currentCommit(paths),
          perf_commit: commit,
          archive_size: archiveState.entries.length
        });
        const skill = await recordSkillFromKeep(paths, goal, ledgerEntry, commit);
        if (skill) {
          await events.emit('SKILL_RECORDED', `Stored executable skill ${skill.id}`, {
            id: skill.id,
            source_ledger_id: skill.source_ledger_id,
            patch_path: skill.patch_path,
            patch_sha256: skill.patch_sha256
          });
        }
        await events.emit('COMMIT', `Accepted improvement and committed ${commit.slice(0, 7)}`, {
          p99: evaluation.metric.p99,
          heldout_p99: evaluation.heldoutMetric?.p99,
          delta_pct: evaluation.deltaPct,
          heldout_delta_pct: evaluation.heldoutDeltaPct,
          confidence: evaluation.confidence
        });
      } else {
        checkpoint.supervisor_state = 'REVERT';
        await saveCheckpoint(paths, checkpoint);
        await events.emit('REVERT', evaluation.reason, {
          delta_pct: evaluation.deltaPct,
          prescreen_p99: evaluation.prescreenMetric?.p99,
          prescreen_delta_pct: evaluation.prescreenDeltaPct,
          heldout_p99: evaluation.heldoutMetric?.p99,
          heldout_delta_pct: evaluation.heldoutDeltaPct,
          confidence: evaluation.confidence
        }, 'warn');
        await revertToBest(paths, baseline.best_commit);
        await setPlanStepStatus(paths, step.id, 'pending');
        const ledgerEntry = ledgerFromEvaluation({
          iter: nextIter,
          stepId: step.id,
          status: 'reject',
          hypothesis: step.text,
          commit: null,
          baseline: baseline.best_metric,
          evaluation,
          wallMs: Date.now() - iterationStarted,
          usage: iterResult.invocation.usage,
          reflection: evaluation.reason,
          parentId,
          avenue: activeAvenue
        });
        await appendLedger(paths, ledgerEntry);
        await appendLessonFromLedger(paths, ledgerEntry);
        checkpoint = await recordActiveAvenueOutcome(paths, config, checkpoint, ledgerEntry, events);
        if (await hasChanges(paths)) {
          await commitAll(paths, `chore: record rejected WiCi iteration ${nextIter}`);
          await tagBest(paths);
        }
      }

      checkpoint = {
        ...checkpoint,
        supervisor_state: 'REFLECT',
        next_step: step.id,
        ledger_seq: await lineCount(paths.ledger),
        events_seq: events.seq,
        plan_hash: await hashFile(paths.plan)
      };
      await saveCheckpoint(paths, checkpoint);

      const ledger = await readLedger(paths);
      const goalCheck = await maybeInterrogateGoal(paths, goal, ledger);
      if (goalCheck) {
        await events.emit('GOAL_INTERROGATION', `Checked iteration ${goalCheck.iter} behavior against goal.json`, {
          id: goalCheck.id,
          iter: goalCheck.iter,
          goal_version: goalCheck.goal_version,
          aligned: goalCheck.aligned,
          concerns: goalCheck.concerns
        }, goalCheck.aligned ? 'info' : 'warn');
      }
      if (await writeContextSummary(paths, goal, ledger)) {
        await events.emit('CONTEXT_SUMMARY_WRITTEN', 'Updated condensed run context with pinned goal and public ledger summary', {
          path: '.wici/context.md',
          ledger_rows: ledger.length
        });
      }
      checkpoint = {
        ...checkpoint,
        ledger_seq: await lineCount(paths.ledger),
        events_seq: events.seq
      };
      await saveCheckpoint(paths, checkpoint);
      await saveStableIterationSnapshot(paths, goal, checkpoint, baseline);
      const globalFailures = consecutiveGlobalFailures(ledger);
      if (globalFailures >= config.retry.reverts_before_reset) {
        await revertToBest(paths, baseline.best_commit);
        await events.emit('ANTITHRASH_RESET', `Forced reset to best after ${globalFailures} consecutive failed iteration(s)`, {
          best_commit: baseline.best_commit
        }, 'warn');
      }

      const stuck = shouldReplanStuckStep(ledger, step.id, config.retry);
      if (stuck.stuck) {
        checkpoint.supervisor_state = 'PLAN';
        const archiveParent = await selectArchiveParent(paths, baseline.best_commit);
        const branchParentId = archiveParent?.entry.ledger_id ?? lastAccepted(ledger)?.id ?? parentId;
        if (archiveParent) {
          await resetToCommit(paths, archiveParent.entry.commit);
          await atomicWriteJson(paths.baseline, baseline);
          await restoreLedgerFile(paths, ledger);
          await events.emit('ARCHIVE_BRANCH_CHECKOUT', `Branched from archived ${archiveParent.entry.ledger_id}`, {
            ledger_id: archiveParent.entry.ledger_id,
            commit: archiveParent.entry.commit,
            perf_commit: archiveParent.entry.perf_commit,
            archive_size: archiveParent.archiveSize,
            non_best: archiveParent.nonBest,
            best_commit: baseline.best_commit
          }, archiveParent.nonBest ? 'warn' : 'info');
        }
        await setPlanStepStatus(paths, step.id, 'blocked', checkpoint.iter);
        const avenue = await selectAvenue(paths, config, branchParentId);
        checkpoint.active_avenue = {
          name: avenue.name,
          parent_id: branchParentId,
          selected_at: new Date().toISOString()
        };
        const curriculum = await appendCurriculumSubgoal(paths, goal, {
          iter: checkpoint.iter,
          stepId: step.id,
          avenue: avenue.name,
          stuckReason: stuck.reason,
          attempts: stuck.attempts,
          consecutiveFailures: stuck.consecutiveFailures,
          parentId: branchParentId
        });
        await events.emit('CURRICULUM_SUBGOAL', `Generated curriculum sub-goal for ${step.id}`, {
          id: curriculum.id,
          step_id: step.id,
          avenue: avenue.name,
          parent_id: branchParentId,
          sub_goal: curriculum.sub_goal
        });
        await refreshContextSummary(paths, goal, events);
        const replanText = withLessons(
          `${stuck.reason}. Avenue: ${avenue.name}. Curriculum sub-goal: ${curriculum.sub_goal} Try this different optimization avenue; preserve completed steps and do not rewrite locked eval scripts.`,
          memoryText
        );
        const diff = await runPlanDiff(paths, goal, checkpoint.sessions.planner, replanText, config);
        checkpoint.sessions.planner = diff.sessionId ?? checkpoint.sessions.planner;
        checkpoint.plan_hash = await hashFile(paths.plan);
        if (await hasChanges(paths)) {
          const commit = await commitAll(paths, `chore: replan after stalled ${step.id}`);
          if (!archiveParent || !archiveParent.nonBest) {
            baseline = {
              ...baseline,
              best_commit: commit,
              plan_hash: checkpoint.plan_hash ?? baseline.plan_hash,
              updated_at: new Date().toISOString()
            };
            await atomicWriteJson(paths.baseline, baseline);
            if (await hasChanges(paths)) {
              await commitAll(paths, `chore: record stalled ${step.id} baseline anchor`);
            }
            await tagBest(paths);
          }
        }
        checkpoint = {
          ...checkpoint,
          supervisor_state: 'EXECUTE',
          next_step: null,
          ledger_seq: await lineCount(paths.ledger),
          events_seq: events.seq,
          plan_hash: await hashFile(paths.plan)
        };
        await saveCheckpoint(paths, checkpoint);
        await saveStableIterationSnapshot(paths, goal, checkpoint, baseline);
        await events.emit('REPLAN_STUCK', stuck.reason, {
          step_id: step.id,
          attempts: stuck.attempts,
          consecutive_failures: stuck.consecutiveFailures,
          avenue: avenue.name,
          parent_id: branchParentId,
          sample: avenue.sample
        }, 'warn');
        steerText = undefined;
        continue;
      }

      const stop = await shouldStop(paths, goal, ledger, config);
      await events.emit('STOP_CHECK', stop.reason, { candidate: stop.candidate, stop: stop.stop, stop_analysis: stop.analysis, verdict: stop.verdict });
      if (stop.stop) {
        checkpoint.supervisor_state = 'STOP';
        await saveCheckpoint(paths, checkpoint);
        await writeOutbox(paths, {
          kind: goal.stop.mode === 'ask' ? 'question' : 'stop_verdict',
          text: goal.stop.mode === 'ask' ? `Stop candidate: ${stop.reason}. Type a new requirement or /steer continue to resume.` : stop.reason,
          replyKey: goal.stop.mode === 'ask' ? `stop-${goal.version}-${checkpoint.iter}` : undefined,
          data: { candidate: stop.candidate, stop_mode: goal.stop.mode, stop_analysis: stop.analysis, verdict: stop.verdict }
        });
        await events.emit('STOP', stop.reason);
        return { state: 'STOP', reason: stop.reason, iter: checkpoint.iter };
      }

      steerText = undefined;
      if (options.once) break;
    }

    const limitReason = `Reached max_iters=${maxIters}`;
    const artifact = await commitLimitArtifact(paths, goal, baseline, await readLedger(paths), limitReason);
    await events.emit('LIMIT_ARTIFACT_COMMIT', artifact.reused ? `Reused limit artifact commit ${artifact.commit.slice(0, 7)}` : `Committed limit artifact ${artifact.commit.slice(0, 7)}`, artifact);
    checkpoint = {
      ...checkpoint,
      supervisor_state: 'STOP',
      ledger_seq: await lineCount(paths.ledger),
      events_seq: events.seq
    };
    await saveCheckpoint(paths, checkpoint);
    await writeOutbox(paths, { kind: 'info', text: limitReason, data: { limit_artifact: artifact } });
    await events.emit('STOP', limitReason);
    return { state: 'STOP', reason: limitReason, iter: checkpoint.iter };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await writeOutbox(paths, { kind: 'error', text: reason }).catch(() => undefined);
    await events.emit('FAILED', reason, undefined, 'error');
    return { state: 'FAILED', reason, iter: 0 };
  } finally {
    await releaseLock();
  }
}

async function ensureGoal(path: string, text: string | undefined, config: WiCiConfig): Promise<GoalFile> {
  const existing = await readJsonFileMaybe<GoalFile>(path);
  if (existing) return existing;
  const goal: GoalFile = {
    run_id: `run-${Date.now()}`,
    version: 1,
    requirements: [
      {
        id: 'R1',
        text: text ?? 'Reduce p99 latency while preserving correctness.',
        source: 'initial',
        status: 'active'
      }
    ],
    acceptance_criteria: [
      {
        id: 'A1',
        text: 'Locked checks pass before any performance result is accepted.',
        check: './.opt/checks.sh'
      },
      {
        id: 'A2',
        text: 'A candidate is committed only when p99 improves beyond the configured gate.',
        check: './.opt/measure.sh'
      }
    ],
    constraints: ['Do not edit .opt/checks.sh or .opt/measure.sh after lock.', 'Commit confirmed improvements and revert regressions.'],
    metric: {
      name: 'p99 latency',
      direction: 'minimize',
      target: null,
      unit: 'ms'
    },
    budget: config.budget,
    stop: config.stop
  };
  await atomicWriteJson(path, goal);
  return goal;
}

async function ensurePlanAndBaseline(
  paths: ReturnType<typeof runPaths>,
  goal: GoalFile,
  config: WiCiConfig,
  events: EventWriter
): Promise<{ baseline: BaselineFile | null; waitReason: string }> {
  let createdSetup = false;
  const acceptance = await ensureAcceptanceSpec(paths, goal);
  if (!acceptance.ok) {
    await ensureAcceptanceSpecQuestion(paths, events, acceptance.reason ?? 'Acceptance criteria need clarification.');
    return { baseline: null, waitReason: ACCEPTANCE_SPEC_WAIT_REASON };
  }
  if (acceptance.created) {
    createdSetup = true;
    await events.emit('ACCEPTANCE_SPEC_FROZEN', 'Frozen machine-checkable acceptance criteria in acceptance.spec.json', {
      criteria: acceptance.spec?.criteria.map((criterion) => ({ id: criterion.id, check: criterion.check })) ?? []
    });
  }

  const hasPlan = (await exists(paths.plan)) && (await exists(paths.measure)) && (await exists(paths.checks));
  if (!hasPlan) {
    await unlockEvalScripts(paths);
    await events.emit('PLAN_START', 'Planner is materializing PLAN.md and locked eval scripts');
    const result = await runInitialPlanner(paths, goal, config);
    await events.emit('PLAN_DONE', result.stdout ?? 'planner completed', { sessionId: result.sessionId });
    const benchmark = await ensureBenchmarkManifest(paths, goal);
    await events.emit('BENCHMARK_SELECTED', 'Recorded benchmark selection in .opt/benchmark.json', {
      tool: benchmark.manifest.tool,
      command: benchmark.manifest.command,
      metric: benchmark.manifest.metric,
      created: benchmark.created
    });
    createdSetup = true;
  } else {
    const benchmark = await ensureBenchmarkManifest(paths, goal);
    if (benchmark.created) {
      await events.emit('BENCHMARK_SELECTED', 'Recorded benchmark selection in .opt/benchmark.json', {
        tool: benchmark.manifest.tool,
        command: benchmark.manifest.command,
        metric: benchmark.manifest.metric
      });
      createdSetup = true;
    }
    if (await exists(paths.baseline)) {
      await chmod(paths.measure, 0o555).catch(() => undefined);
      await chmod(paths.checks, 0o555).catch(() => undefined);
      await chmod(paths.benchmarkManifest, 0o444).catch(() => undefined);
    }
  }

  let baseline: BaselineFile | null = await readJsonFileMaybe<BaselineFile>(paths.baseline);
  if (!baseline) {
    if (config.evaluation.lock_mode === 'manual' && !hasEvalLockApproval(goal)) {
      await ensureEvalLockQuestion(paths, events);
      return { baseline: null, waitReason: EVAL_LOCK_WAIT_REASON };
    }
    await events.emit('BASELINE_START', 'Running checks and measure to initialize baseline');
    baseline = await initializeBaseline(paths, goal, config);
    await events.emit('BASELINE_DONE', 'Initialized baseline metric', baseline.best_metric);
    createdSetup = true;
  } else {
    await verifyEvalHashes(paths, baseline.eval_sha256);
    await lockEvalScripts(paths);
  }

  if (createdSetup && (await hasChanges(paths))) {
    const commit = await commitAll(paths, 'chore: initialize WiCi plan, eval, and baseline');
    baseline = {
      ...baseline,
      best_commit: commit,
      updated_at: new Date().toISOString()
    };
    await atomicWriteJson(paths.baseline, baseline);
    if (await hasChanges(paths)) {
      await commitAll(paths, `chore: record WiCi baseline anchor ${commit.slice(0, 7)}`);
    }
    await tagBest(paths);
  } else if (!createdSetup && (await hasChanges(paths))) {
    await events.emit('DIRTY_TARGET_ON_START', 'Existing target has uncommitted changes; recovery will decide whether to keep or revert them', undefined, 'warn');
  }

  return { baseline, waitReason: '' };
}

async function drainEvalLockAnswers(
  paths: ReturnType<typeof runPaths>,
  goal: GoalFile,
  checkpoint: Awaited<ReturnType<typeof loadCheckpoint>>,
  events: EventWriter
): Promise<{ goal: GoalFile; checkpoint: Awaited<ReturnType<typeof loadCheckpoint>> }> {
  const pending = await pendingEvalLockQuestion(paths);
  if (!pending) return { goal, checkpoint };

  const injections = await drainInbox(paths, checkpoint.drained_inbox, 8, ['answer'], EVAL_LOCK_REPLY_KEY);
  if (injections.length === 0) return { goal, checkpoint };
  const pendingTs = Date.parse(pending.ts);
  const fresh = injections.filter((item) => Date.parse(item.ts) > pendingTs);
  const stale = injections.filter((item) => !fresh.includes(item));

  const applied = fresh.length > 0 ? applyInjections(goal, fresh) : { goal, steerText: undefined, aborted: false };
  const nextCheckpoint = {
    ...checkpoint,
    drained_inbox: [...checkpoint.drained_inbox, ...injectionIds(injections)],
    goal_version: applied.goal.version
  };
  for (const answer of fresh) {
    const marked = await markOutboxAnswered(paths, EVAL_LOCK_REPLY_KEY, answer.text);
    await events.emit('OUTBOX_ANSWERED', `Applied answer for ${EVAL_LOCK_REPLY_KEY}`, {
      reply_to: EVAL_LOCK_REPLY_KEY,
      outbox_id: marked?.id ?? null
    });
  }
  if (stale.length > 0) {
    await events.emit(
      'EVAL_LOCK_ANSWER_IGNORED',
      'Ignored eval lock answer written before the review question',
      stale.map((item) => ({ id: item.id, ts: item.ts, question_ts: pending.ts })),
      'warn'
    );
  }
  await atomicWriteJson(paths.goal, applied.goal);
  await events.emit(
    'INJECTION_DRAINED',
    fresh.length > 0 ? `Applied ${fresh.length} eval lock answer(s)` : `Drained ${stale.length} stale eval lock answer(s)`,
    injections.map((item) => ({ id: item.id, kind: item.kind, reply_to: item.reply_to, fresh: fresh.includes(item) }))
  );
  await saveCheckpoint(paths, nextCheckpoint);
  return { goal: applied.goal, checkpoint: nextCheckpoint };
}

async function ensureEvalLockQuestion(paths: ReturnType<typeof runPaths>, events: EventWriter): Promise<void> {
  const pending = await pendingEvalLockQuestion(paths);
  if (pending) {
    await events.emit('EVAL_LOCK_REQUIRED', 'Waiting for existing eval lock approval', {
      reply_key: EVAL_LOCK_REPLY_KEY,
      outbox_id: pending.id
    });
    return;
  }

  const message = await writeOutbox(paths, {
    kind: 'question',
    text: 'Review PLAN.md, .opt/benchmark.json, and .opt/*.sh, then answer lock-eval with approved to lock eval and initialize baseline.',
    replyKey: EVAL_LOCK_REPLY_KEY,
    data: {
      plan: 'PLAN.md',
      benchmark: '.opt/benchmark.json',
      acceptance_spec: 'acceptance.spec.json',
      eval_scripts: ['.opt/checks.sh', '.opt/measure.sh']
    }
  });
  await events.emit('EVAL_LOCK_REQUIRED', 'Eval scripts need user approval before baseline lock', {
    reply_key: EVAL_LOCK_REPLY_KEY,
    outbox_id: message.id
  });
}

async function ensureAcceptanceSpecQuestion(paths: ReturnType<typeof runPaths>, events: EventWriter, reason: string): Promise<void> {
  const pending = (await readOutbox(paths, 50)).find((message) => message.reply_key === ACCEPTANCE_CLARIFY_REPLY_KEY && !message.answered);
  if (pending) {
    await events.emit('ACCEPTANCE_SPEC_CLARIFY', 'Waiting for existing acceptance criteria clarification', {
      reply_key: ACCEPTANCE_CLARIFY_REPLY_KEY,
      outbox_id: pending.id,
      reason
    }, 'warn');
    return;
  }

  const message = await writeOutbox(paths, {
    kind: 'question',
    text: `Acceptance criteria must be machine-checkable before the loop can run. ${reason} Reply with concrete checks or update goal.json acceptance_criteria.`,
    replyKey: ACCEPTANCE_CLARIFY_REPLY_KEY,
    data: {
      reason,
      goal: 'goal.json',
      expected_shape: 'acceptance_criteria: [{id,text,check}]'
    }
  });
  await events.emit('ACCEPTANCE_SPEC_CLARIFY', 'Acceptance criteria need clarification before freezing acceptance.spec.json', {
    reply_key: ACCEPTANCE_CLARIFY_REPLY_KEY,
    outbox_id: message.id,
    reason
  }, 'warn');
}

async function pendingEvalLockQuestion(paths: ReturnType<typeof runPaths>) {
  return (await readOutbox(paths, 50)).find((message) => message.reply_key === EVAL_LOCK_REPLY_KEY && !message.answered);
}

function hasEvalLockApproval(goal: GoalFile): boolean {
  return goal.constraints.some((constraint) => {
    if (!constraint.startsWith(`Answer to ${EVAL_LOCK_REPLY_KEY}:`)) return false;
    return /\b(approve|approved|yes|ok)\b/i.test(constraint);
  });
}

async function recoverIncompleteAttempt(
  paths: ReturnType<typeof runPaths>,
  checkpoint: Awaited<ReturnType<typeof loadCheckpoint>>,
  baseline: BaselineFile,
  events: EventWriter
): Promise<Awaited<ReturnType<typeof loadCheckpoint>>> {
  const inFlightStates = new Set(['EXECUTE', 'MEASURE', 'EVALUATE', 'COMMIT', 'REVERT']);
  if (!inFlightStates.has(checkpoint.supervisor_state)) return checkpoint;
  if (await hasChanges(paths)) {
    await revertToBest(paths, baseline.best_commit);
    await events.emit('RECOVER_REVERT', 'Reverted unconfirmed in-flight attempt to best known commit', {
      state: checkpoint.supervisor_state,
      best_commit: baseline.best_commit
    }, 'warn');
  } else if (checkpoint.supervisor_state === 'COMMIT' && checkpoint.next_step) {
    await setPlanStepStatus(paths, checkpoint.next_step, 'pending');
    await events.emit('RECOVER_COMMIT_REPLAY', 'Replaying interrupted commit finalization with idempotency key', {
      step_id: checkpoint.next_step,
      iter: checkpoint.iter
    }, 'warn');
  }
  return {
    ...checkpoint,
    supervisor_state: 'EXECUTE',
    iter: checkpoint.ledger_seq,
    next_step: null,
    plan_hash: await hashFile(paths.plan)
  };
}

async function runStartupScorerSelftest(paths: ReturnType<typeof runPaths>, goal: GoalFile, baseline: BaselineFile, config: WiCiConfig, events: EventWriter): Promise<void> {
  const result = await runScorerSelftest(paths, goal, baseline, config);
  if (!result) return;
  await events.emit('SCORER_SELFTEST_PASS', 'Known-good patch accepted and known-bad patch rejected before execution', {
    good: {
      patch_applied: result.good.patch_applied,
      checks_ok: result.good.checks_ok,
      p99: result.good.metric?.p99,
      delta_pct: result.good.delta_pct,
      verdict: result.good.verdict
    },
    bad: {
      patch_applied: result.bad.patch_applied,
      checks_ok: result.bad.checks_ok,
      p99: result.bad.metric?.p99,
      delta_pct: result.bad.delta_pct,
      verdict: result.bad.verdict
    }
  });
}

async function recordActiveAvenueOutcome(
  paths: ReturnType<typeof runPaths>,
  config: WiCiConfig,
  checkpoint: Awaited<ReturnType<typeof loadCheckpoint>>,
  ledgerEntry: ReturnType<typeof ledgerFromEvaluation>,
  events: EventWriter
): Promise<Awaited<ReturnType<typeof loadCheckpoint>>> {
  if (!checkpoint.active_avenue) return checkpoint;
  const avenueName = checkpoint.active_avenue.name;
  const state = await recordAvenueOutcome(paths, config, avenueName, ledgerEntry);
  await events.emit('AVENUE_OUTCOME', `Recorded outcome for avenue ${avenueName}`, {
    avenue: avenueName,
    ledger_id: ledgerEntry.id,
    status: ledgerEntry.status,
    delta_pct: ledgerEntry.delta_pct,
    stats: state.stats.find((item) => item.name === avenueName)
  });
  const next = {
    ...checkpoint,
    active_avenue: undefined
  };
  await saveCheckpoint(paths, next);
  return next;
}

async function saveStableIterationSnapshot(
  paths: ReturnType<typeof runPaths>,
  goal: GoalFile,
  checkpoint: Awaited<ReturnType<typeof loadCheckpoint>>,
  baseline: BaselineFile
): Promise<void> {
  await saveIterationSnapshot(paths, checkpoint, goal, {
    headCommit: await currentCommit(paths),
    bestCommit: baseline.best_commit
  });
}

async function refreshContextSummary(paths: ReturnType<typeof runPaths>, goal: GoalFile, events: EventWriter): Promise<void> {
  const ledger = await readLedger(paths);
  if (!(await writeContextSummary(paths, goal, ledger))) return;
  await events.emit('CONTEXT_SUMMARY_WRITTEN', 'Updated condensed run context with pinned goal and public ledger summary', {
    path: '.wici/context.md',
    ledger_rows: ledger.length
  });
}

function skillQuery(goal: GoalFile, ledger: Awaited<ReturnType<typeof readLedger>>): string {
  const activeRequirements = goal.requirements.filter((req) => req.status === 'active').map((req) => req.text).join('\n');
  const recent = ledger.slice(-4).map((entry) => `${entry.step_id} ${entry.hypothesis} ${entry.reflection}`).join('\n');
  return `${goal.metric.name}\n${activeRequirements}\n${recent}`;
}

async function hardBackstop(paths: ReturnType<typeof runPaths>, goal: GoalFile): Promise<string | null> {
  if (goal.budget.deadline) {
    const deadlineMs = Date.parse(goal.budget.deadline);
    if (Number.isFinite(deadlineMs) && Date.now() > deadlineMs) {
      return `Hard deadline exceeded: ${goal.budget.deadline}`;
    }
  }

  if (Number.isFinite(goal.budget.max_cost_usd) && goal.budget.max_cost_usd > 0) {
    const ledger = await readLedger(paths);
    const cost = ledger.reduce((sum, entry) => sum + (entry.cost.usd ?? 0), 0);
    if (cost >= goal.budget.max_cost_usd) {
      return `Hard cost backstop exhausted: ${cost.toFixed(4)} >= ${goal.budget.max_cost_usd}`;
    }
  }

  return null;
}

function withLessons(text: string, lessonsText: string): string {
  return lessonsText ? `${text}\n\n${lessonsText}` : text;
}
