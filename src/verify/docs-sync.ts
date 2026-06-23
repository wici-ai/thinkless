import { readdir, readFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const [
    packageRaw,
    readme,
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
  const packageVerifyScripts = Object.keys(pkg.scripts)
    .filter((name) => name.startsWith('verify:'))
    .sort();
  const readmeVerifyScripts = [...new Set([...readme.matchAll(/npm run (verify:[a-z0-9:-]+)/g)].map((match) => match[1]))].sort();
  const releaseResumeVerifiers = [
    'verify:resume-selector',
    'verify:tui-resume-selector-pty',
    'verify:tui-resume-selector-built',
    'verify:tui-resume-legacy-candidate',
    'verify:tui-resume-current-candidate',
    'verify:tui-resume-interrupted-blocked',
    'verify:tui-resume-interrupted-runnable',
    'verify:tui-resume-empty-selector',
    'verify:tui-resume-many-candidates',
    'verify:tui-resume-stale-candidate',
    'verify:tui-resume-stale-agent-state',
    'verify:tui-resume-blocked-then-runnable',
    'verify:tui-resume-cross-target',
    'verify:resume-rerunnable'
  ];

  const missingFromReadme = packageVerifyScripts.filter((script) => !readmeVerifyScripts.includes(script));
  const extraInReadme = readmeVerifyScripts.filter((script) => !packageVerifyScripts.includes(script));
  assert(missingFromReadme.length === 0, `README command list missing package verify scripts: ${missingFromReadme.join(', ')}`);
  assert(extraInReadme.length === 0, `README command list has unknown verify scripts: ${extraInReadme.join(', ')}`);

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
  assert(simplifiedPlan.includes('每次 tag 前必须用 TUI 真实跑一遍泛化 canary'), 'Simplified_PLAN should require real canary before tag');
  assert(simplifiedPlan.includes('不要把“自己查资料”“失败后继续 debug”“更新 PLAN.md/.opt”之类 meta 指令塞进 canary Chat'), 'Simplified_PLAN should keep canary Chat free of planner/executor meta instructions');
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
  assert(readme.includes('Legacy optimizer compatibility checks'), 'README should explicitly separate legacy verifiers from core V1 checks');
  assert(readme.includes('WICI_LEGACY_OPTIMIZER=1'), 'README should document explicit opt-in for legacy optimizer behavior');
  assert(readme.includes('npm run verify:legacy-optimizer'), 'README should document the legacy optimizer aggregate verifier');
  assert(readme.includes('npm run verify:direct-no-scripts'), 'README should document the no-script direct PLAN.md verifier');
  assert(readme.includes('npm run verify:direct-recovery'), 'README should document the direct executor recovery verifier');
  assert(readme.includes('npm run verify:existing-goal') && readme.includes('without passing a new `--goal`'), 'README should document the existing-goal continuation verifier');
  assert(readme.includes('npm run verify:tui-chat-pty') && readme.includes('real pseudo-terminal'), 'README should document the real PTY Chat-first verifier');
  assert(readme.includes('npm run verify:tui-real-fake-chat') && readme.includes('fake Claude/Codex CLIs'), 'README should document the real-mode fake CLI Chat-first verifier');
  assert(readme.includes('npm run verify:tui-planner-clarification-pty') && readme.includes('resumes the planner session'), 'README should document the real PTY planner clarification verifier');
  assert(readme.includes('npm run verify:tui-hotreload-pty') && readme.includes('PLAN_DIFF_APPLIED'), 'README should document the real PTY hot reload verifier');
  assert(
    readme.includes('The first natural-language Chat message is ordinary conversation first') &&
      readme.includes('the Chat agent decides the work is large'),
    'README should document Chat-agent-gated blank-run planning'
  );
  assert(
    readme.includes('bounded SSH/code-reading request can stay in Chat') &&
      readme.includes('small self-contained edits without starting a run'),
    'README should document lightweight Chat work before planner/executor escalation'
  );
  assert(
    readme.includes('Chat agents run with enough native CLI permission') &&
      readme.includes('Claude Chat is not forced into plan-only mode') &&
      readme.includes('Codex Chat uses a network-capable sandbox'),
    'README should document Chat direct-work permissions'
  );
  assert(
    readme.includes('Press `Ctrl+R` to open the selector') &&
      readme.includes('bottom Chat input is paused while the selector is open') &&
      readme.includes('model is fixed by that agent') &&
      readme.includes('/agent chat claude') &&
      readme.includes('/effort execution high') &&
      readme.includes('Claude effort options are `high`, `xhigh`, `max`, and `ultracode`') &&
      readme.includes('Codex effort options are `fast`, `medium`, `high`, and `xhigh`') &&
      readme.includes('model_reasoning_effort'),
    'README should document per-workspace runtime selection commands'
  );
  assert(
    readme.includes('Terminal text selection/copy is the default pointer mode') &&
      readme.includes('cannot reliably provide native drag selection and app-level touchpad scrolling at the same time') &&
      readme.includes('Press `Ctrl+O`') &&
      readme.includes('`--mouse-reporting`'),
    'README should document explicit select/scroll pointer modes'
  );
  assert(readme.includes('WICI_PLANNER_EFFORT') && readme.includes('WICI_EXECUTOR_AGENT') && readme.includes('WICI_EXECUTOR_EFFORT'), 'README should document runtime environment overrides');
  assert(readme.includes('npm run verify:release-tag'), 'README should document the guarded release tag verifier');
  assert(readme.includes('planner-*.stdout.jsonl') && readme.includes('.wici/codex-run.jsonl'), 'README should document planner and Codex transcript paths');
  assert(readme.includes('git clone git@github.com:wici-ai/thinkless.git'), 'README should document a source checkout deployment path');
  assert(readme.includes('git checkout <verified-release-tag-or-commit>'), 'README should document pinning a verified WiCi version');
  assert(readme.includes('npm run build') && readme.includes('npm run verify:v1-core'), 'README deployment should include build and core verification');
  assert(
    readme.includes('## Resume Or Re-Run') &&
      readme.includes('without a new `--goal`') &&
      readme.includes('--resume-iteration 1') &&
      readme.includes('drained_inbox[]') &&
      readme.includes('open an in-TUI selector') &&
      readme.includes('runnable or blocked') &&
      readme.includes('RESUME_CONTEXT_VALIDATED'),
    'README should document continuing, rewinding, selectable resume, and idempotent hot-reload resume'
  );
  assert(config.budget?.max_iters === 0 && config.budget?.max_cost_usd === 0, 'default config should not impose cost or iteration hard caps');
  assert(readme.includes('default `max_iters` is `0`') && readme.includes('disable WiCi\'s own cost and iteration hard stops'), 'README should document unbounded default real-run budgets');
  assert(
    readme.includes('automatically checks for Codex/Claude updates at run boundaries') &&
      readme.includes('pending updates are not a WiCi supervisor start gate'),
    'README should document automatic Codex/Claude update checks without a pending-update start gate'
  );
  assert(
      readme.includes('## macOS Bootstrap') &&
      readme.includes('curl -fsSL https://github.com/wici-ai/thinkless/releases/latest/download/install.sh | bash') &&
      readme.includes('THINKLESS_TARBALL_URL') &&
      readme.includes('workflow is manually triggered') &&
      readme.includes('Publish public install release') &&
      readme.includes('From a clean machine') &&
      readme.includes('scripts/postinstall.mjs') &&
      readme.includes('THINKLESS_BOOTSTRAP=0') &&
      readme.includes('scripts/bootstrap-macos.sh') &&
      readme.includes('no `npm` yet') &&
      readme.includes('usable `sudo` access') &&
      readme.includes('verifies `sudo` access') &&
      readme.includes('does not run npm install scripts with `sudo`') &&
      readme.includes('Apple Command Line Tools') &&
      readme.includes('~/.zprofile') &&
      readme.includes('~/.zshrc') &&
      readme.includes('`node`, `npm`, `thinkless`, `codex`, `claude`, and `gh`') &&
      readme.includes('clean zsh login and interactive shells') &&
      readme.includes('export PATH=... && thinkless') &&
      readme.includes('auth onboarding status') &&
      readme.includes('codex login') &&
      readme.includes('/dev/tty') &&
      readme.includes('THINKLESS_AUTH_ONBOARDING=0') &&
      readme.includes('auth is pending'),
    'README should document public one-line install, automatic macOS install-time bootstrap, and the no-npm bootstrap path'
  );
  assert(
    readme.includes('`brew`, `git`, `node`, `npm`, `gh`, `codex`, and `claude`') &&
      readme.includes('GitHub CLI') &&
      readme.includes('gh auth login') &&
      readme.includes('gh auth status') &&
      readme.includes('Codex CLI') &&
      readme.includes('Claude Code CLI') &&
      readme.includes('Codex, Claude, and GitHub CLI commands'),
    'README should document GitHub CLI as a required installed and authenticated host dependency'
  );
  assert(
    readme.includes('THINKLESS_CONFIG_BUNDLE') &&
      readme.includes('~/.codex/config.toml') &&
      readme.includes('~/.codex/auth.json') &&
      readme.includes('~/.claude/settings.json') &&
      readme.includes('~/.claude/.credentials.json') &&
      readme.includes('keep them out of the repository'),
    'README should document user-scoped Codex/Claude config copying without committing secrets'
  );
  assert(
    readme.includes('Codex `doctor` reachability failures are recorded as diagnostics') &&
      readme.includes('not a hard real-mode start gate'),
    'README should document advisory Codex doctor diagnostics'
  );
  assert(
    installPage.includes('curl -fsSL https://wici.ai/thinkless/install.sh | bash') &&
      installPage.includes('navigator.clipboard.writeText') &&
      installPage.includes('thinking effort') &&
      installPage.includes('thinkless doctor --deep'),
    'docs install page should expose the public one-line installer, copy button, purpose, and verification command'
  );
  assert(
    readme.includes('Do not pass the canary as `--goal`; the release proof is the Chat-first path.'),
    'README should document Chat-first canary execution'
  );
  assert(
    readme.includes('Keep that first Chat as the real user request only') &&
      readme.includes('those requirements belong in the planner and executor prompts'),
    'README should keep canary Chat free of research/debug meta instructions'
  );
  assert(
    readme.includes('`GOAL.md + PLAN.md` as one goal') && !readme.includes('execute a `PLAN.md` step'),
    'README should document whole-goal Codex execution instead of the old step-only contract'
  );
  assert(
    readme.includes('optional planner scripts are persisted executable and runnable when present'),
    'README should document executable runnable planner scripts when they are present'
  );
  assert(
    readme.includes('ASSUMPTIONS.md') &&
      readme.includes('self-grill its assumptions') &&
      readme.includes('essential and unresolvable by evidence or discovery'),
    'README should document planner self-interrogation and the assumptions artifact'
  );
  assert(
    readme.includes('recoverable crash ledger rows') &&
      readme.includes('Codex is allowed to inspect logs and remote state') &&
      readme.includes('update `PLAN.md`') &&
      readme.includes('continue the same `GOAL.md`'),
    'README should document long-goal executor recovery instead of one-shot blocking'
  );
  assert(
    readme.includes('continue-biased completion gate') &&
      readme.includes('only an explicit `complete` verdict stops cleanly') &&
      readme.includes('without inventing new scope'),
    'README should document direct exhausted-plan completion gate behavior'
  );
  assert(
    readme.includes('TUI header displays the current rollback checkpoint') &&
      readme.includes('rollback pending'),
    'README should document visible rollback checkpoint status in the TUI'
  );
  assert(
    readme.includes('The absence of `.opt` scripts is a valid fresh V1 path') &&
      readme.includes('no-script plans still execute directly'),
    'README should document no-script PLAN.md execution as a valid fresh V1 path'
  );
  assert(
    readme.includes('planning-time web research or remote discovery') && readme.includes('does not pass a custom tool allowlist or denylist'),
    'README should document native Claude plan-mode tool availability'
  );
  assert(
    readme.includes('release_action: blocked_do_not_tag_or_push') && readme.includes('local release tags are not proof'),
    'README should document explicit blocked tag-gate action'
  );
  assert(
    readme.includes('npm run release:preflight') && readme.includes('automated V1 core gate') && readme.includes('real canary tag gate'),
    'README should document the release preflight command'
  );
  assert(
    readme.includes('npm run release:tag -- 0.1.0') && readme.includes('It never pushes') && readme.includes('exits before `git tag`'),
    'README should document the guarded release tag command'
  );
  assert(
    readme.includes('evidence commit must equal current `HEAD`') && readme.includes('current checkout must be clean'),
    'README should document current checkout matching for release tags'
  );
  assert(
    readme.includes('clean target git checkout') && readme.includes('uncommitted target changes'),
    'README should document target checkout cleanliness for passed release tags'
  );
  assert(readme.includes('mode: real') && readme.includes('stub canaries'), 'README should document real tool-mode requirement for passed release tags');
  assert(
    readme.includes('run_checkpoint.goal_source: "tui_chat"') &&
      readme.includes('goal_source: "tui_chat"'),
    'README should document TUI Chat checkpoint source evidence for passed canaries'
  );
  assert(
    readme.includes('the recorder requires `--started-from-empty-tui true`') &&
      readme.includes('`--operator-manual-execution false`'),
    'README should document passed-canary attestation requirements'
  );
  assert(
    readme.includes('artifacts/.wici/codex-run.jsonl') && readme.includes('checks the recorded sha256 and byte length') && readme.includes('remain executable'),
    'README should document committed release canary artifact files'
  );
  assert(readme.includes('npm run release:record-canary'), 'README should document the release canary recorder');
  assert(
    readme.includes('--started-from-empty-tui true') &&
      readme.includes('--operator-manual-execution false') &&
      readme.includes('--codex-attempted-ssh true'),
    'README should document explicit release canary attestation flags'
  );
  assert(readme.includes('--observed-value <number>') && readme.includes('observed value to reach the recorded target'), 'README should document passed canary observed value evidence');
  assert(readme.includes('docs/v1-completion-audit.md'), 'README should link the V1 completion audit');
  assert(completionAudit.includes('Current blocker') && completionAudit.includes('tag_allowed: false'), 'completion audit should record the current release blocker');
  assert(
    completionAudit.includes('Next required action') && completionAudit.includes('root@116.127.115.18:23276'),
    'completion audit should record the current canary next action'
  );
  assert(
    completionAudit.includes('predates checkpoint `goal_source` provenance') &&
      completionAudit.includes('operator Chat-first attestation') &&
      completionAudit.includes('canary_goal_source: tui_chat'),
    'completion audit should distinguish historical failed canary evidence from passed-canary Chat checkpoint provenance'
  );
  assert(
    readme.includes('Failed canaries record `failure_reason` and `next_required_action`'),
    'README should document explicit failed-canary blocker fields'
  );
  assert(completionAudit.includes('npm run verify:v1-core') && completionAudit.includes('npm run verify:tag-gate'), 'completion audit should list core and tag-gate verification commands');
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
  assert(completionAudit.includes('planner-initial.stdout.jsonl') && completionAudit.includes('.wici/codex-run.jsonl'), 'completion audit should include transcript evidence');
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
  assert(completionAudit.includes('EXECUTE_STEERED') && readme.includes('npm run verify:app-server-hotreload'), 'docs should cover Codex app-server steering after hot reload');
  assert(completionAudit.includes('legacy resume fallback') && readme.includes('npm run verify:hotreload-resume'), 'docs should cover Codex exec resume fallback after hot reload');
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
  assert(completionAudit.includes('clean checkout, build, core verification'), 'completion audit should include README deployment evidence');
  assert(completionAudit.includes('blocked_do_not_tag_or_push'), 'completion audit should include explicit tag/push blocker evidence');
  assert(completionAudit.includes('Release tags are created only through a guarded command') && completionAudit.includes('npm run verify:release-tag'), 'completion audit should include guarded release tag evidence');
  assert(
    completionAudit.includes('canary_tool_mode') &&
      completionAudit.includes('tag_gate_rejects_stub_mode_passed_canary') &&
      completionAudit.includes('recorder_rejects_stub_mode_passed_canary'),
    'completion audit should include real tool-mode release evidence'
  );
  assert(
    completionAudit.includes('canary_goal_source') &&
      completionAudit.includes('recorder_rejects_non_tui_passed_canary') &&
      completionAudit.includes('tag_gate_rejects_non_tui_passed_canary'),
    'completion audit should include TUI Chat goal-source release evidence'
  );
  assert(completionAudit.includes('release_version'), 'completion audit should include current WiCi version matching evidence');
  assert(completionAudit.includes('artifact_files_verified'), 'completion audit should include committed artifact hash verification evidence');
  assert(
      completionAudit.includes('canary_target_git_dirty') &&
      completionAudit.includes('target_clean_recorded') &&
      completionAudit.includes('tag_gate_rejects_passed_dirty_target') &&
      completionAudit.includes('recorder_rejects_dirty_target_passed_canary'),
    'completion audit should include target checkout cleanliness evidence'
  );
  assert(completionAudit.includes('optional_planner_scripts_executable'), 'completion audit should include executable planner script artifact evidence');
  assert(completionAudit.includes('codex_ssh_attempt_attested'), 'completion audit should include structured canary attestation evidence');
  assert(completionAudit.includes('codex_transcript_has_ssh_attempt'), 'completion audit should include Codex transcript SSH attempt evidence');
  assert(completionAudit.includes('npm run verify:ssh-evidence'), 'completion audit should include shared SSH evidence verifier');
  assert(completionAudit.includes('tag_gate_handles_non_ssh_canary'), 'completion audit should include non-SSH release canary gate evidence');
  assert(completionAudit.includes('recorder_rejects_unsupported_ssh_attestation'), 'completion audit should include recorder SSH attestation consistency evidence');
  assert(completionAudit.includes('recorder_rejects_wrong_ssh_target'), 'completion audit should include recorder SSH target consistency evidence');
  assert(completionAudit.includes('cli_rejects_contradictory_status'), 'completion audit should include recorder status consistency evidence');
  assert(completionAudit.includes('cli_rejects_invalid_passed_attestation'), 'completion audit should include recorder passed-attestation consistency evidence');
  assert(completionAudit.includes('cli_rejects_invalid_target_metadata'), 'completion audit should include recorder target metadata validation evidence');
  assert(completionAudit.includes('cli_rejects_invalid_passed_observed_value'), 'completion audit should include passed canary observed value evidence');
  assert(completionAudit.includes('passed_observed_target'), 'completion audit should include tag-gate target/observed report evidence');
  assert(completionAudit.includes('recorder_rejects_source_secrets'), 'completion audit should include recorder source artifact secret rejection evidence');
  assert(completionAudit.includes('npm run verify:no-secrets'), 'completion audit should include committed secret scan verification');
  assert(completionAudit.includes('secret_scan_ok'), 'completion audit should include tag-gate canary secret scan evidence');
  assert(completionAudit.includes('npm run verify:canary-evidence'), 'completion audit should include canary evidence recorder verification');
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
    assert(readme.includes(`npm run ${verifier}`), `README must document release resume verifier ${verifier}`);
    assert(completionAudit.includes(verifier), `completion audit must document release resume verifier ${verifier}`);
  }
  assert(pkg.scripts['verify:v1-core']?.includes('verify:app-server-hotreload'), 'fresh V1 core gate must include Codex app-server steering after hot reload');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:hotreload-resume'), 'fresh V1 core gate must include Codex exec resume fallback after hot reload');
  assert(pkg.scripts['release:preflight'] === 'npm run verify:v1-core && npm run verify:tag-gate', 'package should expose a release preflight that runs core V1 checks before tag gate');
  assert(pkg.scripts['release:tag']?.includes('src/release/tag.ts'), 'package should expose the guarded release tag command');
  assert(releaseTagSource.includes("['run', 'release:preflight']") && releaseTagSource.includes("['tag', '-a', tag") && !releaseTagSource.includes("['push'") && !releaseTagSource.includes('git push'), 'guarded release tag command should run preflight before local tag and never push');
  assert(pkg.scripts['verify:v1-core']?.includes('verify:release-tag') && releaseTagVerifier.includes('no_tag_after_failed_preflight'), 'fresh V1 core gate should include guarded release tag behavior checks');
  assert(!pkg.scripts['verify:v1-core']?.includes('verify:legacy-optimizer'), 'fresh V1 core gate must not run legacy optimizer aggregate');

  console.log(
    JSON.stringify(
      {
        ok: true,
        readme_verify_scripts: readmeVerifyScripts.length,
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
