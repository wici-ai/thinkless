import { readdir, readFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const files = {
    simplified: await readFile('Simplified_PLAN.md', 'utf8'),
    readme: await readFile('README.md', 'utf8'),
    config: await readFile('wici.config.json', 'utf8'),
    packageJson: await readFile('package.json', 'utf8'),
    app: await readFile('src/tui/App.tsx', 'utf8'),
    chat: await readFile('src/tui/ChatPane.tsx', 'utf8'),
    chatAgent: await readFile('src/supervisor/chatAgent.ts', 'utf8'),
    header: await readFile('src/tui/Header.tsx', 'utf8'),
    execPane: await readFile('src/tui/ExecPane.tsx', 'utf8'),
    runtimeSettings: await readFile('src/tui/runtimeSettings.ts', 'utf8'),
    runState: await readFile('src/tui/useRunState.ts', 'utf8'),
    tuiChat: await readFile('src/verify/tui-chat-intake.ts', 'utf8'),
    tuiChatPty: await readFile('src/verify/tui-chat-pty.ts', 'utf8'),
    tuiRealFakeChat: await readFile('src/verify/tui-real-fake-chat.ts', 'utf8'),
    tuiPlannerClarificationPty: await readFile('src/verify/tui-planner-clarification-pty.ts', 'utf8'),
    tuiHotreloadPty: await readFile('src/verify/tui-hotreload-pty.ts', 'utf8'),
    planner: await readFile('src/supervisor/planner.ts', 'utf8'),
    plannerPrompt: await readFile('prompts/planner.md', 'utf8'),
    plannerDiffPrompt: await readFile('prompts/planner-diff.md', 'utf8'),
    chatPrompt: await readFile('prompts/chat.md', 'utf8'),
    continueVerdictPrompt: await readFile('prompts/continue-verdict.md', 'utf8'),
    sharedTypes: await readFile('src/shared/types.ts', 'utf8'),
    goalDocSource: await readFile('src/supervisor/goalDoc.ts', 'utf8'),
    goalInterrogation: await readFile('src/supervisor/goalInterrogation.ts', 'utf8'),
    stopPolicy: await readFile('src/supervisor/stop.ts', 'utf8'),
    executor: await readFile('src/supervisor/executor.ts', 'utf8'),
    supervisor: await readFile('src/supervisor/index.ts', 'utf8'),
    selfupdate: await readFile('src/supervisor/selfupdate.ts', 'utf8'),
    inbox: await readFile('src/supervisor/inbox.ts', 'utf8'),
    context: await readFile('src/supervisor/context.ts', 'utf8'),
    tagGate: await readFile('src/verify/tag-gate.ts', 'utf8'),
    sshEvidence: await readFile('src/verify/ssh-evidence.ts', 'utf8'),
    sshEvidenceCheck: await readFile('src/verify/ssh-evidence-check.ts', 'utf8'),
    canaryRecorder: await readFile('src/release/record-canary.ts', 'utf8'),
    releaseTag: await readFile('src/release/tag.ts', 'utf8'),
    releaseTagVerifier: await readFile('src/verify/release-tag.ts', 'utf8'),
    canaryEvidence: await readFile('src/verify/canary-evidence.ts', 'utf8'),
    secretScan: await readFile('src/verify/secret-scan.ts', 'utf8'),
    v1Slice: await readFile('src/verify/v1-slice.ts', 'utf8'),
    directNoScripts: await readFile('src/verify/direct-no-scripts.ts', 'utf8'),
    existingGoal: await readFile('src/verify/existing-goal.ts', 'utf8'),
    toolCommands: await readFile('src/verify/tool-commands.ts', 'utf8'),
    realMode: await readFile('src/verify/real-mode.ts', 'utf8'),
    goalMetric: await readFile('src/verify/goal-metric.ts', 'utf8'),
    hotreload: await readFile('src/verify/hotreload.ts', 'utf8'),
    appServerFallback: await readFile('src/verify/app-server-fallback.ts', 'utf8'),
    durability: await readFile('src/verify/durability.ts', 'utf8'),
    goalDoc: await readFile('src/verify/goal-doc.ts', 'utf8'),
    plannerClarification: await readFile('src/verify/planner-clarification.ts', 'utf8'),
    noSecrets: await readFile('src/verify/no-secrets.ts', 'utf8')
  };
  const schemas = await readdir('schemas');
  const pkg = JSON.parse(files.packageJson) as { scripts: Record<string, string> };
  const releaseResumeVerifiers = [
    'verify:resume-selector',
    'verify:tui-resume-selector-pty',
    'verify:tui-resume-selector-built',
    'verify:tui-resume-legacy-candidate',
    'verify:tui-resume-current-candidate',
    'verify:tui-resume-interrupted-blocked',
    'verify:tui-resume-interrupted-runnable',
    'verify:tui-resume-command-isolation',
    'verify:tui-resume-planner-context',
    'verify:tui-resume-empty-selector',
    'verify:tui-resume-many-candidates',
    'verify:tui-resume-stale-candidate',
    'verify:tui-resume-stale-agent-state',
    'verify:tui-resume-blocked-then-runnable',
    'verify:tui-resume-cross-target',
    'verify:resume-rerunnable'
  ];

  assert(files.simplified.includes('WiCi V1 是一个本地 TUI'), 'Simplified_PLAN must define the local TUI product boundary');
  assert(files.simplified.includes('Codex 负责按 `PLAN.md` 执行'), 'Simplified_PLAN must keep Codex as PLAN.md executor');
  assert(files.simplified.includes('不能把用户句子解析成 WiCi 内置 metric'), 'Simplified_PLAN must forbid supervisor semantic metric parsing');
  assert(files.simplified.includes('不能维护 hardcoded avenue/category'), 'Simplified_PLAN must forbid hardcoded task categories');
  assert(files.simplified.includes('脚本永远不是 fresh V1 启动执行的前置条件'), 'Simplified_PLAN must state planner scripts are not a fresh V1 execution prerequisite');

  assert(files.readme.includes('top Chat History / Goal/Plan / Execution workspace starts empty'), 'README must document blank Chat History / Goal/Plan / Execution workspace initial state');
  assert(files.readme.includes('The absence of `.opt` scripts is a valid fresh V1 path'), 'README must document no-script PLAN.md execution as valid fresh V1 behavior');
  assert(files.readme.includes('default `max_iters` is `0`') && files.readme.includes('disable WiCi\'s own cost and iteration hard stops'), 'README must document unbounded default real-run budgets');
  assert(
    files.readme.includes('automatically checks for Codex/Claude updates at run boundaries') &&
      files.readme.includes('pending updates are not a WiCi supervisor start gate'),
    'README must document automatic Codex/Claude update checks without reintroducing a pending-update start gate'
  );
  assert(files.config.includes('"max_iters": 0'), 'default config must not impose an iteration hard cap');
  assert(files.toolCommands.includes('default_iteration_budget_unbounded'), 'tool command verifier must cover unbounded default iteration budget');
  assert(files.readme.includes('wakes the stopped supervisor') && files.readme.includes('resumes the same Claude planner session'), 'README must document Chat answer resume after planner clarification');
  assert(files.readme.includes('revert unconfirmed direct-path work') && files.readme.includes('resets the active `PLAN.md` step for replay'), 'README must document direct V1 crash recovery behavior');
  assert(
    files.readme.includes('recoverable crash ledger rows') &&
      files.readme.includes('Codex is allowed to inspect logs and remote state') &&
      files.readme.includes('update `PLAN.md`') &&
      files.readme.includes('continue the same `GOAL.md`'),
    'README must document long-goal executor recovery behavior'
  );
  assert(files.readme.includes('## Resume Or Re-Run') && files.readme.includes('without a new `--goal`') && files.readme.includes('--resume-iteration 1'), 'README must document how to continue or rewind an existing goal');
  assert(files.app.includes('shouldUseChatAgentForBlankRun'), 'TUI must route blank-run chat input through the Chat agent before planning starts');
  assert(files.chat.includes('writeUpdate: !blankRun') && files.chat.includes('onPlanningRequested'), 'ChatPane must let the Chat agent decide when blank-run input starts planning');
  assert(files.chatAgent.includes('isLikelyContextGatheringOnly') && files.chatAgent.includes('isLikelyPlanningRequest'), 'degraded Chat must distinguish code-reading requests from concrete planning requests');
  assert(
    files.runtimeSettings.includes('formatRuntimeSelectorLine') &&
      files.runtimeSettings.includes('cycleRuntimeValue') &&
      files.runtimeSettings.includes("RuntimeField = 'agent' | 'effort'") &&
      files.runtimeSettings.includes('runtimeModelForAgent'),
    'TUI must support visible agent/effort selection while deriving fixed models from claude/codex'
  );
  assert(!files.app.includes('state.baseline ||'), 'TUI must not let a historical baseline.json alone block fresh Chat-first intake');
  assert(files.tuiChat.includes('goal_source_not_retroactive'), 'TUI intake verifier must prove goal_source is not written retroactively');
  assert(files.tuiChatPty.includes('pty_chat_first') && files.tuiChatPty.includes("goal_source === 'tui_chat'"), 'TUI PTY verifier must prove first Chat input records tui_chat provenance');
  assert(files.tuiRealFakeChat.includes('pty_chat_first_real_mode_fake_clis') && files.tuiRealFakeChat.includes("checkpoint.tool_versions?.mode === 'real'"), 'TUI real-mode fake verifier must prove Chat-first real subprocess plumbing');
  assert(
    files.tuiPlannerClarificationPty.includes('pty_planner_clarification') &&
      files.tuiPlannerClarificationPty.includes('question_answered') &&
      files.tuiPlannerClarificationPty.includes("checkpoint.sessions.planner === 'fake-planner-session'"),
    'TUI PTY verifier must prove planner clarification answers resume the planner session'
  );
  assert(files.app.includes('shouldAutoStartExistingRun'), 'TUI must distinguish attach-time auto-start from stopped runs');
  assert(files.app.includes('onInjection={() => launchSupervisor(undefined, undefined, undefined, activeTarget, activeSessionDir, true)}'), 'TUI must wake the supervisor after chat writes an inbox injection');
  assert(files.tuiHotreloadPty.includes('pty_hot_reload') && files.tuiHotreloadPty.includes('PLAN_DIFF_APPLIED'), 'TUI PTY verifier must prove follow-up Chat hot reload reaches plan diff');
  assert(files.app.includes('goal={state.goal}'), 'TUI must pass durable goal state into Chat');
  assert(files.chat.includes('parseRuntimeCommand'), 'ChatPane must parse runtime selection slash commands before ordinary Chat routing');
  assert(files.chat.includes('onInjection?.()'), 'ChatPane must notify App after non-initial chat input');
  assert(files.chat.includes('buildChatHistory'), 'ChatPane must render persisted Chat history');
  assert(files.chat.includes('currentGoalSummary') && !files.chat.includes('initial goal:'), 'ChatPane must restore the current goal outside transcript history');
  assert(files.runState.includes('readInjectionHistory') && files.runState.includes('paths.inboxDone'), 'TUI state must load drained Chat injections for durable history');
  assert(files.header.includes('goal pending'), 'Header must keep the pre-goal state generic');
  assert(files.header.includes('validation pending'), 'Header must keep planner-selected metric display generic');
  assert(files.header.includes('rollbackSummary') && files.header.includes('rollback pending'), 'Header must show rollback checkpoint status without inventing a checkpoint before one exists');
  assert(files.execPane.includes('usageSuffix'), 'Execution pane must surface planner/executor token usage in the TUI');
  assert(files.tuiChat.includes('historical_baseline_does_not_block_chat'), 'TUI intake verifier must prove historical baseline.json alone does not block first Chat');

  assert(files.planner.includes("'--permission-mode'") && files.planner.includes("'plan'"), 'planner must run Claude Code plan mode');
  assert(files.planner.includes("'--dangerously-skip-permissions'"), 'planner must preserve native Claude plan-mode autonomy');
  assert(files.toolCommands.includes('!plannerArgs.includes') && files.toolCommands.includes('--tools'), 'tool command verifier must prevent custom planner tool allowlists');
  assert(files.toolCommands.includes('plan_diff_usage_streamed'), 'tool command verifier must cover planner diff usage streaming');
  assert(files.toolCommands.includes('initial_plan_usage_streamed'), 'tool command verifier must cover initial planner usage streaming');
  assert(files.toolCommands.includes('no_markdown_benchmark_inference'), 'tool command verifier must prevent fresh planner markdown benchmark inference');
  assert(files.plannerPrompt.includes('Your final answer must be markdown artifacts, not JSON'), 'planner prompt must request markdown artifacts');
  assert(files.plannerPrompt.includes('Do not produce a second JSON representation'), 'planner prompt must forbid JSON-as-plan');
  assert(files.plannerPrompt.includes('Native Claude Code tools remain available in plan mode'), 'planner prompt must preserve native Claude plan-mode tools');
  assert(files.plannerPrompt.includes('web research or remote discovery'), 'planner prompt must allow planning-time web and remote discovery');
  assert(files.plannerPrompt.includes('a PLAN.md-only workflow is valid'), 'planner prompt must not force optional .opt scripts');
  assert(files.plannerPrompt.includes('Treat research, debugging, and fallback strategy as planner/executor responsibilities'), 'planner prompt must own research/debug/fallback behavior instead of requiring Chat boilerplate');
  assert(files.plannerPrompt.includes('## ASSUMPTIONS.md') && files.plannerPrompt.includes('Self-grill'), 'planner prompt must require self-interrogation and ASSUMPTIONS.md');
  assert(
    files.plannerPrompt.includes('source of truth') &&
      files.plannerPrompt.includes('ownership boundary') &&
      files.plannerPrompt.includes('resource identity/lifecycle') &&
      files.plannerPrompt.includes('fallback policy') &&
      files.plannerPrompt.includes('Do not hardcode domain assumptions'),
    'planner prompt must require architecture-invariant extraction without hardcoded domain rules'
  );
  assert(files.plannerPrompt.includes('RFC-style decision packet') && files.plannerPrompt.includes('options considered') && files.plannerPrompt.includes('chosen approach'), 'planner prompt must require RFC-style architecture/debug decisions');
  assert(
    files.plannerPrompt.includes('decision-quality receipts') &&
      files.plannerPrompt.includes('narrowed root cause') &&
      files.plannerPrompt.includes('falsified hypothesis') &&
      files.plannerPrompt.includes('Adding logs without a new conclusion'),
    'planner prompt must define diagnostic completion standards'
  );
  assert(
    files.plannerPrompt.includes('same blocker') &&
      files.plannerPrompt.includes('same evidence') &&
      files.plannerPrompt.includes('same reject reason') &&
      files.plannerPrompt.includes('one concrete discriminating next step'),
    'planner prompt must require semantic loop escape'
  );
  assert(files.plannerPrompt.includes('unresolvable by repository evidence'), 'planner prompt must reserve QUESTION for essential unresolvable unknowns');
  assert(files.plannerPrompt.includes('## Primary') && files.plannerPrompt.includes('## Stretch'), 'planner prompt must ask for primary/stretch goal sections');
  assert(files.plannerPrompt.includes('stop_when') && files.plannerPrompt.includes('continue improving'), 'planner prompt must bound continuing improvement as stretch scope');
  assert(files.plannerDiffPrompt.includes('## Primary') && files.plannerDiffPrompt.includes('## Stretch'), 'planner-diff prompt must preserve primary/stretch goal sections');
  assert(files.continueVerdictPrompt.includes('every active Primary requirement') && files.continueVerdictPrompt.includes('Stretch requirements as optional bounded improvement work'), 'continuation verdict must complete on primary requirements and bound stretch work');
  assert(files.sharedTypes.includes("kind?: 'primary' | 'stretch'") && files.sharedTypes.includes('stop_when?: string'), 'requirements must support primary/stretch kind and stop_when');
  assert(files.sharedTypes.includes("requirement_kind?: Requirement['kind']") && files.sharedTypes.includes('stop_when?: string'), 'injections must carry requirement kind and stop_when');
  assert(files.goalDocSource.includes("'## Primary'") && files.goalDocSource.includes("'## Stretch'") && files.goalDocSource.includes('stop-when:'), 'GOAL.md rendering must separate primary and stretch requirements with stop-when');
  assert(files.goalInterrogation.includes('markSatisfiedPrimaryRequirements') && files.goalInterrogation.includes("status: 'done' as const"), 'goal interrogation must mark satisfied primary requirements done');
  assert(files.stopPolicy.includes('allPrimaryRequirementsSatisfied') && files.stopPolicy.includes('all primary requirements are satisfied'), 'direct completion gate must stop when primary requirements are satisfied');
  assert(files.plannerPrompt.includes('- [ ] S1 Short imperative step title') && files.plannerPrompt.includes('### S1'), 'planner prompt must require WiCi-discoverable executable step lines');
  assert(files.plannerPrompt.includes('Do not create scripts just to satisfy WiCi'), 'planner prompt must keep validation scripts optional');
  assert(files.plannerPrompt.includes('Fresh V1 does not require `.opt/measure.sh` to follow a WiCi metric schema'), 'planner prompt must not force a fresh V1 measurement schema');
  assert(!files.plannerPrompt.includes('the measurement script must emit one final line'), 'planner prompt must not require a fixed measure.sh output line');
  assert(!files.plannerPrompt.includes('p99=<number>'), 'planner prompt must not seed p99 as a default validation field');
  assert(!schemas.includes('plan.schema.json') && !schemas.includes('plan-diff.schema.json'), 'planner JSON schemas must not exist as a second PLAN format');
  assert(!files.planner.includes('structured_output') && !files.planner.includes('parseJsonObjectFromText'), 'planner must not parse JSON-as-plan payloads');
  assert(schemas.includes('iter-result.schema.json'), 'Codex thin receipt schema must remain available');
  assert(files.plannerClarification.includes('PLANNER_CLARIFY_REQUIRED'), 'planner clarification path must be verified');
  assert(files.plannerClarification.includes('plan_diff_question') && files.plannerClarification.includes('plan_diff_resumed_session'), 'planner clarification verifier must cover hot-reload plan diff questions');
  assert(files.plannerDiffPrompt.includes('## QUESTION'), 'planner diff prompt must allow clarification through Chat');
  assert(files.plannerDiffPrompt.includes('living self-interrogation artifact') && files.plannerDiffPrompt.includes('override an adopted assumption'), 'planner diff prompt must maintain ASSUMPTIONS.md through steering');
  assert(
    files.plannerDiffPrompt.includes('source of truth') &&
      files.plannerDiffPrompt.includes('ownership boundary') &&
      files.plannerDiffPrompt.includes('resource identity/lifecycle') &&
      files.plannerDiffPrompt.includes('Do not turn examples or prior task details into hardcoded product/domain rules'),
    'planner-diff prompt must preserve inferred architecture invariants task-agnostically'
  );
  assert(files.plannerDiffPrompt.includes('RFC-style decision packet') && files.plannerDiffPrompt.includes('decision-quality evidence') && files.plannerDiffPrompt.includes('one concrete discriminating next step'), 'planner-diff prompt must enforce RFC diagnostics and loop escape');
  assert(files.plannerDiffPrompt.includes('not blindly append') && files.plannerDiffPrompt.includes('compact it while applying the new requirement'), 'planner diff prompt must compact noisy PLAN.md updates instead of endlessly appending');
  assert(files.plannerDiffPrompt.includes('native plan-mode tools remain available'), 'planner diff prompt must preserve native Claude tools during hot reload planning');
  assert(files.plannerDiffPrompt.includes('- [ ] S3 Short imperative step title') && files.plannerDiffPrompt.includes('### S3'), 'planner diff prompt must preserve WiCi-discoverable step shape for added steps');
  assert(files.chat.includes('latestQuestion') && files.chat.includes("kind: 'answer'"), 'ChatPane must route open planner questions through chat answers');
  assert(
    files.chatPrompt.includes('Architecture proposals phrased as questions') &&
      files.chatPrompt.includes('answer feasibility briefly') &&
      files.chatPrompt.includes('source of truth') &&
      files.chatPrompt.includes('fallback policy') &&
      files.chatPrompt.includes('kind: steer'),
    'Chat prompt must treat actionable architecture questions as update-worthy steering'
  );
  assert(
    files.tuiChat.includes('status_question_reply_only') &&
      files.tuiChat.includes('architecture_question_emits_steer') &&
      files.tuiChat.includes('fallback_policy_emits_steer'),
    'TUI Chat intake verifier must cover status questions versus architecture steering questions'
  );

  assert(files.supervisor.includes("waitReason: 'PLAN_READY'"), 'fresh V1 setup must be able to return PLAN_READY without a baseline');
  assert(files.supervisor.includes('return runDirectPlanExecution'), 'fresh V1 setup must directly enter PLAN.md execution');
  assert(files.supervisor.includes("mode: 'direct'"), 'fresh V1 events must identify direct PLAN.md execution');
  assert(files.supervisor.includes('directContinuationVerdict') && files.supervisor.includes('DIRECT_CONTINUATION_VERDICT'), 'fresh V1 must gate exhausted direct plans before continuation');
  assert(files.supervisor.includes('LEGACY_BASELINE_IGNORED'), 'fresh V1 must ignore historical baseline.json unless legacy optimizer is explicitly enabled');
  assert(files.supervisor.includes('legacy_optimizer === true'), 'legacy optimizer baseline path must be explicit opt-in');
	  assert(files.supervisor.includes('emitPlannerUsage(events, progress') && files.supervisor.includes("phase: 'direct_plan_diff'"), 'hot reload planner diffs must stream PLAN_USAGE events');
	  assert(!files.supervisor.includes('PREBASELINE') && !files.supervisor.includes('runPreBaselineSetupStep'), 'fresh V1 supervisor must not carry a pre-baseline setup control path');
  assert(!files.supervisor.includes('assertNoPendingToolUpdatesForLongRun'), 'fresh V1 supervisor must not block long runs on pending tool updates');
  assert(!files.selfupdate.includes('Refusing to start long run because tool update is pending'), 'selfupdate must not contain the old pending-update start gate');
  assert(!files.context.includes('locked eval scripts'), 'direct context must not tell Codex eval scripts are locked by default');
  assert(files.executor.includes('Treat existing scripts under') && files.executor.includes('planner-provided validation artifacts'), 'executor prompt must treat .opt scripts as planner artifacts');
  assert(files.executor.includes('Thinkless will not run git add or git commit for direct V1 execution'), 'executor prompt must make direct V1 commits executor-owned');
  assert(files.plannerPrompt.includes('executor-owned git commit action') && files.plannerDiffPrompt.includes('executor-owned git commit action'), 'planner prompts must put commit responsibility into PLAN.md');
  assert(files.executor.includes('You may edit ${planPath}') && files.executor.includes('Do not stop at the first failing command'), 'executor prompt must authorize recovery/debug/plan updates');
  assert(files.executor.includes('research the relevant documentation or tutorials yourself'), 'executor prompt must make research/debugging a Codex responsibility, not a Chat input requirement');
  assert(
    files.executor.includes('infer the target system invariants') &&
      files.executor.includes('source of truth') &&
      files.executor.includes('ownership boundary') &&
      files.executor.includes('translation or mapping points') &&
      files.executor.includes('fallback policy'),
    'executor prompt must infer architecture invariants before sensitive changes'
  );
  assert(
    files.executor.includes('Aggressive debugging is allowed') &&
      files.executor.includes('bounded and evidence-producing') &&
      files.executor.includes('no unlabelled fallback') &&
      files.executor.includes('no masking missing ownership/resource mappings'),
    'executor prompt must permit deep debugging while respecting invariants'
  );
  assert(
    files.executor.includes('Only mark diagnostic work done') &&
      files.executor.includes('earliest suspicious point') &&
      files.executor.includes('next highest-value test') &&
      files.executor.includes('adding logs without a new conclusion'),
    'executor prompt must enforce diagnostic completion quality'
  );
  assert(
    files.executor.includes('same blocker') &&
      files.executor.includes('same evidence') &&
      files.executor.includes('same reject reason') &&
      files.executor.includes('plan/harness/receipt path'),
    'executor prompt must require semantic loop escape'
  );
  assert(files.executor.includes('Current ${goalPath}:') && files.executor.includes('Current ${planPath}:'), 'executor prompt must embed GOAL.md and PLAN.md as Codex goal input');
  assert(files.executor.includes('as one Codex goal') && files.executor.includes('Supervisor receipt focus'), 'executor prompt must feed GOAL.md + PLAN.md as one Codex goal while keeping only a thin receipt focus');
  assert(!files.executor.includes('Execute plan step ${stepId} from PLAN.md.'), 'executor prompt must not reduce fresh V1 execution to a single supervisor-controlled plan step');
  assert(
    files.executor.includes('startCodexAppServerTurn') &&
      files.executor.includes("'exec'") &&
      files.executor.includes("'resume'") &&
      files.executor.includes("'--last'"),
    'executor must support app-server steering with codex exec resume fallback'
  );
  assert(files.directNoScripts.includes('executed_without_opt_scripts'), 'direct no-scripts verifier must cover PLAN.md execution without .opt scripts');
  assert(files.existingGoal.includes('continued_without_new_goal') && files.existingGoal.includes('reused_goal_run_id'), 'existing-goal verifier must prove same-target continuation without a new --goal');
	  assert(files.directNoScripts.includes("!events.some((event) => event.type === 'BASELINE_START')"), 'direct no-scripts verifier must reject baseline gating');
	  assert(files.directNoScripts.includes("!events.some((event) => event.type === 'EVALUATE_START')"), 'direct no-scripts verifier must reject eval gating');
	  assert(files.directNoScripts.includes('ignored_historical_baseline'), 'direct no-scripts verifier must prove historical baseline.json does not force eval gating');

  assert(files.goalMetric.includes('WiCi must not parse 700token/s'), 'goal-metric verifier must guard against parsing user text into WiCi metrics');
  assert(!files.v1Slice.includes('Reduce p99 latency'), 'core V1 slice verifier must not use p99 latency as the default user goal');
  assert(!files.hotreload.includes('Reduce p99 latency'), 'core hot reload verifier must not use p99 latency as the default user goal');
  assert(!files.executor.includes("metric: { name: 'p99 latency'"), 'executor contract fixtures must not default to p99 latency');
  assert(!files.realMode.includes("metric: { name: 'p99'"), 'real-mode fixtures must not default to p99');
  assert(files.hotreload.includes('PLAN_DIFF_APPLIED'), 'hot reload verifier must cover planner diff after chat input');
  assert(files.hotreload.includes('checkpoint.drained_inbox.includes'), 'hot reload verifier must cover drained inbox idempotency');
  assert(files.hotreload.includes('goal_doc_contains_steering') && files.inbox.includes('Steering:'), 'hot reload must persist steering text into GOAL.md');
	  assert(files.packageJson.includes('verify:app-server-hotreload') && files.readme.includes('turn/steer'), 'hot reload must verify app-server active-turn steering');
  assert(files.packageJson.includes('verify:app-server-fallback') && files.supervisor.includes('EXECUTE_APP_SERVER_FALLBACK'), 'executor must verify app-server reconnect fallback to codex exec');
  assert(files.appServerFallback.includes('connection/reconnecting') && files.appServerFallback.includes('app_server_reconnect_fallback'), 'app-server fallback verifier must cover reconnect loops');
	  assert(files.packageJson.includes('verify:hotreload-resume') && files.readme.includes('codex exec resume --last'), 'hot reload must keep Codex exec resume continuity as fallback');
  assert(files.durability.includes('direct_recovered') && files.durability.includes("mode === 'direct'"), 'durability verifier must cover direct V1 crash recovery');
  assert(files.goalDoc.includes('GOAL.md') && files.goalDoc.includes('snapshot_preserved_goal_doc'), 'goal-doc verifier must cover durable human-readable GOAL.md');

  assert(files.tagGate.includes('evidence_bundle'), 'tag gate must validate committed canary evidence bundles');
  assert(files.tagGate.includes('planner_transcript_present') && files.tagGate.includes('codex_transcript_present'), 'tag gate must require planner and Codex transcript evidence');
  assert(files.tagGate.includes('optionalPlannerArtifactNames'), 'tag gate must treat .opt planner outputs as optional canary artifacts');
  assert(!files.tagGate.includes('mentions_measure_script === true'), 'tag gate must not require measure scripts for the generic V1 canary');
  assert(files.tagGate.includes('version_point_present') && files.tagGate.includes('rollback_present'), 'tag gate must require version point and rollback evidence');
  assert(files.tagGate.includes('release_version') && files.tagGate.includes('canary_matches_current'), 'tag gate must require canary evidence to match the current WiCi checkout');
  assert(files.tagGate.includes('artifact_files_verified') && files.tagGate.includes('artifact_hash_mismatches'), 'tag gate must verify committed canary artifact hashes');
  assert(files.tagGate.includes('optional_planner_scripts_executable') && files.tagGate.includes('verifyExecutableArtifacts'), 'tag gate must verify committed planner shell artifacts remain executable');
  assert(files.tagGate.includes('secret_scan_ok') && files.tagGate.includes('scanEvidenceFilesForSecrets'), 'tag gate must scan committed canary evidence for secret material');
  assert(files.tagGate.includes('codex_ssh_attempt_attested') && files.tagGate.includes('!expectsSsh || evidence.codex_attempted_ssh === true'), 'tag gate must require structured Codex SSH attestation only when the canary requires SSH');
  assert(files.tagGate.includes('codex_transcript_has_ssh_attempt') && files.tagGate.includes('inspectCodexSshTranscript'), 'tag gate must verify SSH attempts from the Codex transcript, not only attestation fields');
  assert(files.tagGate.includes('canaryExpectsSsh') && files.tagGate.includes('targetMetadataValid'), 'tag gate must derive SSH and target checks from canary evidence instead of fixed task assumptions');
  assert(files.tagGate.includes('realModeForPassed') && files.tagGate.includes('canary_tool_mode'), 'tag gate must require/report real tool mode for passed release canaries');
  assert(files.tagGate.includes('tuiChatForPassed') && files.tagGate.includes('canary_goal_source'), 'tag gate must require/report TUI Chat goal source for passed release canaries');
  assert(!files.tagGate.includes('116.127.115.18') && !files.tagGate.includes("target === 700") && !files.tagGate.includes("unit === 'token/s'"), 'tag gate must not hardcode the current diffusionGemma canary target');
  assert(!files.canaryRecorder.includes('116.127.115.18'), 'canary recorder must not hardcode the current diffusionGemma SSH target');
  assert(files.sshEvidence.includes('expectedHostTerms') && files.sshEvidence.includes('extractExpectedHostTerms'), 'shared SSH evidence helper must tie transcript evidence to expected targets when present');
  assert(files.sshEvidenceCheck.includes('wrong_target_rejected') && files.sshEvidenceCheck.includes('auth_failure_output_supported'), 'shared SSH evidence verifier must cover target mismatch and auth failure output');
  assert(files.canaryRecorder.includes('generated_artifacts') && files.canaryRecorder.includes('sha256'), 'canary recorder must generate hashed artifact evidence');
  assert(
    files.canaryRecorder.includes('startedFromEmptyTui') &&
      files.canaryRecorder.includes('operatorManualExecution') &&
      files.canaryRecorder.includes('codexAttemptedSsh') &&
      files.canaryRecorder.includes('validateStatusArgs') &&
      files.canaryRecorder.includes('validateTargetArgs') &&
      files.canaryRecorder.includes('validateAttestationArgs') &&
      files.canaryRecorder.includes('optionalFiniteNumber') &&
      files.canaryRecorder.includes('observedValue') &&
      files.canaryRecorder.includes('targetGitDirty') &&
      files.canaryRecorder.includes('assertSourceArtifactsHaveNoSecrets') &&
      files.canaryRecorder.includes('assertCodexSshAttestationSupported') &&
      files.canaryRecorder.includes('requiredBoolean'),
    'canary recorder must require explicit operator attestations plus coherent status and target fields instead of inventing release facts'
  );
  assert(files.tagGate.includes('passedObservedTargetEvidence'), 'tag gate must require passed canaries to include observed value evidence that reaches the target');
  assert(files.tagGate.includes('targetCleanForPassed') && files.tagGate.includes('canary_target_git_dirty'), 'tag gate must require/report a clean target checkout for passed canaries');
  assert(files.tagGate.includes('WICI_CANARY_DIR'), 'tag gate must allow fixture canary directories for release-gate verification');
  assert(files.canaryEvidence.includes('tag_gate_rejects_passed_dirty_target'), 'canary evidence verifier must prove tag gate rejects passed canaries with dirty target evidence');
  assert(files.canaryEvidence.includes('tag_gate_rejects_stub_mode_passed_canary'), 'canary evidence verifier must prove tag gate rejects passed canaries recorded from stub mode');
  assert(files.canaryEvidence.includes('recorder_rejects_stub_mode_passed_canary'), 'canary evidence verifier must prove recorder rejects passed canaries before writing stub-mode evidence');
  assert(files.canaryEvidence.includes('recorder_rejects_non_tui_passed_canary'), 'canary evidence verifier must prove recorder rejects passed canaries that did not start from TUI Chat');
  assert(files.canaryEvidence.includes('tag_gate_rejects_non_tui_passed_canary'), 'canary evidence verifier must prove tag gate rejects mutated non-TUI passed canary evidence');
  assert(files.canaryEvidence.includes('recorder_rejects_dirty_target_passed_canary'), 'canary evidence verifier must prove recorder rejects passed canaries before writing dirty-target evidence');
  assert(files.canaryEvidence.includes('cli_rejects_invalid_passed_attestation'), 'canary evidence verifier must prove recorder rejects impossible passed operator attestations');
  assert(files.canaryEvidence.includes('tag_gate_handles_non_ssh_canary'), 'canary evidence verifier must prove tag gate supports non-SSH canary shapes');
  assert(
    files.tagGate.includes('target_value') &&
      files.tagGate.includes('observed_value') &&
      files.tagGate.includes('passed_observed_target'),
    'tag gate report must expose target/observed release evidence for human review'
  );
  assert(files.tagGate.includes('blocked_do_not_tag_or_push'), 'tag gate must explicitly block tag/push when the canary is failed');
  assert(
    files.tagGate.includes('next_required_action') && files.tagGate.includes('failure_reason'),
    'tag gate must surface explicit failed-canary blocker fields'
  );
  assert(files.tagGate.includes("status === 'passed'") && files.tagGate.includes("tagAllowed === 'true'"), 'tag gate must require passed status and tag_allowed=true');
  assert(files.readme.includes('Every release tag must pass a real TUI canary'), 'README must document the real canary release gate');
  assert(files.readme.includes('Keep that first Chat as the real user request only'), 'README must keep release canary Chat free of meta executor instructions');
  assert(!files.readme.includes('网上很多教程，自己查资料'), 'README must not teach operators to put research/debug meta instructions into canary Chat');
  assert(files.readme.includes('A non-zero result is expected while the latest canary is still failed'), 'README must document failed-canary tag gate behavior');
  assert(files.readme.includes('no-script plans still execute directly'), 'README acceptance text must not imply optional scripts are required');
  assert(files.secretScan.includes('ANTHROPIC') && files.secretScan.includes('private key material'), 'secret scanner must scan for provider tokens and private keys');

  assert(pkg.scripts['verify:v1-core']?.includes('verify:v1-requirements'), 'verify:v1-core must include verify:v1-requirements');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:direct-no-scripts'), 'verify:v1-core must include direct no-scripts PLAN.md execution');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:direct-recovery'), 'verify:v1-core must include direct executor recovery');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:direct-plan-continuation'), 'verify:v1-core must include exhausted direct plan continuation');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:self-interrogation'), 'verify:v1-core must include planner self-interrogation coverage');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:continuation-verdict'), 'verify:v1-core must include direct continuation verdict coverage');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:existing-goal'), 'verify:v1-core must include existing GOAL.md/PLAN.md continuation');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:real-mode'), 'verify:v1-core must include real-mode target safety checks');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:demo-tui'), 'verify:v1-core must include the Chat-first demo TUI check');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:tui-real-fake-chat'), 'verify:v1-core must include the real-mode fake Chat-first TUI verifier');
	  assert(pkg.scripts['verify:v1-core']?.includes('verify:tui-live'), 'verify:v1-core must include the live TUI execution stream check');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:app-server-fallback'), 'verify:v1-core must include app-server reconnect fallback');
	  assert(pkg.scripts['verify:v1-core']?.includes('verify:durability'), 'verify:v1-core must include direct V1 crash recovery');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:goal-doc'), 'verify:v1-core must include durable GOAL.md coverage');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:canary-evidence'), 'verify:v1-core must include canary evidence recorder checks');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:ssh-evidence'), 'verify:v1-core must include shared SSH evidence checks');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:release-tag'), 'verify:v1-core must include guarded release tag checks');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:no-secrets'), 'verify:v1-core must include committed secret scans');
  for (const verifier of releaseResumeVerifiers) {
    assert(pkg.scripts['verify:v1-core']?.includes(verifier), `verify:v1-core must include release resume verifier ${verifier}`);
    assert(files.readme.includes(`npm run ${verifier}`), `README must document release resume verifier ${verifier}`);
  }
  assert(pkg.scripts['release:preflight'] === 'npm run verify:v1-core && npm run verify:tag-gate', 'release preflight must bind V1 core verification to the real canary tag gate');
  assert(pkg.scripts['release:tag']?.includes('src/release/tag.ts'), 'package scripts must expose the guarded release tag command');
  assert(files.releaseTag.includes("['run', 'release:preflight']") && files.releaseTag.includes("['tag', '-a', tag"), 'release tag command must run preflight before creating an annotated tag');
  assert(!files.releaseTag.includes("['push'") && !files.releaseTag.includes('git push'), 'release tag command must not push tags');
  assert(files.releaseTagVerifier.includes('no_tag_after_failed_preflight') && files.releaseTagVerifier.includes('creates_annotated_tag_after_preflight'), 'release tag verifier must prove failed preflight blocks tags and successful preflight creates an annotated tag');
  assert(pkg.scripts['release:record-canary']?.includes('src/release/record-canary.ts'), 'package scripts must expose the canary evidence recorder');
  assert(pkg.scripts['verify:no-secrets']?.includes('src/verify/no-secrets.ts'), 'package scripts must expose the committed secret scanner');

  console.log(
    JSON.stringify(
      {
        ok: true,
        blank_chat_intake: true,
        planner_markdown_plan_mode: true,
        no_planner_json_schema: true,
        no_markdown_benchmark_inference: true,
	        direct_plan_execution: true,
	        no_prebaseline_control_path: true,
	        historical_baseline_ignored_by_default: true,
	        hot_reload_and_clarification: true,
        tag_gate: true
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
