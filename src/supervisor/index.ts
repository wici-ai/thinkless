import { chmod, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWriteFile, atomicWriteJson, acquireLock, exists, lineCount, readJsonFileMaybe, truncateJsonLines } from '../shared/atomic.js';
import { applyRuntimeSelection, loadConfig } from '../shared/config.js';
import { INITIAL_GOAL_REQUIRED_MESSAGE } from '../shared/messages.js';
import { ensureRunDirs, ensureTargetGitignore, runPaths } from '../shared/paths.js';
import { preflightResumeCandidate, type ResumeCandidate } from '../shared/resume.js';
import type { BaselineFile, Checkpoint, CheckpointSnapshot, GoalFile, IterResult, LedgerEntry, MetricStats, RunOptions, ToolInvocationResult, ToolUsageSummary, WiCiConfig } from '../shared/types.js';
import { hashFile, iterationSnapshotPath, loadCheckpoint, loadIterationSnapshot, restoreSnapshotRunFiles, saveCheckpoint, saveIterationSnapshot } from './checkpoint.js';
import { EventWriter } from './events.js';
import { applyInjections, drainInbox, drainPendingInjectionsById, injectionIds, readPendingInjections } from './inbox.js';
import { isExecutorPreempted, runExecutorStep, startExecutorStep, type ExecutorProgress } from './executor.js';
import {
  lockEvalScripts,
  runInitialPlanner,
  runPlanDiff,
  unlockEvalScripts,
  verifyEvalHashes,
  type PlannerClarificationResume,
  type PlannerQuestion,
  type PlannerRetryProgress,
  type PlannerUsageProgress,
  type PlannerInvocationResult
} from './planner.js';
import { nextExecutableStep, parsePlanSteps, readPlan, setPlanStepStatus } from './plan.js';
import { appendLedger, lastAccepted, readLedger } from './ledger.js';
import {
  decideImprovement,
  evaluateCandidate,
  initializeBaseline,
  ledgerFromEvaluation,
  loadBaseline,
  runMeasure,
  updateBaselineAfterKeep
} from './evaluate.js';
import { commitAll, commitAllWithKey, currentCommit, ensureGitIdentity, ensureGitRepo, hasChanges, tagBest, tagPerf, revertToBest, resetToCommit } from './gitgate.js';
import { directContinuationVerdict, shouldStop } from './stop.js';
import {
  assertRealToolsReady,
  checkToolHealth,
  reconcileToolVersionDrift,
  shouldAutoUpdateToolsAtBoundary,
  toolVersionsFromHealth,
  updateToolsBetweenRuns
} from './selfupdate.js';
import { consecutiveGlobalFailures, shouldReplanStuckStep } from './stuck.js';
import { markOutboxAnswered, readOutbox, writeOutbox } from './outbox.js';
import { appendLessonFromLedger, formatLessonsForPrompt, readRecentLessons } from './lessons.js';
import { runScorerSelftest } from './scorerSelftest.js';
import { combinePromptMemory, readContextForPrompt, writeContextSummary } from './context.js';
import { markSatisfiedPrimaryRequirements, maybeInterrogateGoal } from './goalInterrogation.js';
import { ensureGoalDoc, saveGoalFiles } from './goalDoc.js';
import { readBenchmarkForPrompt, readBenchmarkManifest } from './benchmark.js';
import {
  ACCEPTANCE_CLARIFY_REPLY_KEY,
  ensureAcceptanceSpec,
  formatAcceptanceSpecForPrompt,
  verifyAcceptanceSpec
} from './acceptance.js';
import { commitLimitArtifact } from './finalArtifact.js';
import { recordAcceptedArchiveEntry, restoreLedgerFile, selectArchiveParent } from './archive.js';
import { formatSkillsForPrompt, recordSkillFromKeep, retrieveSkills } from './skills.js';
import { codexUsageFromError } from './codexRun.js';
import { PLANNER_SELECTED_METRIC, formatPrimaryMetricTransition, primaryMetricTag, primaryMetricValue } from './metricFormat.js';
import { isTransientNetworkFailure, transientFailureReason, transientRetryDelayMs, transientRetryMessage } from './transientRetry.js';
import { findNearDuplicateContinuationStep } from './stepSimilarity.js';

const EVAL_LOCK_REPLY_KEY = 'lock-eval';
const EVAL_LOCK_WAIT_REASON = 'awaiting eval lock approval';
const ACCEPTANCE_SPEC_WAIT_REASON = 'awaiting acceptance criteria clarification';
const PLANNER_CLARIFY_REPLY_PREFIX = 'planner-clarify-';
const PLANNER_CLARIFY_WAIT_REASON = 'awaiting planner clarification';
const STOP_ANSWER_WAIT_REASON = 'awaiting stop answer';
const CONTINUATION_STALL_REPLY_PREFIX = 'continuation-stall-';
const URGENT_ABORT_REASON = 'urgent abort injection';

export interface SupervisorResult {
  state: 'STOP' | 'FAILED' | 'RUNNING';
  reason: string;
  iter: number;
}

export async function runSupervisor(options: RunOptions): Promise<SupervisorResult> {
  const config = await loadConfig(options.mode);
  applyRuntimeSelection(config, options.runtime);
  if (options.lockMode) config.evaluation.lock_mode = options.lockMode;
  const paths = runPaths(options.target, options.sessionDir);
  await ensureRunDirs(paths);
  const releaseLock = await acquireLock(paths.lock);
  const events = new EventWriter(paths.events);

  try {
    await ensureGitRepo(paths, config);
    await ensureGitIdentity(paths, config);
    await ensureTargetGitignore(paths);

    let resumePreflight: ResumeCandidate | null = null;
    if (options.resumePreflight && !options.goal) {
      resumePreflight = await preflightResumeCandidate(paths.target, options.sessionDir);
      if (!resumePreflight.runnable) {
        await events.init();
        await events.emit('RESUME_CONTEXT_BLOCKED', `Resume blocked: ${resumePreflight.reason}`, {
          target: resumePreflight.target,
          session_dir: resumePreflight.sessionDir ?? null,
          state_dir: resumePreflight.stateDir,
          supervisor_state: resumePreflight.supervisorState,
          reason: resumePreflight.reason
        }, 'warn');
        return { state: 'STOP', reason: resumePreflight.reason, iter: 0 };
      }
    }

    const hadGoalBeforeStart = await exists(paths.goal);
    let goal = await ensureGoal(paths, options.goal, config, options.planningContext);
    const maxIters = resolveMaxIters(options.maxIters, goal.budget.max_iters ?? config.budget.max_iters);
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
    if (options.goal && !hadGoalBeforeStart && !checkpoint.goal_source) {
      checkpoint = {
        ...checkpoint,
        goal_source: options.goalSource ?? 'api_goal'
      };
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
    if (resumePreflight) {
      await events.emit('RESUME_CONTEXT_VALIDATED', `Resume context validated: ${resumePreflight.reason}`, {
        target: resumePreflight.target,
        session_dir: resumePreflight.sessionDir ?? null,
        state_dir: resumePreflight.stateDir,
        supervisor_state: resumePreflight.supervisorState,
        planner_session: resumePreflight.plannerSessionId ?? null,
        executor_session: resumePreflight.executorSessionId ?? null,
        executor_app_thread: resumePreflight.executorAppThreadId ?? null,
        best_commit: resumePreflight.bestCommit ?? null,
        tool_versions: resumePreflight.toolVersions ?? null,
        fallback: resumePreflight.fallback ?? null
      });
      if (resumePreflight.fallback === 'executor_rerun') {
        await events.emit('EXECUTOR_RESUME_FALLBACK', 'Executor will replay from checkpointed PLAN/ledger state', {
          target: resumePreflight.target,
          session_dir: resumePreflight.sessionDir ?? null,
          state_dir: resumePreflight.stateDir,
          supervisor_state: resumePreflight.supervisorState
        }, 'warn');
      }
    }

    const didAutoUpdateTools = shouldAutoUpdateToolsAtBoundary(config, checkpoint);
    const toolHealth =
      config.tools.mode === 'stub'
        ? null
        : didAutoUpdateTools
          ? await updateToolsBetweenRuns(config)
          : await checkToolHealth(config, { probeClaude: false });
    if (toolHealth) assertRealToolsReady(config, toolHealth);
    const currentToolVersions = await toolVersionsFromHealth(config, toolHealth);
    const toolDrift = reconcileToolVersionDrift(checkpoint, currentToolVersions);
    checkpoint.tool_versions = currentToolVersions;
    await saveCheckpoint(paths, checkpoint);
    if (didAutoUpdateTools) {
      await events.emit('TOOL_UPDATE_CHECK', 'Checked Codex/Claude updates at a run boundary', { tools: toolHealth });
    }
    if (toolDrift.accepted.length > 0) {
      await events.emit('TOOL_VERSION_ACCEPTED', `Accepted external tool version drift: ${toolDrift.accepted.join('; ')}`, { drift: toolDrift.accepted });
    }
    await events.emit('SUPERVISOR_START', `Starting WiCi supervisor in ${paths.target}`, {
      mode: config.tools.mode,
      goal_source: checkpoint.goal_source ?? null,
      lock_mode: config.evaluation.lock_mode,
      safety: config.safety.container_hint,
      resume_best_commit: resumePreflight?.bestCommit ?? null,
      resume_tool_versions: resumePreflight?.toolVersions ?? null,
      tools: toolHealth
    });

    if (!(await readJsonFileMaybe<BaselineFile>(paths.baseline))) {
      checkpoint = await recoverIncompleteDirectAttempt(paths, checkpoint, events);
      await saveCheckpoint(paths, checkpoint);
    }

    const stopAnswer = await handlePendingStopQuestion(paths, checkpoint, events);
    checkpoint = stopAnswer.checkpoint;
    if (stopAnswer.action !== 'proceed') {
      return { state: 'STOP', reason: stopAnswer.reason, iter: checkpoint.iter };
    }

    const setup = await ensurePlanAndLegacyBaselineState(paths, goal, config, events, checkpoint);
    goal = setup.goal;
    checkpoint = setup.checkpoint;
    let baseline = setup.baseline;
    if (!baseline) {
      if (setup.waitReason === URGENT_ABORT_REASON) {
        return { state: 'STOP', reason: URGENT_ABORT_REASON, iter: setup.checkpoint.iter };
      }
      if (setup.waitReason !== 'PLAN_READY') {
        checkpoint = {
          ...checkpoint,
          supervisor_state: 'STOP',
          goal_version: goal.version,
          ledger_seq: await lineCount(paths.ledger),
          events_seq: events.seq
        };
        await saveCheckpoint(paths, checkpoint);
        await events.emit('STOP', setup.waitReason);
        return { state: 'STOP', reason: setup.waitReason, iter: checkpoint.iter };
      }
      return runDirectPlanExecution(paths, goal, config, events, checkpoint, maxIters, options);
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
    const transientExecutorRetries = new Map<string, number>();

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
      const parentId = checkpoint.active_branch?.parent_id ?? lastAccepted(ledgerBeforeIteration)?.id ?? null;

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
        await saveGoalFiles(paths, goal);
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
        const diff = await runPlanDiff(
          paths,
          goal,
          checkpoint.sessions.planner,
          withLessons(steerText ?? '', memoryText),
          config,
          (progress) => emitPlannerUsage(events, progress, { phase: 'plan_diff' }),
          (retry) => emitPlannerRetry(events, retry, { phase: 'plan_diff' }),
          () => hasPendingUrgentAbort(paths, checkpoint)
        );
        const stoppedForAbort = await stopIfPlannerAborted(paths, goal, checkpoint, events, diff);
        if (stoppedForAbort) return stoppedForAbort.result;
        const waitingForPlanner = await stopForPlannerDiffClarification(paths, events, goal, checkpoint, diff);
        if (waitingForPlanner) {
          return { state: 'STOP', reason: PLANNER_CLARIFY_WAIT_REASON, iter: waitingForPlanner.iter };
        }
        if (!diff.ok) throw new Error(diff.error ?? 'Planner did not update PLAN.md');
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
        iterResult = await runExecutorStep(paths, goal, step.id, nextIter, config, steerText, memoryText, {
          onProgress: async (progress) => {
            await events.emit('EXECUTE_PROGRESS', formatExecutorProgress(progress), {
              iter: nextIter,
              step_id: step.id,
              progress
            });
          }
        });
        checkpoint.sessions.executor = iterResult.invocation.sessionId ?? checkpoint.sessions.executor;
        transientExecutorRetries.delete(`${step.id}:${nextIter}`);
        await events.emit('EXECUTE_DONE', iterResult.notes, {
          step_done: iterResult.step_done,
          tests_pass: iterResult.tests_pass,
          changed_files: iterResult.changed_files,
          usage: iterResult.invocation.usage
        });
      } catch (error) {
        const usage = codexUsageFromError(error);
        const reason = errorMessage(error);
        if (isTransientNetworkFailure(reason)) {
          const retryKey = `${step.id}:${nextIter}`;
          const attempt = (transientExecutorRetries.get(retryKey) ?? 0) + 1;
          transientExecutorRetries.set(retryKey, attempt);
          const retry = {
            attempt,
            delayMs: transientRetryDelayMs(),
            reason: transientFailureReason(reason)
          };
          await events.emit('EXECUTE_RETRY_WAIT', transientRetryMessage('Executor', retry), usage ? { iter: nextIter, step_id: step.id, usage, ...retry } : { iter: nextIter, step_id: step.id, ...retry }, 'warn');
          await revertToBest(paths, baseline.best_commit);
          await setPlanStepStatus(paths, step.id, 'pending');
          checkpoint = {
            ...checkpoint,
            supervisor_state: 'EXECUTE',
            iter: nextIter - 1,
            next_step: step.id,
            ledger_seq: await lineCount(paths.ledger),
            events_seq: events.seq,
            plan_hash: await hashFile(paths.plan)
          };
          await saveCheckpoint(paths, checkpoint);
          await delay(retry.delayMs);
          await events.emit('EXECUTE_RETRY', `Retrying ${step.id} after transient network failure`, {
            iter: nextIter,
            step_id: step.id,
            attempt
          }, 'warn');
          checkpoint = {
            ...checkpoint,
            events_seq: events.seq
          };
          await saveCheckpoint(paths, checkpoint);
          continue;
        }
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
          branch_reason: checkpoint.active_branch?.reason
        });
        await appendLedger(paths, ledgerEntry);
        await appendLessonFromLedger(paths, ledgerEntry, config);
        await refreshContextSummary(paths, goal, events);
        checkpoint = await recordActiveBranchOutcome(paths, checkpoint, ledgerEntry, events);
        if (await hasChanges(paths)) {
          await commitAll(paths, `chore: record failed WiCi iteration ${nextIter}`);
          await tagBest(paths);
        }
        await saveCheckpoint(paths, checkpoint);
        if (options.once) break;
        continue;
      }

      const safePointInjections = await drainInbox(paths, checkpoint.drained_inbox);
      if (safePointInjections.length > 0) {
        const applied = applyInjections(goal, safePointInjections);
        goal = applied.goal;
        steerText = applied.steerText;
        const drainedIds = injectionIds(safePointInjections);
        checkpoint.drained_inbox = [...checkpoint.drained_inbox, ...drainedIds];
        checkpoint.goal_version = goal.version;
        for (const answer of safePointInjections.filter((item) => item.kind === 'answer' && item.reply_to)) {
          const marked = await markOutboxAnswered(paths, answer.reply_to!, answer.text);
          await events.emit('OUTBOX_ANSWERED', `Applied answer for ${answer.reply_to}`, {
            reply_to: answer.reply_to,
            outbox_id: marked?.id ?? null
          });
        }
        await saveGoalFiles(paths, goal);
        await events.emit(
          'INJECTION_DRAINED',
          `Applied ${drainedIds.length} chat injection(s) at EVALUATE safe point`,
          safePointInjections.map((item) => ({ id: item.id, ids: item.coalesced_ids ?? [item.id], kind: item.kind, safe_point: 'evaluate' }))
        );

        await revertToBest(paths, baseline.best_commit);
        await setPlanStepStatus(paths, step.id, 'pending');
        const ledgerEntry = ledgerFromEvaluation({
          iter: nextIter,
          stepId: step.id,
          status: 'revert',
          hypothesis: step.text,
          commit: null,
          baseline: baseline.best_metric,
          evaluation: null,
          wallMs: Date.now() - iterationStarted,
          usage: iterResult.invocation.usage,
          reflection: 'superseded by chat injection at EVALUATE safe point; reverted before evaluation',
          parentId,
          branch_reason: checkpoint.active_branch?.reason
        });
        await appendLedger(paths, ledgerEntry);
        await appendLessonFromLedger(paths, ledgerEntry, config);
        await refreshContextSummary(paths, goal, events);
        checkpoint = await recordActiveBranchOutcome(paths, checkpoint, ledgerEntry, events);

        if (applied.aborted) {
          checkpoint = {
            ...checkpoint,
            supervisor_state: 'STOP',
            ledger_seq: await lineCount(paths.ledger),
            events_seq: events.seq,
            plan_hash: await hashFile(paths.plan)
          };
          await saveCheckpoint(paths, checkpoint);
          await writeOutbox(paths, { kind: 'info', text: 'Urgent abort injection requested stop' });
          await events.emit('STOP', 'Urgent abort injection requested stop', undefined, 'warn');
          return { state: 'STOP', reason: 'urgent abort injection', iter: checkpoint.iter };
        }

        checkpoint = {
          ...checkpoint,
          supervisor_state: 'PLAN',
          ledger_seq: await lineCount(paths.ledger),
          events_seq: events.seq,
          plan_hash: await hashFile(paths.plan)
        };
        await saveCheckpoint(paths, checkpoint);
        const diff = await runPlanDiff(
          paths,
          goal,
          checkpoint.sessions.planner,
          withLessons(steerText ?? '', memoryText),
          config,
          (progress) => emitPlannerUsage(events, progress, { phase: 'plan_diff', safe_point: 'evaluate' }),
          (retry) => emitPlannerRetry(events, retry, { phase: 'plan_diff', safe_point: 'evaluate' }),
          () => hasPendingUrgentAbort(paths, checkpoint)
        );
        const stoppedForAbort = await stopIfPlannerAborted(paths, goal, checkpoint, events, diff);
        if (stoppedForAbort) return stoppedForAbort.result;
        const waitingForPlanner = await stopForPlannerDiffClarification(paths, events, goal, checkpoint, diff);
        if (waitingForPlanner) {
          return { state: 'STOP', reason: PLANNER_CLARIFY_WAIT_REASON, iter: waitingForPlanner.iter };
        }
        if (!diff.ok) throw new Error(diff.error ?? 'Planner did not update PLAN.md');
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
        checkpoint = {
          ...checkpoint,
          supervisor_state: 'EXECUTE',
          ledger_seq: await lineCount(paths.ledger),
          events_seq: events.seq,
          plan_hash: await hashFile(paths.plan)
        };
        await saveCheckpoint(paths, checkpoint);
        await saveStableIterationSnapshot(paths, goal, checkpoint, baseline);
        await events.emit('PLAN_DIFF_APPLIED', 'Planner applied a minimal plan diff for new input at EVALUATE safe point', { steerText, safe_point: 'evaluate' });
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
          branch_reason: checkpoint.active_branch?.reason
        });
        await appendLedger(paths, ledgerEntry);
        await appendLessonFromLedger(paths, ledgerEntry, config);
        checkpoint = await recordActiveBranchOutcome(paths, checkpoint, ledgerEntry, events);
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
        const message = `perf: ${step.text} | ${formatPrimaryMetricTransition(goal, previousMetric, evaluation.metric)} (${shortDelta}) | guards ok`;
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
          branch_reason: checkpoint.active_branch?.reason
        });
        await appendLedger(paths, ledgerEntry);
        await appendLessonFromLedger(paths, ledgerEntry, config);
        checkpoint = await recordActiveBranchOutcome(paths, checkpoint, ledgerEntry, events);
        if (await hasChanges(paths)) {
          await commitAll(paths, `chore: record WiCi baseline and ledger for ${commit.slice(0, 7)}`);
        }
        await tagPerf(paths, `perf/${primaryMetricTag(goal, evaluation.metric)}-${commit.slice(0, 7)}`);
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
          value: primaryMetricValue(evaluation.metric),
          heldout_value: evaluation.heldoutMetric ? primaryMetricValue(evaluation.heldoutMetric) : undefined,
          delta_pct: evaluation.deltaPct,
          heldout_delta_pct: evaluation.heldoutDeltaPct,
          confidence: evaluation.confidence,
          p_value: evaluation.pValue
        });
      } else {
        checkpoint.supervisor_state = 'REVERT';
        await saveCheckpoint(paths, checkpoint);
        await events.emit('REVERT', evaluation.reason, {
          delta_pct: evaluation.deltaPct,
          prescreen_value: evaluation.prescreenMetric ? primaryMetricValue(evaluation.prescreenMetric) : undefined,
          prescreen_delta_pct: evaluation.prescreenDeltaPct,
          heldout_value: evaluation.heldoutMetric ? primaryMetricValue(evaluation.heldoutMetric) : undefined,
          heldout_delta_pct: evaluation.heldoutDeltaPct,
          confidence: evaluation.confidence,
          p_value: evaluation.pValue
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
          branch_reason: checkpoint.active_branch?.reason
        });
        await appendLedger(paths, ledgerEntry);
        await appendLessonFromLedger(paths, ledgerEntry, config);
        checkpoint = await recordActiveBranchOutcome(paths, checkpoint, ledgerEntry, events);
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
      const satisfiedGoal = markSatisfiedPrimaryRequirements(goal, ledger);
      if (satisfiedGoal) {
        const requirementIds = goal.requirements
          .filter((requirement) => (requirement.kind ?? 'primary') === 'primary' && requirement.status === 'active')
          .map((requirement) => requirement.id);
        goal = satisfiedGoal;
        await saveGoalFiles(paths, goal);
        await events.emit('GOAL_REQUIREMENTS_SATISFIED', 'Marked primary requirements done after target metric was met', {
          goal_version: goal.version,
          requirement_ids: requirementIds
        });
      }
      const goalCheck = await maybeInterrogateGoal(paths, goal, ledger);
      if (goalCheck) {
        await events.emit('GOAL_INTERROGATION', `Checked iteration ${goalCheck.iter} behavior against GOAL.md`, {
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
        checkpoint.active_branch = {
          parent_id: branchParentId,
          selected_at: new Date().toISOString(),
          reason: stuck.reason
        };
        await events.emit('BRANCH_REPLAN_REQUEST', `Requesting planner-selected replan for ${step.id}`, {
          step_id: step.id,
          parent_id: branchParentId,
          stuck_reason: stuck.reason,
          attempts: stuck.attempts,
          consecutive_failures: stuck.consecutiveFailures
        });
        await refreshContextSummary(paths, goal, events);
        const replanText = withLessons(
          [
            `${stuck.reason}.`,
            `Step ${step.id} is blocked after ${stuck.attempts} attempt(s) and ${stuck.consecutiveFailures} consecutive failure(s).`,
            branchParentId ? `Branch parent ledger id: ${branchParentId}.` : '',
            'Analyze GOAL.md, PLAN.md, the ledger, and lessons, then produce a minimal plan diff with a new planner-chosen direction.',
            'Do not rely on a supervisor-provided category; choose the next approach from the evidence.',
            'Preserve completed steps and keep planner-provided validation artifacts consistent with PLAN.md.'
          ].filter(Boolean).join(' '),
          memoryText
        );
        const diff = await runPlanDiff(
          paths,
          goal,
          checkpoint.sessions.planner,
          replanText,
          config,
          (progress) => emitPlannerUsage(events, progress, { phase: 'stuck_replan', step_id: step.id }),
          (retry) => emitPlannerRetry(events, retry, { phase: 'stuck_replan', step_id: step.id }),
          () => hasPendingUrgentAbort(paths, checkpoint)
        );
        const stoppedForAbort = await stopIfPlannerAborted(paths, goal, checkpoint, events, diff);
        if (stoppedForAbort) return stoppedForAbort.result;
        const waitingForPlanner = await stopForPlannerDiffClarification(paths, events, goal, checkpoint, diff);
        if (waitingForPlanner) {
          return { state: 'STOP', reason: PLANNER_CLARIFY_WAIT_REASON, iter: waitingForPlanner.iter };
        }
        if (!diff.ok) throw new Error(diff.error ?? 'Planner did not update PLAN.md');
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
          parent_id: branchParentId,
          planner_selects_direction: true
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

    const limitReason = `Reached max_iters=${maxItersLabel(maxIters)}`;
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
    const failedCheckpoint = await readJsonFileMaybe<Checkpoint>(paths.checkpoint).catch(() => null);
    if (failedCheckpoint) {
      const ledgerSeq = await lineCount(paths.ledger);
      await saveCheckpoint(paths, {
        ...failedCheckpoint,
        supervisor_state: 'FAILED',
        iter: ledgerSeq,
        ledger_seq: ledgerSeq,
        events_seq: events.seq
      });
    }
    return { state: 'FAILED', reason, iter: 0 };
  } finally {
    await releaseLock();
  }
}

async function runDirectPlanExecution(
  paths: ReturnType<typeof runPaths>,
  goal: GoalFile,
  config: WiCiConfig,
  events: EventWriter,
  checkpoint: Checkpoint,
  maxIters: number,
  options: RunOptions
): Promise<SupervisorResult> {
  let steerText: string | undefined;
  const transientExecutorRetries = new Map<string, number>();

  while (checkpoint.iter < maxIters) {
    const pendingUpdate = await applyDirectPendingInjections(paths, goal, checkpoint, config, events);
    goal = pendingUpdate.goal;
    checkpoint = pendingUpdate.checkpoint;
    steerText = pendingUpdate.steerText ?? steerText;
    if (pendingUpdate.stop) {
      return pendingUpdate.stop;
    }

    const plan = await readPlan(paths);
    const step = nextExecutableStep(plan);
    if (!step) {
      const continuation = await continueDirectExhaustedPlan(paths, goal, checkpoint, config, events, plan);
      goal = continuation.goal;
      checkpoint = continuation.checkpoint;
      if (continuation.stop) return continuation.stop;
      if (continuation.continued) continue;
      throw new Error('Planner continuation returned without a next executable step or stop decision');
    }

    const nextIter = checkpoint.iter + 1;
    const iterationStarted = Date.now();
    const contextText = await readContextForPrompt(paths);
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
    await events.emit('EXECUTE_START', `Iteration ${nextIter}: executing ${step.id}`, { step, mode: 'direct' });

    try {
      const run = await runDirectExecutorWithHotReload({
        paths,
        goal,
        checkpoint,
        stepId: step.id,
        iter: nextIter,
        config,
        events,
        steerText,
        contextText
      });
      goal = run.goal;
      checkpoint = run.checkpoint;
      steerText = run.steerText ?? steerText;
      if (run.stop) return run.stop;
      if (!run.result) throw new Error('Executor stopped without a result');
      const iterResult = run.result;
      checkpoint.sessions.executor = iterResult.invocation.sessionId ?? checkpoint.sessions.executor;
      transientExecutorRetries.delete(`${step.id}:${nextIter}`);
      if (run.executorApp) {
        checkpoint.sessions.executorApp = run.executorApp;
      }
      await events.emit('EXECUTE_DONE', iterResult.notes, {
        step_done: iterResult.step_done,
        tests_pass: iterResult.tests_pass,
        changed_files: iterResult.changed_files,
        usage: iterResult.invocation.usage,
        mode: 'direct'
      });
      await setPlanStepStatus(paths, step.id, iterResult.step_done && iterResult.tests_pass ? 'done' : 'pending', nextIter);
      const directBestCommit = await currentCommitOrNull(paths) ?? checkpoint.best_commit ?? null;
      if (await hasChanges(paths)) {
        await events.emit('DIRECT_UNCOMMITTED_CHANGES', 'Executor left uncommitted worktree changes; direct V1 expects PLAN.md to make Codex commit code changes itself', {
          iter: nextIter,
          step_id: step.id,
          mode: 'direct'
        }, 'warn');
      }
      let directStatus: LedgerEntry['status'] = iterResult.step_done && iterResult.tests_pass ? 'keep' : 'reject';
      const measurement = directStatus === 'keep' && (await exists(paths.measure)) ? await runMeasure(paths, config) : null;
      const directMetric = measurement?.metric ?? null;
      const directBaseline = directMetric ? previousKeepMetric(await readLedger(paths)) : null;
      const directDeltaPct = directMetric && directBaseline ? directMetricDeltaPct(directBaseline, directMetric, goal.metric.direction) : null;
      const directDecision = directMetric && directBaseline ? decideImprovement(directBaseline, directMetric, goal, config) : null;
      if (directMetric) {
        await events.emit('DIRECT_MEASURE', `Measured direct ${step.id}: ${primaryMetricTag(goal, directMetric)}`, {
          iter: nextIter,
          step_id: step.id,
          metric: directMetric,
          baseline: directBaseline,
          delta_pct: directDeltaPct,
          decision: directDecision,
          mode: 'direct'
        });
      }
      const regressed = directDecision ? directDecision.deltaPct < -config.evaluation.noise_threshold : false;
      if (regressed) {
        await events.emit('DIRECT_METRIC_REGRESSION', `Direct ${step.id} regressed; reverting to best checkpoint: ${directDecision?.reason ?? 'metric regression'}`, {
          iter: nextIter,
          step_id: step.id,
          metric: directMetric,
          baseline: directBaseline,
          delta_pct: directDeltaPct,
          decision: directDecision,
          best_commit: checkpoint.best_commit ?? null,
          mode: 'direct'
        }, 'warn');
        await revertToBest(paths, checkpoint.best_commit ?? 'NO_HEAD');
        await setPlanStepStatus(paths, step.id, 'pending', nextIter);
        directStatus = 'revert';
      }
      const ledgerEntry = directLedgerEntry({
        iter: nextIter,
        stepId: step.id,
        status: directStatus,
        commit: regressed ? checkpoint.best_commit ?? null : directBestCommit,
        wallMs: Date.now() - iterationStarted,
        usage: iterResult.invocation.usage,
        notes: iterResult.notes,
        stepDone: iterResult.step_done,
        testsPass: iterResult.tests_pass,
        changedFiles: iterResult.changed_files,
        metric: directMetric,
        baseline: directBaseline,
        deltaPct: directDeltaPct
      });
      await appendLedger(paths, ledgerEntry);
      const ledgerAfterIteration = await readLedger(paths);
      const satisfiedGoal = markSatisfiedPrimaryRequirements(goal, ledgerAfterIteration);
      if (satisfiedGoal) {
        const requirementIds = goal.requirements
          .filter((requirement) => (requirement.kind ?? 'primary') === 'primary' && requirement.status === 'active')
          .map((requirement) => requirement.id);
        goal = satisfiedGoal;
        await saveGoalFiles(paths, goal);
        await events.emit('GOAL_REQUIREMENTS_SATISFIED', 'Marked primary requirements done after target metric was met', {
          goal_version: goal.version,
          requirement_ids: requirementIds
        });
      }
      const goalCheck = await maybeInterrogateGoal(paths, goal, ledgerAfterIteration);
      if (goalCheck) {
        await events.emit('GOAL_INTERROGATION', 'Periodic direct-path check compared GOAL.md with recent execution history', goalCheck, goalCheck.aligned ? 'info' : 'warn');
      }
      await refreshContextSummary(paths, goal, events);
      checkpoint = {
        ...checkpoint,
        supervisor_state: 'REFLECT',
        next_step: step.id,
        best_commit: regressed ? checkpoint.best_commit : directBestCommit,
        ledger_seq: await lineCount(paths.ledger),
        events_seq: events.seq,
        plan_hash: await hashFile(paths.plan)
      };
      await saveCheckpoint(paths, checkpoint);
      steerText = undefined;
      if (options.once) break;
    } catch (error) {
      if (isExecutorPreempted(error)) {
        const usage = error.usage;
        const reason = errorMessage(error);
        await events.emit('EXECUTE_PREEMPTED', reason, usage ? { usage, mode: 'direct' } : { mode: 'direct' }, 'warn');
        await revertToBest(paths, checkpoint.best_commit ?? 'NO_HEAD');
        await setPlanStepStatus(paths, step.id, 'pending', nextIter);
        const ledgerEntry = directLedgerEntry({
          iter: nextIter,
          stepId: step.id,
          status: 'preempted',
          commit: checkpoint.best_commit ?? null,
          wallMs: Date.now() - iterationStarted,
          usage,
          notes: 'Executor preempted at the next Codex output/heartbeat to apply pending Chat input.',
          stepDone: false,
          testsPass: false,
          changedFiles: []
        });
        await appendLedger(paths, ledgerEntry);
        await refreshContextSummary(paths, goal, events);
        checkpoint = {
          ...checkpoint,
          supervisor_state: 'REFLECT',
          next_step: step.id,
          ledger_seq: await lineCount(paths.ledger),
          events_seq: events.seq,
          plan_hash: await hashFile(paths.plan)
        };
        await saveCheckpoint(paths, checkpoint);
        steerText = undefined;
        if (options.once) break;
        continue;
      }
      const usage = codexUsageFromError(error);
      const reason = errorMessage(error);
      if (isTransientNetworkFailure(reason)) {
        const retryKey = `${step.id}:${nextIter}`;
        const attempt = (transientExecutorRetries.get(retryKey) ?? 0) + 1;
        transientExecutorRetries.set(retryKey, attempt);
        const retry = {
          attempt,
          delayMs: transientRetryDelayMs(),
          reason: transientFailureReason(reason)
        };
        await events.emit('EXECUTE_RETRY_WAIT', transientRetryMessage('Executor', retry), usage ? { iter: nextIter, step_id: step.id, mode: 'direct', usage, ...retry } : { iter: nextIter, step_id: step.id, mode: 'direct', ...retry }, 'warn');
        await revertToBest(paths, checkpoint.best_commit ?? 'NO_HEAD');
        await setPlanStepStatus(paths, step.id, 'pending', nextIter);
        checkpoint = {
          ...checkpoint,
          supervisor_state: 'EXECUTE',
          iter: nextIter - 1,
          next_step: step.id,
          ledger_seq: await lineCount(paths.ledger),
          events_seq: events.seq,
          plan_hash: await hashFile(paths.plan)
        };
        await saveCheckpoint(paths, checkpoint);
        await delay(retry.delayMs);
        await events.emit('EXECUTE_RETRY', `Retrying ${step.id} after transient network failure`, {
          iter: nextIter,
          step_id: step.id,
          mode: 'direct',
          attempt
        }, 'warn');
        checkpoint = {
          ...checkpoint,
          events_seq: events.seq
        };
        await saveCheckpoint(paths, checkpoint);
        continue;
      }
      await events.emit('EXECUTE_RECOVERABLE_FAILURE', reason, usage ? { usage, mode: 'direct' } : { mode: 'direct' }, 'warn');
      const ledgerEntry = directLedgerEntry({
        iter: nextIter,
        stepId: step.id,
        status: 'crash',
        commit: checkpoint.best_commit ?? null,
        wallMs: Date.now() - iterationStarted,
        usage,
        notes: reason,
        stepDone: false,
        testsPass: false,
        changedFiles: []
      });
      await appendLedger(paths, ledgerEntry);
      await setPlanStepStatus(paths, step.id, 'pending', nextIter);
      await refreshContextSummary(paths, goal, events);
      checkpoint = {
        ...checkpoint,
        supervisor_state: 'REFLECT',
        next_step: step.id,
        ledger_seq: await lineCount(paths.ledger),
        events_seq: events.seq,
        plan_hash: await hashFile(paths.plan)
      };
      await saveCheckpoint(paths, checkpoint);
      steerText = recoverySteerText(step.id, nextIter, reason);
      await writeOutbox(paths, {
        kind: 'info',
        text: `Executor attempt ${nextIter} failed and was recorded; WiCi will continue the same goal so Codex can diagnose, update PLAN.md, and retry. Reason: ${reason}`
      });
      if (options.once) break;
      continue;
    }
  }

  const reason = `Reached max_iters=${maxItersLabel(maxIters)}`;
  checkpoint = {
    ...checkpoint,
    supervisor_state: 'STOP',
    ledger_seq: await lineCount(paths.ledger),
    events_seq: events.seq,
    plan_hash: await hashFile(paths.plan)
  };
  await saveCheckpoint(paths, checkpoint);
  await writeOutbox(paths, { kind: 'info', text: reason });
  await events.emit('STOP', reason);
  return { state: 'STOP', reason, iter: checkpoint.iter };
}

async function continueDirectExhaustedPlan(
  paths: ReturnType<typeof runPaths>,
  goal: GoalFile,
  checkpoint: Checkpoint,
  config: WiCiConfig,
  events: EventWriter,
  plan: string
): Promise<{ goal: GoalFile; checkpoint: Checkpoint; continued: boolean; stop?: SupervisorResult }> {
  await events.emit('PLAN_EXHAUSTED', 'PLAN.md has no pending executable steps; checking completion before asking planner for the next concrete step.', {
    iter: checkpoint.iter,
    mode: 'direct'
  });
  checkpoint = {
    ...checkpoint,
    supervisor_state: 'PLAN',
    next_step: null,
    ledger_seq: await lineCount(paths.ledger),
    events_seq: events.seq,
    plan_hash: await hashFile(paths.plan)
  };
  await saveCheckpoint(paths, checkpoint);

  const verdict = await directContinuationVerdict(paths, goal, await readLedger(paths), config);
  await events.emit(
    'DIRECT_CONTINUATION_VERDICT',
    `Direct completion gate chose ${verdict.decision}: ${verdict.reason}`,
    { verdict, mode: 'direct' }
  );
  const continuationFallbacks = verdict.source === 'fallback' ? (checkpoint.consecutive_continuation_fallbacks ?? 0) + 1 : 0;
  checkpoint = {
    ...checkpoint,
    consecutive_continuation_fallbacks: continuationFallbacks,
    events_seq: events.seq
  };
  await saveCheckpoint(paths, checkpoint);
  if (verdict.source === 'fallback' && continuationFallbacks >= continuationFallbackThreshold()) {
    const threshold = continuationFallbackThreshold();
    const replyKey = `${CONTINUATION_STALL_REPLY_PREFIX}${checkpoint.iter}`;
    const reason = `Continuation gate fell back ${continuationFallbacks} consecutive time(s); pausing instead of continuing to manufacture work.`;
    const question = await writeOutbox(paths, {
      kind: 'question',
      text: `${reason} Reply with a steer or new requirement to resume, or answer stop to leave the run stopped.`,
      replyKey,
      data: { mode: 'direct', verdict, consecutive_continuation_fallbacks: continuationFallbacks, threshold }
    });
    checkpoint = {
      ...checkpoint,
      supervisor_state: 'STOP',
      next_step: null,
      ledger_seq: await lineCount(paths.ledger),
      events_seq: events.seq,
      plan_hash: await hashFile(paths.plan)
    };
    await saveCheckpoint(paths, checkpoint);
    await events.emit('CONTINUATION_ESCALATED', reason, {
      mode: 'direct',
      verdict,
      reply_key: replyKey,
      outbox_id: question.id,
      consecutive_continuation_fallbacks: continuationFallbacks,
      threshold
    }, 'warn');
    await events.emit('STOP', reason, { mode: 'direct', reply_key: replyKey, outbox_id: question.id }, 'warn');
    return { goal, checkpoint, continued: false, stop: { state: 'STOP', reason, iter: checkpoint.iter } };
  }
  if (verdict.decision === 'complete') {
    const reason = `PLAN.md exhausted and completion gate marked the goal complete: ${verdict.reason}`;
    checkpoint = {
      ...checkpoint,
      supervisor_state: 'STOP',
      next_step: null,
      consecutive_continuation_fallbacks: 0,
      consecutive_duplicate_continuation_steps: 0,
      ledger_seq: await lineCount(paths.ledger),
      events_seq: events.seq,
      plan_hash: await hashFile(paths.plan)
    };
    await saveCheckpoint(paths, checkpoint);
    await writeOutbox(paths, { kind: 'info', text: reason });
    await events.emit('STOP', reason, { mode: 'direct', verdict });
    return { goal, checkpoint, continued: false, stop: { state: 'STOP', reason, iter: checkpoint.iter } };
  }

  const steerText = await buildDirectPlanContinuationSteerText(paths, goal, plan, verdict.reason);
  const diff = await runPlanDiff(
    paths,
    goal,
    checkpoint.sessions.planner,
    steerText,
    config,
    (progress) => emitPlannerUsage(events, progress, { phase: 'direct_plan_continuation' }),
    (retry) => emitPlannerRetry(events, retry, { phase: 'direct_plan_continuation' }),
    () => hasPendingUrgentAbort(paths, checkpoint)
  );
  const stoppedForAbort = await stopIfPlannerAborted(paths, goal, checkpoint, events, diff);
  if (stoppedForAbort) return { goal: stoppedForAbort.goal, checkpoint: stoppedForAbort.checkpoint, continued: false, stop: stoppedForAbort.result };
  const waitingForPlanner = await stopForPlannerDiffClarification(paths, events, goal, checkpoint, diff);
  if (waitingForPlanner) {
    return { goal, checkpoint, continued: false, stop: { state: 'STOP', reason: PLANNER_CLARIFY_WAIT_REASON, iter: waitingForPlanner.iter } };
  }
  if (!diff.ok) {
    const reason = `Planner could not derive a next executable step after PLAN.md was exhausted: ${diff.error ?? 'unknown planner failure'}`;
    checkpoint = {
      ...checkpoint,
      supervisor_state: 'FAILED',
      sessions: {
        ...checkpoint.sessions,
        planner: diff.sessionId ?? checkpoint.sessions.planner
      },
      ledger_seq: await lineCount(paths.ledger),
      events_seq: events.seq,
      plan_hash: await hashFile(paths.plan)
    };
    await saveCheckpoint(paths, checkpoint);
    await writeOutbox(paths, { kind: 'info', text: reason });
    await events.emit('FAILED', reason, { mode: 'direct' }, 'warn');
    return { goal, checkpoint, continued: false, stop: { state: 'FAILED', reason, iter: checkpoint.iter } };
  }

  const updatedPlan = await readPlan(paths);
  const duplicateMatch = findNearDuplicateContinuationStep(parsePlanSteps(plan), parsePlanSteps(updatedPlan), {
    recentWindow: stepDedupRecentWindow(),
    threshold: stepDedupSimilarityThreshold()
  });
  const duplicateCount = duplicateMatch ? (checkpoint.consecutive_duplicate_continuation_steps ?? 0) + 1 : 0;
  if (duplicateMatch) {
    checkpoint = {
      ...checkpoint,
      consecutive_duplicate_continuation_steps: duplicateCount,
      events_seq: events.seq
    };
    await saveCheckpoint(paths, checkpoint);
    if (duplicateCount >= stepDedupConsecutiveThreshold()) {
      await atomicWriteFile(paths.plan, ensureTrailingNewline(plan));
      const replyKey = `${CONTINUATION_STALL_REPLY_PREFIX}${checkpoint.iter}-dedup`;
      const reason = `Planner continuation proposed near-duplicate step ${duplicateMatch.added.id} (${duplicateMatch.added.text}) similar to ${duplicateMatch.existing.id} (${duplicateMatch.existing.text}); pausing instead of appending busywork.`;
      const question = await writeOutbox(paths, {
        kind: 'question',
        text: `${reason} Reply with a steer or new requirement to resume, or answer stop to leave the run stopped.`,
        replyKey,
        data: {
          mode: 'direct',
          duplicate_step: duplicateMatch,
          consecutive_duplicate_continuation_steps: duplicateCount,
          threshold: stepDedupConsecutiveThreshold()
        }
      });
      checkpoint = {
        ...checkpoint,
        supervisor_state: 'STOP',
        next_step: null,
        ledger_seq: await lineCount(paths.ledger),
        events_seq: events.seq,
        plan_hash: await hashFile(paths.plan)
      };
      await saveCheckpoint(paths, checkpoint);
      await events.emit('CONTINUATION_DEDUP_ESCALATED', reason, {
        mode: 'direct',
        reply_key: replyKey,
        outbox_id: question.id,
        duplicate_step: duplicateMatch,
        consecutive_duplicate_continuation_steps: duplicateCount,
        threshold: stepDedupConsecutiveThreshold()
      }, 'warn');
      await events.emit('STOP', reason, { mode: 'direct', reply_key: replyKey, outbox_id: question.id }, 'warn');
      return { goal, checkpoint, continued: false, stop: { state: 'STOP', reason, iter: checkpoint.iter } };
    }
  }
  const nextStep = nextExecutableStep(updatedPlan);
  checkpoint = {
    ...checkpoint,
    sessions: {
      ...checkpoint.sessions,
      planner: diff.sessionId ?? checkpoint.sessions.planner
    },
    supervisor_state: nextStep ? 'EXECUTE' : 'FAILED',
    next_step: nextStep?.id ?? null,
    consecutive_duplicate_continuation_steps: duplicateCount,
    plan_hash: await hashFile(paths.plan),
    ledger_seq: await lineCount(paths.ledger),
    events_seq: events.seq
  };
  await saveCheckpoint(paths, checkpoint);
  if (!nextStep) {
    const reason = 'Planner continuation completed but PLAN.md still has no pending executable step; treating this as concrete blocked evidence.';
    await writeOutbox(paths, { kind: 'info', text: reason });
    await events.emit('FAILED', reason, { mode: 'direct' }, 'warn');
    return { goal, checkpoint, continued: false, stop: { state: 'FAILED', reason, iter: checkpoint.iter } };
  }

  await events.emit('PLAN_CONTINUATION_APPLIED', `Planner added or activated ${nextStep.id} after PLAN.md was exhausted`, {
    step: nextStep,
    mode: 'direct'
  });
  return { goal, checkpoint, continued: true };
}

async function buildDirectPlanContinuationSteerText(
  paths: ReturnType<typeof runPaths>,
  goal: GoalFile,
  plan: string,
  continuationReason: string
): Promise<string> {
  const ledger = await readLedger(paths);
  const recentLedger = ledger.slice(-5).map((entry) => ({
    iter: entry.iter,
    step_id: entry.step_id,
    status: entry.status,
    step_done: entry.guards.step_done,
    tests_pass: entry.guards.tests_pass,
    reflection: entry.reflection
  }));
  const contextText = await readContextForPrompt(paths);
  const assumptionsText = await readOptionalText(paths.assumptions);
  const lessonsText = formatLessonsForPrompt(await readRecentLessons(paths));
  return [
    'The direct executor exhausted the current PLAN.md: there are no pending or active executable steps, but the user has not explicitly stopped the run.',
    'Do not mark the overall run complete solely because the current plan is exhausted.',
    `The continue-biased completion gate chose to continue: ${continuationReason}`,
    'Read GOAL.md, PLAN.md, ASSUMPTIONS.md, lessons, and recent ledger/context below, then derive the next concrete high-value executable step that advances the active goal.',
    'Deepen quality within the fixed user scope. You may refine acceptance evidence, quality thresholds, validation rigor, boundary statements, and goal wording that remain within the existing requirement.',
    'Do not invent new product scope, features, deployments, benchmarks, or user requirements. New scope may only come from user Chat or hot-reload injections.',
    'Append or update PLAN.md with that next step and leave it pending. Keep prior completed steps intact.',
    'Update ASSUMPTIONS.md when new evidence changes an assumption, a risk has been retired, or a user steer overrides planner reasoning. If assumptions do not change, preserve the existing file.',
    'Only produce no executable step if the goal is concretely blocked and PLAN.md should explain the blocker.',
    '',
    `Active requirement summary: ${requirementText(goal) || 'see GOAL.md'}`,
    '',
    `Current ASSUMPTIONS.md:\n${assumptionsText || '(missing)'}`,
    '',
    `Current PLAN.md:\n${plan}`,
    '',
    `Recent ledger rows:\n${JSON.stringify(recentLedger, null, 2)}`,
    '',
    `Lessons:\n${lessonsText || '(none)'}`,
    '',
    `Context:\n${contextText}`
  ].join('\n');
}

async function readOptionalText(path: string): Promise<string> {
  return (await exists(path)) ? readFile(path, 'utf8') : '';
}

function requirementText(goal: GoalFile): string {
  return goal.requirements
    .filter((req) => req.status === 'active')
    .map((req) => req.text)
    .join(' ');
}

async function applyDirectPendingInjections(
  paths: ReturnType<typeof runPaths>,
  goal: GoalFile,
  checkpoint: Checkpoint,
  config: WiCiConfig,
  events: EventWriter
): Promise<{ goal: GoalFile; checkpoint: Checkpoint; steerText?: string; stop?: SupervisorResult }> {
  const injections = await drainInbox(paths, checkpoint.drained_inbox);
  if (injections.length === 0) return { goal, checkpoint };

  const applied = applyInjections(goal, injections);
  goal = applied.goal;
  const steerText = applied.steerText;
  const drainedIds = injectionIds(injections);
  checkpoint = {
    ...checkpoint,
    drained_inbox: [...checkpoint.drained_inbox, ...drainedIds],
    goal_version: goal.version
  };
  for (const answer of injections.filter((item) => item.kind === 'answer' && item.reply_to)) {
    const marked = await markOutboxAnswered(paths, answer.reply_to!, answer.text);
    await events.emit('OUTBOX_ANSWERED', `Applied answer for ${answer.reply_to}`, {
      reply_to: answer.reply_to,
      outbox_id: marked?.id ?? null
    });
  }
  await saveGoalFiles(paths, goal);
  await events.emit(
    'INJECTION_DRAINED',
    `Applied ${drainedIds.length} chat injection(s)`,
    injections.map((item) => ({ id: item.id, ids: item.coalesced_ids ?? [item.id], kind: item.kind, mode: 'direct' }))
  );
  if (applied.aborted) {
    checkpoint = {
      ...checkpoint,
      supervisor_state: 'STOP',
      ledger_seq: await lineCount(paths.ledger),
      events_seq: events.seq,
      plan_hash: await hashFile(paths.plan)
    };
    await saveCheckpoint(paths, checkpoint);
    await writeOutbox(paths, { kind: 'info', text: 'Urgent abort injection requested stop' });
    await events.emit('STOP', 'Urgent abort injection requested stop', undefined, 'warn');
    return { goal, checkpoint, steerText, stop: { state: 'STOP', reason: 'urgent abort injection', iter: checkpoint.iter } };
  }

  checkpoint = {
    ...checkpoint,
    supervisor_state: 'PLAN',
    ledger_seq: await lineCount(paths.ledger),
    events_seq: events.seq,
    plan_hash: await hashFile(paths.plan)
  };
  await saveCheckpoint(paths, checkpoint);
  const diff = await runPlanDiff(
    paths,
    goal,
    checkpoint.sessions.planner,
    steerText ?? '',
    config,
    (progress) => emitPlannerUsage(events, progress, { phase: 'direct_plan_diff' }),
    (retry) => emitPlannerRetry(events, retry, { phase: 'direct_plan_diff' }),
    () => hasPendingUrgentAbort(paths, checkpoint)
  );
  const stoppedForAbort = await stopIfPlannerAborted(paths, goal, checkpoint, events, diff);
  if (stoppedForAbort) {
    return { goal: stoppedForAbort.goal, checkpoint: stoppedForAbort.checkpoint, steerText, stop: stoppedForAbort.result };
  }
  const waitingForPlanner = await stopForPlannerDiffClarification(paths, events, goal, checkpoint, diff);
  if (waitingForPlanner) {
    return { goal, checkpoint, steerText, stop: { state: 'STOP', reason: PLANNER_CLARIFY_WAIT_REASON, iter: waitingForPlanner.iter } };
  }
  if (!diff.ok) throw new Error(diff.error ?? 'Planner did not update PLAN.md');
  checkpoint = {
    ...checkpoint,
    sessions: {
      ...checkpoint.sessions,
      planner: diff.sessionId ?? checkpoint.sessions.planner
    },
    plan_hash: await hashFile(paths.plan)
  };
  await events.emit('PLAN_DIFF_APPLIED', 'Planner updated PLAN.md for new input', { steerText, mode: 'direct' });
  return { goal, checkpoint, steerText };
}

async function runDirectExecutorWithHotReload(input: {
  paths: ReturnType<typeof runPaths>;
  goal: GoalFile;
  checkpoint: Checkpoint;
  stepId: string;
  iter: number;
  config: WiCiConfig;
  events: EventWriter;
  steerText?: string;
  contextText?: string;
}): Promise<{
  goal: GoalFile;
  checkpoint: Checkpoint;
  steerText?: string;
  result?: IterResult & { invocation: ToolInvocationResult };
  executorApp?: NonNullable<Checkpoint['sessions']['executorApp']>;
  stop?: SupervisorResult;
}> {
  let goal = input.goal;
  let checkpoint = input.checkpoint;
  let steerText = input.steerText;
  let lastExecutorSessionWriteAt = 0;
  const controller = await startExecutorStep(input.paths, goal, input.stepId, input.iter, input.config, checkpoint, steerText, input.contextText, {
    onProgress: async (progress) => {
      const now = Date.now();
      await input.events.emit('EXECUTE_PROGRESS', formatExecutorProgress(progress), {
        iter: input.iter,
        step_id: input.stepId,
        mode: 'direct',
        progress
      });
      if (checkpoint.sessions.executorApp && now - lastExecutorSessionWriteAt > 5_000) {
        lastExecutorSessionWriteAt = now;
        checkpoint = {
          ...checkpoint,
          updated_at: new Date(now).toISOString(),
          sessions: {
            ...checkpoint.sessions,
            executorApp: {
              ...checkpoint.sessions.executorApp,
              workspace: input.paths.target,
              lastActivityAt: new Date(now).toISOString(),
              updatedAt: new Date(now).toISOString(),
              phase: 'running',
              lastEventType: progress.eventType
            }
          }
        };
        await saveCheckpoint(input.paths, checkpoint);
      }
    },
    onBackendFallback: async (fallback) => {
      await input.events.emit(
        'EXECUTE_APP_SERVER_FALLBACK',
        `Codex app-server ${fallback.phase === 'start' ? 'could not start' : 'turn became unusable'}; falling back to codex exec`,
        {
          iter: input.iter,
          step_id: input.stepId,
          mode: 'direct',
          ...fallback
        },
        'warn'
      );
    },
    shouldPreempt: () => hasPendingChatInput(input.paths, checkpoint)
  });

  if (controller.backend === 'app-server' && controller.threadId) {
    checkpoint = {
      ...checkpoint,
      updated_at: new Date().toISOString(),
      sessions: {
        ...checkpoint.sessions,
        executorApp: {
          threadId: controller.threadId,
          activeTurnId: controller.turnId,
          workspace: input.paths.target,
          updatedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          phase: 'running'
        }
      }
    };
    await saveCheckpoint(input.paths, checkpoint);
    await input.events.emit('EXECUTE_APP_SERVER_START', 'Codex app-server turn started', {
      thread_id: controller.threadId,
      turn_id: controller.turnId,
      mode: 'direct'
    });
  }

  if (controller.backend !== 'app-server') {
    const result = await controller.done;
    return { goal, checkpoint, steerText, result };
  }

  while (true) {
    const outcome = await Promise.race([
      controller.done.then((result) => ({ kind: 'done' as const, result })),
      delay(1_000).then(() => ({ kind: 'tick' as const }))
    ]);
    if (outcome.kind === 'done') {
      const executorApp = controller.threadId
        ? {
            threadId: controller.threadId,
            workspace: input.paths.target,
            lastActivityAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            phase: 'idle' as const
          }
        : undefined;
      return { goal, checkpoint, steerText, result: outcome.result, executorApp };
    }

    if (!(await hasPendingChatInput(input.paths, checkpoint))) continue;
    const update = await applyDirectPendingInjections(input.paths, goal, checkpoint, input.config, input.events);
    goal = update.goal;
    checkpoint = update.checkpoint;
    if (update.stop) {
      await controller.interrupt();
      return { goal, checkpoint, steerText: update.steerText ?? steerText, stop: update.stop };
    }
    if (!update.steerText) continue;
    checkpoint = {
      ...checkpoint,
      supervisor_state: 'EXECUTE',
      next_step: input.stepId,
      plan_hash: await hashFile(input.paths.plan),
      ledger_seq: await lineCount(input.paths.ledger),
      events_seq: input.events.seq
    };
    await saveCheckpoint(input.paths, checkpoint);
    const steerPrompt = buildActiveTurnSteerPrompt(update.steerText);
    const steered = await controller.steer(steerPrompt);
    if (steered) {
      steerText = undefined;
      await input.events.emit('EXECUTE_STEERED', 'Steered active Codex app-server turn with updated GOAL.md and PLAN.md', {
        thread_id: controller.threadId,
        turn_id: controller.turnId,
        mode: 'direct',
        steerText: update.steerText
      });
    } else {
      steerText = update.steerText;
      await input.events.emit('EXECUTE_STEER_DEFERRED', 'Active Codex turn could not be steered; carrying update into the next turn', {
        thread_id: controller.threadId,
        turn_id: controller.turnId,
        mode: 'direct',
        steerText
      }, 'warn');
    }
  }
}

function buildActiveTurnSteerPrompt(steerText: string): string {
  return [
    'WiCi hot reload update:',
    steerText,
    '',
    'GOAL.md and PLAN.md have been updated on disk. Re-read both files before making further changes.',
    'Continue the current task in this same workspace and preserve useful completed work.',
    'Apply only the necessary changes implied by the updated goal/plan, then continue toward the existing result JSON receipt.'
  ].join('\n');
}

export function resolveMaxIters(explicitMaxIters: number | undefined, configuredMaxIters: number): number {
  if (explicitMaxIters !== undefined) return explicitMaxIters;
  return configuredMaxIters > 0 ? configuredMaxIters : Number.POSITIVE_INFINITY;
}

function maxItersLabel(maxIters: number): string {
  return Number.isFinite(maxIters) ? String(maxIters) : 'unbounded';
}

function directLedgerEntry(args: {
  iter: number;
  stepId: string;
  status: LedgerEntry['status'];
  commit: string | null;
  wallMs: number;
  usage?: ToolUsageSummary;
  notes: string;
  stepDone: boolean;
  testsPass: boolean;
  changedFiles: string[];
  metric?: MetricStats | null;
  baseline?: MetricStats | null;
  deltaPct?: number | null;
}): LedgerEntry {
  return {
    id: `iter-${args.iter}`,
    ts: new Date().toISOString(),
    iter: args.iter,
    step_id: args.stepId,
    commit: args.commit,
    hypothesis: `Execute PLAN.md step ${args.stepId}`,
    metric: args.metric ?? null,
    baseline: args.baseline ?? null,
    delta_pct: args.deltaPct ?? null,
    confidence: args.metric ? 'direct-measure' : 'direct-executor-receipt',
    ci_low: null,
    ci_high: null,
    p_value: null,
    cost: {
      wall_ms: args.wallMs,
      ...(args.usage?.tokens_input !== undefined ? { tokens_input: args.usage.tokens_input } : {}),
      ...(args.usage?.tokens_output !== undefined ? { tokens_output: args.usage.tokens_output } : {}),
      ...(args.usage?.usd !== undefined ? { usd: args.usage.usd } : {})
    },
    guards: {
      direct: true,
      step_done: args.stepDone,
      tests_pass: args.testsPass,
      changed_files: args.changedFiles.length,
      reason: args.notes.slice(0, 240)
    },
    status: args.status,
    reflection: args.notes,
    parent_id: null
  };
}

function previousKeepMetric(ledger: LedgerEntry[]): MetricStats | null {
  return [...ledger].reverse().find((entry) => entry.status === 'keep' && entry.metric)?.metric ?? null;
}

function directMetricDeltaPct(base: MetricStats, next: MetricStats, direction: GoalFile['metric']['direction']): number {
  const before = primaryMetricValue(base);
  const after = primaryMetricValue(next);
  if (before === 0) return after === 0 ? 0 : direction === 'minimize' ? -1 : 1;
  return direction === 'minimize' ? (before - after) / before : (after - before) / Math.abs(before);
}

async function ensureGoal(paths: ReturnType<typeof runPaths>, text: string | undefined, config: WiCiConfig, planningContext?: string): Promise<GoalFile> {
  const existing = await readJsonFileMaybe<GoalFile>(paths.goal);
  if (existing) {
    await ensureGoalDoc(paths, existing);
    return existing;
  }
  if (!text?.trim()) {
    throw new Error(INITIAL_GOAL_REQUIRED_MESSAGE);
  }
  const initialText = text.trim();
  const constraints = ['Keep GOAL.md and PLAN.md as the source of truth.', 'Commit confirmed progress and keep rollback available.'];
  if (planningContext?.trim()) {
    constraints.push(`Chat context before planning:\n${planningContext.trim()}`);
  }
  const goal: GoalFile = {
    run_id: `run-${Date.now()}`,
    version: 1,
    requirements: [
      {
        id: 'R1',
        text: initialText,
        source: 'initial',
        status: 'active'
      }
    ],
    acceptance_criteria: [],
    constraints,
    metric: {
      name: PLANNER_SELECTED_METRIC,
      direction: 'maximize',
      target: null,
      unit: undefined
    },
    budget: config.budget,
    stop: config.stop
  };
  await saveGoalFiles(paths, goal);
  return goal;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recoverySteerText(stepId: string, iter: number, reason: string): string {
  return [
    `Previous executor attempt ${iter} for ${stepId} failed: ${reason}`,
    'Continue the same GOAL.md rather than blocking.',
    'First diagnose logs, process state, remote state, and changed files.',
    'If PLAN.md or .opt scripts caused the failure, update them before retrying.',
    'If a long command is needed, run it with visible progress or log tailing so the TUI receives output.',
    'Do not repeat the exact same silent failing command unless you can justify why conditions changed.'
  ].join('\n');
}

async function ensurePlanAndLegacyBaselineState(
  paths: ReturnType<typeof runPaths>,
  goal: GoalFile,
  config: WiCiConfig,
  events: EventWriter,
  checkpoint: Checkpoint
): Promise<{ baseline: BaselineFile | null; waitReason: string; checkpoint: Checkpoint; goal: GoalFile }> {
  let createdSetup = false;
  let plannerResume: PlannerClarificationResume | undefined;
  const plannerClarification = await drainPlannerClarificationAnswer(paths, goal, checkpoint, events);
  goal = plannerClarification.goal;
  checkpoint = plannerClarification.checkpoint;
  plannerResume = plannerClarification.resume;
  if (plannerClarification.waiting) {
    return { baseline: null, waitReason: PLANNER_CLARIFY_WAIT_REASON, checkpoint, goal };
  }

  const hasPlan = await exists(paths.plan);
  if (!hasPlan) {
    await unlockEvalScripts(paths);
    checkpoint = await saveSetupCheckpoint(paths, checkpoint, goal, events, 'PLAN');
    await events.emit('PLAN_START', 'Planner is materializing PLAN.md and optional validation scripts');
    let result: Awaited<ReturnType<typeof runInitialPlanner>>;
    try {
      result = await runInitialPlanner(
        paths,
        goal,
        config,
        (progress) => emitPlannerUsage(events, progress, { phase: plannerResume ? 'initial_resume' : 'initial' }),
        (retry) => emitPlannerRetry(events, retry, { phase: plannerResume ? 'initial_resume' : 'initial' }),
        plannerResume,
        () => hasPendingUrgentAbort(paths, checkpoint)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await events.emit('PLAN_FAILED', message, undefined, 'error');
      throw error;
    }
    if (result.aborted) {
      const stopped = await stopForUrgentAbort(paths, goal, checkpoint, events);
      return { baseline: null, waitReason: URGENT_ABORT_REASON, checkpoint: stopped.checkpoint, goal: stopped.goal };
    }
    if (result.needsInput) {
      checkpoint = {
        ...checkpoint,
        sessions: {
          ...checkpoint.sessions,
          planner: result.sessionId ?? checkpoint.sessions.planner
        },
        events_seq: events.seq
      };
      await saveCheckpoint(paths, checkpoint);
      await ensurePlannerQuestion(paths, events, goal, result.needsInput);
      checkpoint = {
        ...checkpoint,
        events_seq: events.seq
      };
      await saveCheckpoint(paths, checkpoint);
      return { baseline: null, waitReason: PLANNER_CLARIFY_WAIT_REASON, checkpoint, goal };
    }
    if (!result.ok) {
      throw new Error(result.error ?? 'Planner did not materialize PLAN.md');
    }
    goal = (await readJsonFileMaybe<GoalFile>(paths.goal)) ?? goal;
    checkpoint = {
      ...checkpoint,
      sessions: {
        ...checkpoint.sessions,
        planner: result.sessionId ?? checkpoint.sessions.planner
      },
      plan_hash: await hashFile(paths.plan),
      events_seq: events.seq
    };
    await saveCheckpoint(paths, checkpoint);
    await events.emit('PLAN_DONE', 'Planner materialized PLAN.md and optional validation scripts', {
      sessionId: result.sessionId,
      stdout_artifact: `.wici/artifacts/planner-${plannerResume ? 'initial-resume' : 'initial'}.stdout.jsonl`
    });
    checkpoint = {
      ...checkpoint,
      events_seq: events.seq
    };
    await saveCheckpoint(paths, checkpoint);
    if (await exists(paths.benchmarkManifest)) {
      const benchmark = await readBenchmarkManifest(paths);
      await events.emit('BENCHMARK_SELECTED', 'Planner-generated benchmark note is available in .opt/benchmark.json', {
        tool: benchmark.tool,
        command: benchmark.command,
        metric: benchmark.metric,
        direction: benchmark.direction,
        target: benchmark.target,
        unit: benchmark.unit,
        source: 'planner'
      });
    }
    createdSetup = true;
  } else {
    if (plannerResume) {
      checkpoint = await saveSetupCheckpoint(paths, checkpoint, goal, events, 'PLAN');
      await events.emit('PLAN_START', 'Planner is resuming PLAN.md update after Chat clarification');
      const diff = await runPlanDiff(
        paths,
        goal,
        plannerResume.sessionId ?? checkpoint.sessions.planner,
        `Planner clarification answer:\nQuestion: ${plannerResume.question ?? '(not recorded)'}\nAnswer:\n${plannerResume.answer}`,
        config,
        (progress) => emitPlannerUsage(events, progress, { phase: 'plan_diff_resume' }),
        (retry) => emitPlannerRetry(events, retry, { phase: 'plan_diff_resume' }),
        () => hasPendingUrgentAbort(paths, checkpoint)
      );
      const stoppedForAbort = await stopIfPlannerAborted(paths, goal, checkpoint, events, diff);
      if (stoppedForAbort) {
        return { baseline: null, waitReason: URGENT_ABORT_REASON, checkpoint: stoppedForAbort.checkpoint, goal: stoppedForAbort.goal };
      }
      const waitingForPlanner = await stopForPlannerDiffClarification(paths, events, goal, checkpoint, diff);
      if (waitingForPlanner) {
        return { baseline: null, waitReason: PLANNER_CLARIFY_WAIT_REASON, checkpoint: waitingForPlanner, goal };
      }
      if (!diff.ok) throw new Error(diff.error ?? 'Planner did not update PLAN.md');
      checkpoint = {
        ...checkpoint,
        sessions: {
          ...checkpoint.sessions,
          planner: diff.sessionId ?? checkpoint.sessions.planner
        },
        plan_hash: await hashFile(paths.plan),
        events_seq: events.seq
      };
      await saveCheckpoint(paths, checkpoint);
      await events.emit('PLAN_DIFF_APPLIED', 'Planner updated PLAN.md after Chat clarification', {
        mode: 'clarification_resume'
      });
    }
    if (await exists(paths.benchmarkManifest)) {
      const benchmark = await readBenchmarkManifest(paths);
      await events.emit('BENCHMARK_SELECTED', 'Using existing planner-generated benchmark note from .opt/benchmark.json', {
        tool: benchmark.tool,
        command: benchmark.command,
        metric: benchmark.metric,
        direction: benchmark.direction,
        target: benchmark.target,
        unit: benchmark.unit,
        source: 'existing'
      });
    }
    if (config.evaluation.legacy_optimizer === true && (await exists(paths.baseline))) {
      await chmod(paths.measure, 0o555).catch(() => undefined);
      await chmod(paths.checks, 0o555).catch(() => undefined);
      await chmod(paths.benchmarkManifest, 0o444).catch(() => undefined);
    }
  }

  const legacyBaselineExists = await exists(paths.baseline);
  const legacyOptimizerEnabled = config.evaluation.legacy_optimizer === true;
  if (legacyBaselineExists && !legacyOptimizerEnabled) {
    await events.emit('LEGACY_BASELINE_IGNORED', 'Existing baseline.json ignored; fresh V1 executes PLAN.md directly unless legacy optimizer is explicitly enabled', {
      baseline: 'baseline.json'
    });
  }
  let baseline: BaselineFile | null = legacyOptimizerEnabled ? await readJsonFileMaybe<BaselineFile>(paths.baseline) : null;
  if (!baseline && !legacyOptimizerEnabled) {
    let directBestCommit = checkpoint.best_commit ?? await currentCommitOrNull(paths);
    if (!createdSetup && (await hasChanges(paths))) {
      await events.emit('DIRTY_TARGET_ON_START', 'Existing target has uncommitted changes; direct execution will leave rollback decisions to git history', undefined, 'warn');
    }
    checkpoint = {
      ...checkpoint,
      supervisor_state: 'EXECUTE',
      goal_version: goal.version,
      plan_hash: await hashFile(paths.plan),
      best_commit: directBestCommit,
      ledger_seq: await lineCount(paths.ledger),
      events_seq: events.seq
    };
    await saveCheckpoint(paths, checkpoint);
    if (checkpoint.iter === 0 && !(await exists(iterationSnapshotPath(paths, 0)))) {
      const headCommit = await currentCommit(paths);
      await saveIterationSnapshot(paths, checkpoint, goal, {
        headCommit,
        bestCommit: directBestCommit
      });
    }
    return { baseline: null, waitReason: 'PLAN_READY', checkpoint, goal };
  }

  if (!baseline && config.evaluation.lock_mode === 'manual') {
    ({ goal, checkpoint } = await drainEvalLockAnswers(paths, goal, checkpoint, events));
  }
  if (legacyOptimizerEnabled && goal.acceptance_criteria.length === 0) {
    goal = {
      ...goal,
      acceptance_criteria: [
        {
          id: 'A1',
          text: 'Legacy optimizer checks pass before any measured result is accepted.',
          check: './.opt/checks.sh'
        },
        {
          id: 'A2',
          text: 'Legacy optimizer measurement runs before any measured result is accepted.',
          check: './.opt/measure.sh'
        }
      ]
    };
    await saveGoalFiles(paths, goal);
    createdSetup = true;
  }

  const acceptance = await ensureAcceptanceSpec(paths, goal);
  if (!acceptance.ok) {
    await ensureAcceptanceSpecQuestion(paths, events, acceptance.reason ?? 'Acceptance criteria need clarification.');
    return { baseline: null, waitReason: ACCEPTANCE_SPEC_WAIT_REASON, checkpoint, goal };
  }
  if (acceptance.created) {
    createdSetup = true;
    await events.emit('ACCEPTANCE_SPEC_FROZEN', 'Frozen machine-checkable acceptance criteria in acceptance.spec.json', {
      criteria: acceptance.spec?.criteria.map((criterion) => ({ id: criterion.id, check: criterion.check })) ?? []
    });
  }

  if (!baseline) {
    if (config.evaluation.lock_mode === 'manual' && !hasEvalLockApproval(goal)) {
      await ensureEvalLockQuestion(paths, events);
      return { baseline: null, waitReason: EVAL_LOCK_WAIT_REASON, checkpoint, goal };
    }
    checkpoint = await saveSetupCheckpoint(paths, checkpoint, goal, events, 'MEASURE');
    await events.emit('BASELINE_START', 'Running checks and measure to initialize legacy optimizer baseline');
    baseline = await initializeBaseline(paths, goal, config);
    await events.emit('BASELINE_DONE', 'Initialized legacy optimizer baseline metric', baseline.best_metric);
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

  return { baseline, waitReason: '', checkpoint, goal };
}

async function saveSetupCheckpoint(
  paths: ReturnType<typeof runPaths>,
  checkpoint: Checkpoint,
  goal: GoalFile,
  events: EventWriter,
  state: 'PLAN' | 'MEASURE'
): Promise<Checkpoint> {
  const next = {
    ...checkpoint,
    supervisor_state: state,
    goal_version: goal.version,
    plan_hash: await hashFile(paths.plan),
    ledger_seq: await lineCount(paths.ledger),
    events_seq: events.seq
  };
  await saveCheckpoint(paths, next);
  return next;
}

async function drainPlannerClarificationAnswer(
  paths: ReturnType<typeof runPaths>,
  goal: GoalFile,
  checkpoint: Awaited<ReturnType<typeof loadCheckpoint>>,
  events: EventWriter
): Promise<{ goal: GoalFile; checkpoint: Awaited<ReturnType<typeof loadCheckpoint>>; resume?: PlannerClarificationResume; waiting: boolean }> {
  const pending = await pendingPlannerQuestion(paths);
  if (!pending?.reply_key) return { goal, checkpoint, waiting: false };

  const injections = await drainInbox(paths, checkpoint.drained_inbox, 8, ['answer'], pending.reply_key);
  if (injections.length === 0) return { goal, checkpoint, waiting: true };

  const pendingTs = Date.parse(pending.ts);
  const fresh = injections.filter((item) => Date.parse(item.ts) >= pendingTs);
  const stale = injections.filter((item) => !fresh.includes(item));
  const applied = fresh.length > 0 ? applyInjections(goal, fresh) : { goal, steerText: undefined, aborted: false };
  const nextCheckpoint = {
    ...checkpoint,
    drained_inbox: [...checkpoint.drained_inbox, ...injectionIds(injections)],
    goal_version: applied.goal.version
  };

  if (fresh.length > 0) {
    const answerText = fresh.map((item) => item.text).join('\n');
    const marked = await markOutboxAnswered(paths, pending.reply_key, answerText);
    await events.emit('OUTBOX_ANSWERED', `Applied planner clarification for ${pending.reply_key}`, {
      reply_to: pending.reply_key,
      outbox_id: marked?.id ?? null
    });
    await saveGoalFiles(paths, applied.goal);
    await events.emit(
      'INJECTION_DRAINED',
      `Applied ${fresh.length} planner clarification answer(s)`,
      injections.map((item) => ({ id: item.id, kind: item.kind, reply_to: item.reply_to, fresh: fresh.includes(item) }))
    );
    await saveCheckpoint(paths, nextCheckpoint);
    const data = plannerQuestionData(pending.data);
    return {
      goal: applied.goal,
      checkpoint: nextCheckpoint,
      waiting: false,
      resume: {
        sessionId: data.sessionId ?? checkpoint.sessions.planner,
        question: data.question ?? pending.text,
        answer: answerText
      }
    };
  }

  if (stale.length > 0) {
    await events.emit(
      'PLANNER_CLARIFY_ANSWER_IGNORED',
      'Ignored planner clarification answer written before the question',
      stale.map((item) => ({ id: item.id, ts: item.ts, question_ts: pending.ts })),
      'warn'
    );
  }
  await saveCheckpoint(paths, nextCheckpoint);
  return { goal, checkpoint: nextCheckpoint, waiting: true };
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
  await saveGoalFiles(paths, applied.goal);
  await events.emit(
    'INJECTION_DRAINED',
    fresh.length > 0 ? `Applied ${fresh.length} eval lock answer(s)` : `Drained ${stale.length} stale eval lock answer(s)`,
    injections.map((item) => ({ id: item.id, kind: item.kind, reply_to: item.reply_to, fresh: fresh.includes(item) }))
  );
  await saveCheckpoint(paths, nextCheckpoint);
  return { goal: applied.goal, checkpoint: nextCheckpoint };
}

async function handlePendingStopQuestion(
  paths: ReturnType<typeof runPaths>,
  checkpoint: Checkpoint,
  events: EventWriter
): Promise<{ action: 'proceed' | 'wait' | 'stop'; reason: string; checkpoint: Checkpoint }> {
  if (checkpoint.supervisor_state !== 'STOP') return { action: 'proceed', reason: 'not stopped', checkpoint };
  const pending = await pendingStopQuestion(paths);
  if (!pending?.reply_key) return { action: 'proceed', reason: 'no pending stop question', checkpoint };
  const continuationStall = pending.reply_key.startsWith(CONTINUATION_STALL_REPLY_PREFIX);

  const questionTs = Date.parse(pending.ts);
  const pendingInputs = (await readPendingInjections(paths, checkpoint.drained_inbox, ['answer', 'add_requirement', 'steer']))
    .filter((item) => Date.parse(item.ts) > questionTs)
    .filter((item) => item.kind !== 'answer' || item.reply_to === pending.reply_key);

  if (pendingInputs.length === 0) {
    await events.emit('STOP', STOP_ANSWER_WAIT_REASON, { reply_key: pending.reply_key, outbox_id: pending.id });
    const next = { ...checkpoint, events_seq: events.seq };
    await saveCheckpoint(paths, next);
    return { action: 'wait', reason: STOP_ANSWER_WAIT_REASON, checkpoint: next };
  }

  const first = pendingInputs[0];
  if (first.kind === 'answer' && isStopApproval(first.text)) {
    const drained = await drainPendingInjectionsById(paths, checkpoint.drained_inbox, [first.id]);
    const marked = await markOutboxAnswered(paths, pending.reply_key, first.text);
    await events.emit('OUTBOX_ANSWERED', `Applied stop answer for ${pending.reply_key}`, {
      reply_to: pending.reply_key,
      outbox_id: marked?.id ?? null
    });
    await events.emit(
      'INJECTION_DRAINED',
      `Applied ${drained.length} stop answer(s)`,
      drained.map((item) => ({ id: item.id, kind: item.kind, reply_to: item.reply_to }))
    );
    const next = {
      ...checkpoint,
      drained_inbox: [...checkpoint.drained_inbox, ...injectionIds(drained)],
      consecutive_continuation_fallbacks: continuationStall ? 0 : checkpoint.consecutive_continuation_fallbacks,
      consecutive_duplicate_continuation_steps: continuationStall ? 0 : checkpoint.consecutive_duplicate_continuation_steps,
      events_seq: events.seq
    };
    await saveCheckpoint(paths, next);
    const reason = `User accepted stop candidate: ${first.text}`;
    await writeOutbox(paths, { kind: 'info', text: reason, data: { reply_key: pending.reply_key, outbox_id: pending.id } });
    await events.emit('STOP', reason);
    return { action: 'stop', reason, checkpoint: { ...next, events_seq: events.seq } };
  }

  const marked = await markOutboxAnswered(paths, pending.reply_key, `${first.kind}: ${first.text}`);
  await events.emit('OUTBOX_ANSWERED', `Resuming from stop question ${pending.reply_key}`, {
    reply_to: pending.reply_key,
    outbox_id: marked?.id ?? null,
    via: first.kind
  });
  const next = {
    ...checkpoint,
    consecutive_continuation_fallbacks: continuationStall ? 0 : checkpoint.consecutive_continuation_fallbacks,
    consecutive_duplicate_continuation_steps: continuationStall ? 0 : checkpoint.consecutive_duplicate_continuation_steps,
    events_seq: events.seq
  };
  await saveCheckpoint(paths, next);
  return { action: 'proceed', reason: `resume requested via ${first.kind}`, checkpoint: next };
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

async function ensurePlannerQuestion(
  paths: ReturnType<typeof runPaths>,
  events: EventWriter,
  goal: GoalFile,
  question: PlannerQuestion
): Promise<void> {
  const pending = await pendingPlannerQuestion(paths);
  if (pending) {
    await events.emit('PLANNER_CLARIFY_REQUIRED', 'Waiting for existing planner clarification', {
      reply_key: pending.reply_key,
      outbox_id: pending.id,
      session_id: plannerQuestionData(pending.data).sessionId
    });
    return;
  }

  const replyKey = `${PLANNER_CLARIFY_REPLY_PREFIX}v${goal.version}-${Date.now()}`;
  const message = await writeOutbox(paths, {
    kind: 'question',
    text: `Planner needs clarification before producing PLAN.md. ${question.question}`,
    replyKey,
    data: {
      sessionId: question.session_id,
      planner_question: question.question,
      questions: question.questions,
      reason: question.reason
    }
  });
  await events.emit('PLANNER_CLARIFY_REQUIRED', 'Planner needs clarification before producing PLAN.md', {
    reply_key: replyKey,
    outbox_id: message.id,
    session_id: question.session_id,
    reason: question.reason
  }, 'warn');
}

async function stopForPlannerDiffClarification(
  paths: ReturnType<typeof runPaths>,
  events: EventWriter,
  goal: GoalFile,
  checkpoint: Checkpoint,
  diff: Awaited<ReturnType<typeof runPlanDiff>>
): Promise<Checkpoint | null> {
  if (!diff.needsInput) return null;
  let next = {
    ...checkpoint,
    supervisor_state: 'STOP' as const,
    sessions: {
      ...checkpoint.sessions,
      planner: diff.sessionId ?? checkpoint.sessions.planner
    },
    goal_version: goal.version,
    ledger_seq: await lineCount(paths.ledger),
    events_seq: events.seq,
    plan_hash: await hashFile(paths.plan)
  };
  await saveCheckpoint(paths, next);
  await ensurePlannerQuestion(paths, events, goal, diff.needsInput);
  await events.emit('STOP', PLANNER_CLARIFY_WAIT_REASON, {
    session_id: diff.sessionId ?? checkpoint.sessions.planner
  });
  next = {
    ...next,
    events_seq: events.seq
  };
  await saveCheckpoint(paths, next);
  return next;
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
    text: `Acceptance criteria must be machine-checkable before the loop can run. ${reason} Reply with concrete checks for GOAL.md.`,
    replyKey: ACCEPTANCE_CLARIFY_REPLY_KEY,
    data: {
      reason,
      goal: 'GOAL.md',
      expected_shape: 'machine-checkable acceptance criteria with explicit check commands'
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

async function pendingPlannerQuestion(paths: ReturnType<typeof runPaths>) {
  return [...(await readOutbox(paths, 100))]
    .reverse()
    .find((message) => message.reply_key?.startsWith(PLANNER_CLARIFY_REPLY_PREFIX) && !message.answered);
}

async function pendingStopQuestion(paths: ReturnType<typeof runPaths>) {
  return (await readOutbox(paths, 50)).find((message) => isStopQuestionReplyKey(message.reply_key) && !message.answered);
}

function isStopQuestionReplyKey(replyKey: string | undefined): boolean {
  return Boolean(replyKey?.startsWith('stop-') || replyKey?.startsWith(CONTINUATION_STALL_REPLY_PREFIX));
}

function continuationFallbackThreshold(): number {
  const parsed = Number(process.env.WICI_CONTINUATION_FALLBACK_THRESHOLD?.trim() ?? '');
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 3;
}

function stepDedupRecentWindow(): number {
  const parsed = Number(process.env.WICI_STEP_DEDUP_RECENT_WINDOW?.trim() ?? '');
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 8;
}

function stepDedupSimilarityThreshold(): number {
  const parsed = Number(process.env.WICI_STEP_DEDUP_SIMILARITY?.trim() ?? '');
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.78;
}

function stepDedupConsecutiveThreshold(): number {
  const parsed = Number(process.env.WICI_STEP_DEDUP_CONSECUTIVE?.trim() ?? '');
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function plannerQuestionData(data: unknown): { sessionId?: string; question?: string } {
  if (!data || typeof data !== 'object') return {};
  const record = data as Record<string, unknown>;
  return {
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
    question: typeof record.planner_question === 'string' ? record.planner_question : undefined
  };
}

function isStopApproval(text: string): boolean {
  return /\b(stop|stopped|approve|approved|yes|ok|accept|accepted)\b/i.test(text);
}

async function currentCommitOrNull(paths: ReturnType<typeof runPaths>): Promise<string | null> {
  const commit = await currentCommit(paths);
  return commit === 'NO_HEAD' ? null : commit;
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

async function recoverIncompleteDirectAttempt(
  paths: ReturnType<typeof runPaths>,
  checkpoint: Awaited<ReturnType<typeof loadCheckpoint>>,
  events: EventWriter
): Promise<Awaited<ReturnType<typeof loadCheckpoint>>> {
  const inFlightStates = new Set(['PLAN', 'EXECUTE', 'REFLECT']);
  if (!inFlightStates.has(checkpoint.supervisor_state)) return checkpoint;

  if (await hasChanges(paths)) {
    const bestCommit = checkpoint.best_commit ?? 'NO_HEAD';
    await revertToBest(paths, bestCommit);
    if (checkpoint.next_step) {
      await setPlanStepStatus(paths, checkpoint.next_step, 'pending');
    }
    await events.emit('RECOVER_REVERT', 'Reverted unconfirmed direct-path work to the last WiCi checkpoint', {
      state: checkpoint.supervisor_state,
      best_commit: checkpoint.best_commit ?? null,
      step_id: checkpoint.next_step,
      mode: 'direct'
    }, 'warn');
  } else if (checkpoint.next_step) {
    await setPlanStepStatus(paths, checkpoint.next_step, 'pending');
    await events.emit('RECOVER_REPLAY', 'Reset direct-path active step for replay after interrupted run', {
      state: checkpoint.supervisor_state,
      step_id: checkpoint.next_step,
      mode: 'direct'
    }, 'warn');
  }

  return {
    ...checkpoint,
    supervisor_state: 'EXECUTE',
    iter: checkpoint.ledger_seq,
    next_step: null,
    plan_hash: await hashFile(paths.plan),
    ledger_seq: await lineCount(paths.ledger),
    events_seq: events.seq
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

async function recordActiveBranchOutcome(
  paths: ReturnType<typeof runPaths>,
  checkpoint: Awaited<ReturnType<typeof loadCheckpoint>>,
  ledgerEntry: ReturnType<typeof ledgerFromEvaluation>,
  events: EventWriter
): Promise<Awaited<ReturnType<typeof loadCheckpoint>>> {
  if (!checkpoint.active_branch) return checkpoint;
  const branch = checkpoint.active_branch;
  await events.emit('BRANCH_OUTCOME', branch.parent_id ? `Recorded outcome for branch from ${branch.parent_id}` : 'Recorded outcome for planner-selected branch', {
    parent_id: branch.parent_id,
    ledger_id: ledgerEntry.id,
    status: ledgerEntry.status,
    delta_pct: ledgerEntry.delta_pct,
    reason: branch.reason
  });
  const next = {
    ...checkpoint,
    active_branch: undefined
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

async function hasPendingChatInput(paths: ReturnType<typeof runPaths>, checkpoint: Checkpoint): Promise<boolean> {
  return (await readPendingInjections(paths, checkpoint.drained_inbox)).length > 0;
}

function withLessons(text: string, lessonsText: string): string {
  return lessonsText ? `${text}\n\n${lessonsText}` : text;
}

function formatPlannerUsage(progress: PlannerUsageProgress): string {
  const usage = progress.usage;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const total = usage.total_tokens ?? input + output + cacheRead + cacheCreate;
  const cost = typeof progress.totalCostUsd === 'number' ? ` cost=$${progress.totalCostUsd.toFixed(4)}` : '';
  const web = usage.server_tool_use
    ? ` web=${usage.server_tool_use.web_search_requests ?? 0}/${usage.server_tool_use.web_fetch_requests ?? 0}`
    : '';
  return `Planner tokens total=${total} in=${input} out=${output} cache=${cacheRead + cacheCreate}${web}${cost}`;
}

async function emitPlannerUsage(events: EventWriter, progress: PlannerUsageProgress, extra: Record<string, unknown> = {}): Promise<void> {
  await events.emit('PLAN_USAGE', formatPlannerUsage(progress), { ...progress, ...extra });
}

async function emitPlannerRetry(events: EventWriter, retry: PlannerRetryProgress, extra: Record<string, unknown> = {}): Promise<void> {
  await events.emit('PLAN_RETRY_WAIT', transientRetryMessage('Planner', retry), { ...extra, ...retry }, 'warn');
}

async function hasPendingUrgentAbort(paths: ReturnType<typeof runPaths>, checkpoint: Checkpoint): Promise<boolean> {
  const pending = await readPendingInjections(paths, checkpoint.drained_inbox, ['abort']);
  return pending.some((injection) => injection.priority === 'urgent');
}

async function stopForUrgentAbort(paths: ReturnType<typeof runPaths>, goal: GoalFile, checkpoint: Checkpoint, events: EventWriter): Promise<{
  goal: GoalFile;
  checkpoint: Checkpoint;
  result: SupervisorResult;
}> {
  const drained = await drainInbox(paths, checkpoint.drained_inbox, 8, ['abort']);
  let nextGoal = goal;
  let nextCheckpoint = checkpoint;
  if (drained.length > 0) {
    const applied = applyInjections(goal, drained);
    nextGoal = applied.goal;
    const drainedIds = injectionIds(drained);
    nextCheckpoint = {
      ...checkpoint,
      drained_inbox: [...checkpoint.drained_inbox, ...drainedIds],
      goal_version: nextGoal.version
    };
    await saveGoalFiles(paths, nextGoal);
    await events.emit(
      'INJECTION_DRAINED',
      `Applied ${drainedIds.length} urgent abort injection(s)`,
      drained.map((item) => ({ id: item.id, ids: item.coalesced_ids ?? [item.id], kind: item.kind }))
    );
  }
  nextCheckpoint = {
    ...nextCheckpoint,
    supervisor_state: 'STOP',
    ledger_seq: await lineCount(paths.ledger),
    events_seq: events.seq,
    ...(await exists(paths.plan) ? { plan_hash: await hashFile(paths.plan) } : {})
  };
  await saveCheckpoint(paths, nextCheckpoint);
  await writeOutbox(paths, { kind: 'info', text: 'Urgent abort injection requested stop' });
  await events.emit('STOP', 'Urgent abort injection requested stop', undefined, 'warn');
  return {
    goal: nextGoal,
    checkpoint: nextCheckpoint,
    result: { state: 'STOP', reason: URGENT_ABORT_REASON, iter: nextCheckpoint.iter }
  };
}

async function stopIfPlannerAborted(
  paths: ReturnType<typeof runPaths>,
  goal: GoalFile,
  checkpoint: Checkpoint,
  events: EventWriter,
  plannerResult: PlannerInvocationResult
): Promise<{ goal: GoalFile; checkpoint: Checkpoint; result: SupervisorResult } | null> {
  return plannerResult.aborted ? stopForUrgentAbort(paths, goal, checkpoint, events) : null;
}

function formatExecutorProgress(progress: ExecutorProgress): string {
  const usage = progress.usage;
  const input = usage.tokens_input ?? 0;
  const output = usage.tokens_output ?? 0;
  const tokenText = input || output ? ` tokens in=${input} out=${output}` : '';
  const cost = typeof usage.usd === 'number' ? ` cost=$${usage.usd.toFixed(4)}` : '';
  const idle = ` idle=${Math.round(progress.idleMs / 1000)}s`;
  const wall = ` wall=${Math.round(progress.wallMs / 1000)}s`;
  const counts = `events=${usage.events} turns=${usage.completed_turns} items=${usage.completed_items}`;
  if (progress.kind === 'heartbeat') {
    return `Codex running ${counts}${tokenText}${cost}${wall}${idle}`;
  }
  const event = progress.eventType ? ` ${progress.eventType}` : '';
  return `Codex event${event} ${counts}${tokenText}${cost}${wall}${idle}`;
}
