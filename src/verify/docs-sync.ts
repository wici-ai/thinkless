import { readdir, readFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const [
    packageRaw,
    readme,
    referenceDoc,
    configRaw,
    plan,
    simplifiedPlan,
    completionAudit,
    installPage,
    supervisorIndex,
    plannerSource,
    plannerPrompt,
    plannerDiffPrompt,
    contextSource,
    curriculumSource,
    releaseTagSource,
    releaseTagVerifier,
    schemas
  ] = await Promise.all([
    readFile('package.json', 'utf8'),
    readFile('README.md', 'utf8'),
    readFile('docs/reference.md', 'utf8'),
    readFile('wici.config.json', 'utf8'),
    readFile('PLAN.md', 'utf8'),
    readFile('Simplified_PLAN.md', 'utf8'),
    readFile('docs/v1-completion-audit.md', 'utf8'),
    readFile('docs/index.md', 'utf8'),
    readFile('src/supervisor/index.ts', 'utf8'),
    readFile('src/supervisor/planner.ts', 'utf8'),
    readFile('prompts/planner.md', 'utf8'),
    readFile('prompts/planner-diff.md', 'utf8'),
    readFile('src/supervisor/context.ts', 'utf8'),
    readFile('src/supervisor/curriculum.ts', 'utf8'),
    readFile('src/release/tag.ts', 'utf8'),
    readFile('src/verify/release-tag.ts', 'utf8'),
    readdir('schemas')
  ]);
  const pkg = JSON.parse(packageRaw) as { scripts: Record<string, string> };
  const config = JSON.parse(configRaw) as { budget?: { max_iters?: number; max_cost_usd?: number } };
  const docsText = `${readme}\n${referenceDoc}`;
  const packageVerifyScripts = Object.keys(pkg.scripts)
    .filter((name) => name.startsWith('verify:'))
    .sort();
  const docsVerifyScripts = [...new Set([...docsText.matchAll(/npm run (verify:[a-z0-9:-]+)/g)].map((match) => match[1]))].sort();
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

  const missingFromDocs = packageVerifyScripts.filter((script) => !docsVerifyScripts.includes(script));
  const extraInDocs = docsVerifyScripts.filter((script) => !packageVerifyScripts.includes(script));
  assert(missingFromDocs.length === 0, `docs command list missing package verify scripts: ${missingFromDocs.join(', ')}`);
  assert(extraInDocs.length === 0, `docs command list has unknown verify scripts: ${extraInDocs.join(', ')}`);
  assert(readme.includes('# Thinkless'), 'README should identify the project');
  assert(readme.includes('## Install') && readme.includes('curl -fsSL https://wici.ai/thinkless/install.sh | bash'), 'README should keep a short install path');
  assert(readme.includes('## Usage') && readme.includes('thinkless resume'), 'README should keep concise usage examples');
  assert(readme.includes('[Full reference](docs/reference.md)'), 'README should link the detailed reference docs');
  assert(readme.length < 7000, 'README should stay concise for an open-source repo landing page');

  assert(plan.includes('Autonomous Long-Horizon Coding TUI Orchestrator'), 'PLAN.md should remain the original long-horizon plan');
  assert(
    plan.includes('this file preserves the original long-horizon optimizer design notes') &&
      plan.includes('Baseline/checks/measure gating') &&
      plan.includes('explicit legacy optimizer path') &&
      plan.includes('not block fresh V1 execution') &&
      plan.includes('Do not use lower sections of this historical file'),
    'PLAN.md must label old baseline/checks/measure content as historical legacy optimizer design, not fresh V1'
  );
  assert(simplifiedPlan.includes('WiCi V1 是一个本地 TUI'), 'Simplified_PLAN should define WiCi V1 as a local TUI');
  assert(simplifiedPlan.includes('Claude Code plan mode'), 'Simplified_PLAN should keep Claude Code plan mode as planner');
  assert(simplifiedPlan.includes('Codex 负责按 `PLAN.md` 执行'), 'Simplified_PLAN should keep Codex as executor');
  assert(simplifiedPlan.includes('WiCi 可识别的可执行步骤行'), 'Simplified_PLAN should require PLAN.md steps to be machine-discoverable without a schema');
  assert(simplifiedPlan.includes('不能把用户句子解析成 WiCi 内置 metric'), 'Simplified_PLAN should forbid supervisor metric parsing');
  assert(simplifiedPlan.includes('不能维护 hardcoded avenue/category'), 'Simplified_PLAN should forbid hardcoded categories');
  assert(simplifiedPlan.includes('每次 tag 前必须运行发布 preflight'), 'Simplified_PLAN should require release preflight before tag');
  assert(simplifiedPlan.includes('发布证据来自 `verify:v1-core`'), 'Simplified_PLAN should bind release evidence to verify:v1-core');
  assert(simplifiedPlan.includes('WiCi 只负责落盘和展示'), 'Simplified_PLAN should keep planner scripts out of supervisor execution semantics');
  assert(simplifiedPlan.includes('脚本永远不是 fresh V1 启动执行的前置条件'), 'Simplified_PLAN should state scripts are never a fresh V1 execution prerequisite');
  assert(simplifiedPlan.includes('旧 optimizer 必须显式打开'), 'Simplified_PLAN should require explicit opt-in for legacy optimizer behavior');
  assert(!simplifiedPlan.includes('WiCi 只落盘和运行'), 'Simplified_PLAN must not say WiCi runs planner scripts as a default control path');
  assert(!simplifiedPlan.includes('p99 latency'), 'Simplified_PLAN should not describe p99 latency as a default goal');
  assert(!simplifiedPlan.includes('metaproductivity'), 'Simplified_PLAN should not carry old metaproductivity design into V1');
  assert(!schemas.includes('plan.schema.json') && !schemas.includes('plan-diff.schema.json'), 'planner schemas should not exist as a second markdown plan format');
  assert(!plannerSource.includes('structured_output') && !plannerSource.includes('parseJsonObjectFromText'), 'planner path should not parse JSON-as-plan payloads');
  assert(plannerSource.includes('assumptionsMarkdown') && plannerSource.includes('paths.assumptions'), 'planner path should parse and materialize ASSUMPTIONS.md');
  assert(
    plannerPrompt.includes('- [ ] S1 Short imperative step title') &&
      plannerPrompt.includes('### S1') &&
      plannerDiffPrompt.includes('- [ ] S3 Short imperative step title') &&
      plannerDiffPrompt.includes('### S3'),
    'planner prompts should require WiCi-discoverable executable step lines without introducing a plan schema'
  );
  assert(plannerPrompt.includes('## ASSUMPTIONS.md'), 'planner prompt must request markdown ASSUMPTIONS.md artifacts');
  assert(plannerPrompt.includes('Brainstorm 2-3') && plannerPrompt.includes('Self-grill'), 'planner prompt must require AI-led self-interrogation');
  assert(plannerPrompt.includes('unresolvable by repository evidence'), 'planner prompt must narrow QUESTION to essential unresolvable unknowns');
  assert(plannerDiffPrompt.includes('living self-interrogation artifact') && plannerDiffPrompt.includes('override an adopted assumption'), 'planner-diff prompt must maintain assumption overrides');
  assert(plannerDiffPrompt.includes('not blindly append') && plannerDiffPrompt.includes('compact it while applying the new requirement'), 'planner-diff prompt must govern PLAN.md bloat during updates');
  assert(docsText.includes('Legacy optimizer compatibility checks'), 'docs should explicitly separate legacy verifiers from core V1 checks');
  assert(docsText.includes('WICI_LEGACY_OPTIMIZER=1'), 'docs should document explicit opt-in for legacy optimizer behavior');
  assert(docsText.includes('npm run verify:legacy-optimizer'), 'docs should document the legacy optimizer aggregate verifier');
  assert(docsText.includes('npm run verify:direct-no-scripts'), 'docs should document the no-script direct PLAN.md verifier');
  assert(docsText.includes('npm run verify:direct-recovery'), 'docs should document the direct executor recovery verifier');
  assert(docsText.includes('npm run verify:existing-goal') && docsText.includes('without passing a new `--goal`'), 'docs should document the existing-goal continuation verifier');
  assert(docsText.includes('npm run verify:tui-chat-pty') && docsText.includes('real pseudo-terminal'), 'docs should document the real PTY Chat-first verifier');
  assert(docsText.includes('npm run verify:tui-real-fake-chat') && docsText.includes('fake Claude/Codex CLIs'), 'docs should document the real-mode fake CLI Chat-first verifier');
  assert(docsText.includes('npm run verify:tui-planner-clarification-pty') && docsText.includes('resumes the planner session'), 'docs should document the real PTY planner clarification verifier');
  assert(docsText.includes('npm run verify:tui-hotreload-pty') && docsText.includes('PLAN_DIFF_APPLIED'), 'docs should document the real PTY hot reload verifier');
  assert(
    docsText.includes('The first natural-language Chat message is ordinary conversation first') &&
      docsText.includes('the Chat agent decides the work is large'),
    'docs should document Chat-agent-gated blank-run planning'
  );
  assert(
    docsText.includes('Typing a direct stop request') && docsText.includes('aborts an active planner subprocess'),
    'docs should document Chat stop control for planner/executor'
  );
  assert(
    docsText.includes('ordinary code changes, validation, commits, pushes, and guarded release commands can stay in Chat') &&
      docsText.includes('make ordinary code changes, validate, commit, push, or run guarded release commands without starting a run'),
    'docs should document lightweight Chat work before planner/executor escalation'
  );
  assert(
    docsText.includes('Chat agents run with normal native CLI permission') &&
      docsText.includes('Claude Chat is not forced into plan-only mode') &&
      docsText.includes('Codex Chat bypasses approvals and sandboxing'),
    'docs should document Chat direct-work permissions'
  );
  assert(
    docsText.includes('Press `Ctrl+R` to open the selector') &&
      docsText.includes('bottom Chat input is paused while the selector is open') &&
      docsText.includes('model is fixed by that agent') &&
      docsText.includes('/agent chat claude') &&
      docsText.includes('/effort execution high') &&
      docsText.includes('Claude effort options are `high`, `xhigh`, `max`, and `ultracode`') &&
      docsText.includes('Codex effort options are `fast`, `medium`, `high`, and `xhigh`') &&
      docsText.includes('model_reasoning_effort'),
    'docs should document per-workspace runtime selection commands'
  );
  assert(
    docsText.includes('Terminal text selection/copy is the default pointer mode') &&
      docsText.includes('cannot reliably provide native drag selection and app-level touchpad scrolling at the same time') &&
      docsText.includes('Press `Ctrl+O`') &&
      docsText.includes('`--mouse-reporting`'),
    'docs should document explicit select/scroll pointer modes'
  );
  assert(docsText.includes('WICI_PLANNER_EFFORT') && docsText.includes('WICI_EXECUTOR_AGENT') && docsText.includes('WICI_EXECUTOR_EFFORT'), 'docs should document runtime environment overrides');
  assert(docsText.includes('npm run verify:release-tag'), 'docs should document the guarded release tag verifier');
  assert(docsText.includes('planner-*.stdout.jsonl') && docsText.includes('.wici/codex-run.jsonl'), 'docs should document planner and Codex transcript paths');
  assert(docsText.includes('git clone git@github.com:wici-ai/thinkless.git'), 'docs should document a source checkout deployment path');
  assert(docsText.includes('git checkout <verified-release-tag-or-commit>'), 'docs should document pinning a verified WiCi version');
  assert(docsText.includes('npm run build') && docsText.includes('npm run verify:v1-core'), 'docs deployment should include build and core verification');
  assert(
    docsText.includes('## Resume Or Re-Run') &&
      docsText.includes('without a new `--goal`') &&
      docsText.includes('--resume-iteration 1') &&
      docsText.includes('drained_inbox[]') &&
      docsText.includes('open an in-TUI selector') &&
      docsText.includes('runnable or blocked') &&
      docsText.includes('RESUME_CONTEXT_VALIDATED'),
    'docs should document continuing, rewinding, selectable resume, and idempotent hot-reload resume'
  );
  assert(config.budget?.max_iters === 0 && config.budget?.max_cost_usd === 0, 'default config should not impose cost or iteration hard caps');
  assert(docsText.includes('default `max_iters` is `0`') && docsText.includes('disable WiCi\'s own cost and iteration hard stops'), 'docs should document unbounded default real-run budgets');
  assert(
    docsText.includes('automatically checks for Codex/Claude updates at run boundaries') &&
      docsText.includes('pending updates are not a WiCi supervisor start gate'),
    'docs should document automatic Codex/Claude update checks without a pending-update start gate'
  );
  assert(
      docsText.includes('## macOS Bootstrap') &&
      docsText.includes('curl -fsSL https://github.com/wici-ai/thinkless/releases/latest/download/install.sh | bash') &&
      docsText.includes('THINKLESS_TARBALL_URL') &&
      docsText.includes('workflow is manually triggered') &&
      docsText.includes('Publish public install release') &&
      docsText.includes('From a clean machine') &&
      docsText.includes('scripts/postinstall.mjs') &&
      docsText.includes('THINKLESS_BOOTSTRAP=0') &&
      docsText.includes('scripts/bootstrap-macos.sh') &&
      docsText.includes('no `npm` yet') &&
      docsText.includes('usable `sudo` access') &&
      docsText.includes('verifies `sudo` access') &&
      docsText.includes('does not run npm install scripts with `sudo`') &&
      docsText.includes('Apple Command Line Tools') &&
      docsText.includes('~/.zprofile') &&
      docsText.includes('~/.zshrc') &&
      docsText.includes('`node`, `npm`, `thinkless`, `codex`, `claude`, and `gh`') &&
      docsText.includes('clean zsh login and interactive shells') &&
      docsText.includes('export PATH=... && thinkless') &&
      docsText.includes('auth onboarding status') &&
      docsText.includes('codex login') &&
      docsText.includes('/dev/tty') &&
      docsText.includes('THINKLESS_AUTH_ONBOARDING=0') &&
      docsText.includes('auth is pending'),
    'docs should document public one-line install, automatic macOS install-time bootstrap, and the no-npm bootstrap path'
  );
  assert(
    docsText.includes('`brew`, `git`, `node`, `npm`, `gh`, `codex`, and `claude`') &&
      docsText.includes('GitHub CLI') &&
      docsText.includes('gh auth login') &&
      docsText.includes('gh auth status') &&
      docsText.includes('Codex CLI') &&
      docsText.includes('Claude Code CLI') &&
      docsText.includes('Codex, Claude, and GitHub CLI commands'),
    'docs should document GitHub CLI as a required installed and authenticated host dependency'
  );
  assert(
    docsText.includes('THINKLESS_CONFIG_BUNDLE') &&
      docsText.includes('~/.codex/config.toml') &&
      docsText.includes('~/.codex/auth.json') &&
      docsText.includes('~/.claude/settings.json') &&
      docsText.includes('~/.claude/.credentials.json') &&
      docsText.includes('keep them out of the repository'),
    'docs should document user-scoped Codex/Claude config copying without committing secrets'
  );
  assert(
    docsText.includes('Codex `doctor` reachability failures are recorded as diagnostics') &&
      docsText.includes('not a hard real-mode start gate'),
    'docs should document advisory Codex doctor diagnostics'
  );
  assert(
    installPage.includes('curl -fsSL https://wici.ai/thinkless/install.sh | bash') &&
      installPage.includes('navigator.clipboard.writeText') &&
      installPage.includes('thinking effort') &&
      installPage.includes('thinkless doctor --deep'),
    'docs install page should expose the public one-line installer, copy button, purpose, and verification command'
  );
  assert(
    docsText.includes('`GOAL.md + PLAN.md` as one goal') && !docsText.includes('execute a `PLAN.md` step'),
    'docs should document whole-goal Codex execution instead of the old step-only contract'
  );
  assert(
    docsText.includes('optional planner scripts are persisted executable and runnable when present'),
    'docs should document executable runnable planner scripts when they are present'
  );
  assert(
    docsText.includes('ASSUMPTIONS.md') &&
      docsText.includes('self-grill its assumptions') &&
      docsText.includes('essential and unresolvable by evidence or discovery'),
    'docs should document planner self-interrogation and the assumptions artifact'
  );
  assert(
    docsText.includes('recoverable crash ledger rows') &&
      docsText.includes('Codex is allowed to inspect logs and remote state') &&
      docsText.includes('update `PLAN.md`') &&
      docsText.includes('continue the same `GOAL.md`'),
    'docs should document long-goal executor recovery instead of one-shot blocking'
  );
  assert(
    docsText.includes('continue-biased completion gate') &&
      docsText.includes('only an explicit `complete` verdict stops cleanly') &&
      docsText.includes('without inventing new scope'),
    'docs should document direct exhausted-plan completion gate behavior'
  );
  assert(
    docsText.includes('TUI header displays the current rollback checkpoint') &&
      docsText.includes('rollback pending'),
    'docs should document visible rollback checkpoint status in the TUI'
  );
  assert(
    docsText.includes('The absence of `.opt` scripts is a valid fresh V1 path') &&
      docsText.includes('no-script plans still execute directly'),
    'docs should document no-script PLAN.md execution as a valid fresh V1 path'
  );
  assert(
    docsText.includes('planning-time web research or remote discovery') && docsText.includes('does not pass a custom tool allowlist or denylist'),
    'docs should document native Claude plan-mode tool availability'
  );
  assert(
    docsText.includes('npm run release:preflight') && docsText.includes('automated V1 core gate') && docsText.includes('secret scanning'),
    'docs should document the release preflight command'
  );
  assert(
    docsText.includes('npm run release:tag -- 0.1.0') && docsText.includes('It never pushes') && docsText.includes('If preflight fails'),
    'docs should document the guarded release tag command'
  );
  assert(docsText.includes('docs/v1-completion-audit.md'), 'docs should link the V1 completion audit');
  assert(completionAudit.includes('Release preflight runs the automated V1 core gate'), 'completion audit should record the automated release gate');
  assert(completionAudit.includes('npm run verify:v1-core'), 'completion audit should list core verification commands');
  assert(completionAudit.includes('npm run verify:tui-chat-intake'), 'completion audit should list the Chat-first intake verification command');
  assert(
    completionAudit.includes('degraded_inspection_does_not_start_planner') &&
      completionAudit.includes('degraded_plan_request_starts_planner'),
    'completion audit should include blank-run Chat-agent gating evidence'
  );
  assert(completionAudit.includes('agent and effort selection') && completionAudit.includes('model fixed by agent'), 'completion audit should include runtime selection evidence');
  assert(completionAudit.includes('npm run verify:tui-chat-pty') && completionAudit.includes('pty_chat_first'), 'completion audit should include real PTY Chat-first verification evidence');
  assert(completionAudit.includes('npm run verify:tui-real-fake-chat') && completionAudit.includes('pty_chat_first_real_mode_fake_clis'), 'completion audit should include real-mode fake CLI Chat-first evidence');
  assert(
    completionAudit.includes('npm run verify:tui-planner-clarification-pty') &&
      completionAudit.includes('pty_planner_clarification') &&
      completionAudit.includes('question_answered'),
    'completion audit should include real PTY planner clarification evidence'
  );
  assert(
    completionAudit.includes('npm run verify:tui-hotreload-pty') &&
      completionAudit.includes('pty_hot_reload') &&
      completionAudit.includes('ledger_rows: 2'),
    'completion audit should include real PTY hot reload evidence'
  );
  assert(completionAudit.includes('npm run verify:legacy-optimizer'), 'completion audit should list the legacy optimizer aggregate verification command');
  assert(completionAudit.includes('planning-time web research and remote discovery'), 'completion audit should include native planner tool availability evidence');
  assert(completionAudit.includes('npm run verify:self-interrogation') && completionAudit.includes('assumptions_materialized'), 'completion audit should include self-interrogation evidence');
  assert(completionAudit.includes('npm run verify:direct-no-scripts'), 'completion audit should include direct no-script verification evidence');
  assert(
    completionAudit.includes('npm run verify:continuation-verdict') &&
      completionAudit.includes('ambiguous_falls_back_to_continue'),
    'completion audit should include direct continuation verdict evidence'
  );
  assert(
    completionAudit.includes('npm run verify:direct-recovery') &&
      completionAudit.includes('recoverable_failure') &&
      completionAudit.includes('resumed_executor'),
    'completion audit should include direct executor recovery evidence'
  );
  assert(completionAudit.includes('npm run verify:existing-goal') && completionAudit.includes('continued_without_new_goal'), 'completion audit should include existing-goal continuation verification evidence');
  assert(completionAudit.includes('no `.opt` scripts are required to start Codex'), 'completion audit should make no-script execution explicit');
  assert(completionAudit.includes('historical `baseline.json` files are not a supervisor baseline gate'), 'completion audit should cover historical baseline isolation');
  assert(completionAudit.includes('does not force `.opt/measure.sh` to emit a WiCi metric schema'), 'completion audit should include no forced measurement schema evidence');
  assert(completionAudit.includes('initial_plan_usage_streamed'), 'completion audit should include initial planner token usage streaming evidence');
  assert(completionAudit.includes('token usage is visible in the Execution pane'), 'completion audit should include TUI token usage visibility evidence');
  assert(completionAudit.includes('plan_diff_question') && completionAudit.includes('plan_diff_resumed_session'), 'completion audit should include hot-reload planner clarification evidence');
  assert(completionAudit.includes('planner-*.stdout.jsonl') && completionAudit.includes('.wici/codex-run.jsonl'), 'completion audit should include transcript evidence');
  assert(completionAudit.includes('as one goal') && completionAudit.includes('thin receipt/progress focus'), 'completion audit should include whole-goal Codex execution evidence');
  assert(
    completionAudit.includes('goal_source: tui_goal_option') &&
      completionAudit.includes('automation shortcut'),
    'completion audit should distinguish TUI --goal live-stream verification from Chat-first release evidence'
  );
  assert(
    completionAudit.includes('persisted executable and runnable') &&
      completionAudit.includes('asserts `.opt/checks.sh` and `.opt/measure.sh` are executable'),
    'completion audit should include executable runnable planner script evidence'
  );
  assert(completionAudit.includes('Chat pane restores current goal, user steering, and planner answers'), 'completion audit should include durable Chat history evidence');
  assert(completionAudit.includes('goal_doc_contains_steering'), 'completion audit should include GOAL.md steering persistence evidence');
  assert(completionAudit.includes('EXECUTE_STEERED') && docsText.includes('npm run verify:app-server-hotreload'), 'docs should cover Codex app-server steering after hot reload');
  assert(completionAudit.includes('legacy resume fallback') && docsText.includes('npm run verify:hotreload-resume'), 'docs should cover Codex exec resume fallback after hot reload');
  assert(completionAudit.includes('goal_source_not_retroactive'), 'completion audit should include non-retroactive initial goal provenance evidence');
  assert(completionAudit.includes('only ChatPane writes inbox injections') && completionAudit.includes('chat_writes_only_inbox'), 'completion audit should include single-writer TUI boundary evidence');
  assert(completionAudit.includes('historical_baseline_does_not_block_chat'), 'completion audit should include historical baseline isolation for Chat-first intake');
  assert(completionAudit.includes('default_iteration_budget_unbounded'), 'completion audit should include unbounded default budget evidence');
  assert(completionAudit.includes('direct_recovered'), 'completion audit should include direct V1 crash recovery evidence');
  assert(
    completionAudit.includes('TUI exposes the current rollback/version point') &&
      completionAudit.includes('Header `rollbackSummary`'),
    'completion audit should include TUI-visible rollback/version status evidence'
  );
  assert(completionAudit.includes('Existing goals can be continued or rewound') && completionAudit.includes('npm run verify:resume-iteration'), 'completion audit should include documented existing-goal resume evidence');
  assert(
    completionAudit.includes('/resume` in the TUI opens a selectable recovery page') &&
      completionAudit.includes('npm run verify:resume-selector') &&
      completionAudit.includes('EXECUTOR_RESUME_FALLBACK'),
    'completion audit should include selectable resume catalog and runnable preflight evidence'
  );
  assert(completionAudit.includes('clean checkout, build, core verification'), 'completion audit should include docs deployment evidence');
  assert(completionAudit.includes('Release tags are created only through a guarded command') && completionAudit.includes('npm run verify:release-tag'), 'completion audit should include guarded release tag evidence');
  assert(completionAudit.includes('npm run verify:ssh-evidence'), 'completion audit should include shared SSH evidence verifier');
  assert(completionAudit.includes('npm run verify:no-secrets'), 'completion audit should include committed secret scan verification');
  assert(supervisorIndex.includes("waitReason: 'PLAN_READY'"), 'fresh V1 path should be able to return PLAN_READY without a baseline');
  assert(supervisorIndex.includes('return runDirectPlanExecution'), 'fresh V1 path should feed PLAN.md directly to Codex execution');
  assert(supervisorIndex.includes('directContinuationVerdict') && supervisorIndex.includes('DIRECT_CONTINUATION_VERDICT'), 'direct V1 path should gate exhausted plans with a continuation verdict');
  assert(supervisorIndex.includes('LEGACY_BASELINE_IGNORED') && supervisorIndex.includes('legacy_optimizer === true'), 'fresh V1 should ignore historical baseline files unless the legacy optimizer is enabled');
  assert(supervisorIndex.includes("phase: 'direct_plan_diff'"), 'fresh V1 hot reload should emit planner diff token usage');
  assert(!supervisorIndex.includes('PREBASELINE'), 'fresh V1 supervisor should not expose pre-baseline setup events');
  assert(contextSource.includes('optional planner scripts'), 'context summary should describe .opt scripts as optional planner artifacts');
  assert(!contextSource.includes('locked eval scripts'), 'context summary must not tell direct-path Codex that eval scripts are locked by default');
  assert(!curriculumSource.includes('current best baseline'), 'curriculum wording must not assume a baseline for generic V1 runs');
  assert(!curriculumSource.includes('locked eval scripts'), 'curriculum wording must not assume locked eval scripts for generic V1 runs');
  assert(pkg.scripts['verify:legacy-optimizer']?.includes('verify:benchmark-manifest'), 'package should expose a legacy optimizer aggregate verifier');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:existing-goal'), 'fresh V1 core gate must include existing-goal continuation');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:direct-plan-continuation'), 'fresh V1 core gate must include exhausted direct plan continuation');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:self-interrogation'), 'fresh V1 core gate must include self-interrogation coverage');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:continuation-verdict'), 'fresh V1 core gate must include continuation verdict coverage');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:tui-real-fake-chat'), 'fresh V1 core gate must include real-mode fake CLI Chat-first TUI coverage');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:resume-selector'), 'fresh V1 core gate must include resume catalog coverage');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:tui-resume-selector-pty'), 'fresh V1 core gate must include PTY resume selector coverage');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:resume-rerunnable'), 'fresh V1 core gate must include runnable resume preflight coverage');
  for (const verifier of releaseResumeVerifiers) {
    assert(pkg.scripts['verify:v1-core']?.includes(verifier), `fresh V1 core gate must include release resume verifier ${verifier}`);
    assert(docsText.includes(`npm run ${verifier}`), `docs must document release resume verifier ${verifier}`);
    assert(completionAudit.includes(verifier), `completion audit must document release resume verifier ${verifier}`);
  }
  assert(pkg.scripts['verify:v1-core']?.includes('verify:app-server-hotreload'), 'fresh V1 core gate must include Codex app-server steering after hot reload');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:hotreload-resume'), 'fresh V1 core gate must include Codex exec resume fallback after hot reload');
  assert(pkg.scripts['release:preflight'] === 'npm run verify:v1-core', 'package should expose a release preflight that runs core V1 checks');
  assert(pkg.scripts['release:tag']?.includes('src/release/tag.ts'), 'package should expose the guarded release tag command');
  assert(releaseTagSource.includes("['run', 'release:preflight']") && releaseTagSource.includes("['tag', '-a', tag") && !releaseTagSource.includes("['push'") && !releaseTagSource.includes('git push'), 'guarded release tag command should run preflight before local tag and never push');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:release-tag') && releaseTagVerifier.includes('no_tag_after_failed_preflight'), 'fresh V1 core gate should include guarded release tag behavior checks');
  assert(!pkg.scripts['verify:v1-core']?.includes('verify:legacy-optimizer'), 'fresh V1 core gate must not run legacy optimizer aggregate');

  console.log(
    JSON.stringify(
      {
        ok: true,
        docs_verify_scripts: docsVerifyScripts.length,
        package_verify_scripts: packageVerifyScripts.length,
        no_planner_schema: true,
        no_prebaseline_path: true,
        legacy_optimizer_opt_in: true,
        plan_v1_constraints_current: true
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
