export type ToolMode = 'real' | 'auto' | 'stub';
export type ExecutorBackend = 'auto' | 'app-server' | 'exec';
export type RuntimePane = 'chat' | 'planner' | 'executor';

export interface AgentRuntimeSelection {
  agent?: string;
  model?: string;
  effort?: string;
}

export interface RuntimeSelection {
  chat?: AgentRuntimeSelection;
  planner?: AgentRuntimeSelection;
  executor?: AgentRuntimeSelection;
}

export type RequirementStatus = 'active' | 'dropped' | 'done';

export interface Requirement {
  id: string;
  text: string;
  source: 'initial' | 'chat' | 'system';
  status: RequirementStatus;
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
  check: string;
}

export interface MetricGoal {
  name: string;
  direction: 'minimize' | 'maximize';
  target?: number | null;
  unit?: string;
}

export interface BudgetConfig {
  max_iters: number;
  max_cost_usd: number;
  deadline: string | null;
}

export interface StopConfig {
  tau: number;
  K: number;
  N: number;
  mode: 'auto' | 'ask';
}

export interface GoalFile {
  run_id: string;
  version: number;
  requirements: Requirement[];
  acceptance_criteria: AcceptanceCriterion[];
  constraints: string[];
  metric: MetricGoal;
  budget: BudgetConfig;
  stop: StopConfig;
}

export type InjectionKind = 'add_requirement' | 'drop_requirement' | 'steer' | 'answer' | 'abort';

export interface Injection {
  id: string;
  ts: string;
  kind: InjectionKind;
  text: string;
  priority?: 'normal' | 'urgent';
  reply_to?: string;
  applied?: boolean;
  coalesced_ids?: string[];
}

export interface ChatLogEntry {
  ts: string;
  role: 'user' | 'assistant';
  text: string;
  update?: {
    kind: 'add_requirement' | 'steer';
    text: string;
  };
}

export type OutboxKind = 'info' | 'question' | 'stop_verdict' | 'error';

export interface OutboxMessage {
  id: string;
  ts: string;
  kind: OutboxKind;
  text: string;
  reply_key?: string;
  answered?: boolean;
  answer_text?: string;
  answered_at?: string;
  data?: unknown;
}

export interface MetricStats {
  value?: number;
  p50: number;
  p95: number;
  p99: number;
  unit: string;
  n: number;
  warmup_discarded?: number;
  samples?: number[];
  guards?: Record<string, number>;
}

export interface EvalSha256 {
  measure: string;
  checks: string;
  benchmark_manifest?: string;
  acceptance_spec?: string;
  prescreen?: string;
  validate?: string;
  selftest_good_patch?: string;
  selftest_bad_patch?: string;
  files?: Record<string, string>;
}

export interface BaselineFile {
  best_commit: string;
  best_metric: MetricStats;
  heldout_metric?: MetricStats | null;
  eval_sha256: EvalSha256;
  created_at: string;
  updated_at: string;
  plan_hash: string;
}

export interface AcceptanceSpec {
  version: 1;
  run_id: string;
  frozen_goal_version: number;
  frozen_at: string;
  requirements: Requirement[];
  criteria: AcceptanceCriterion[];
  constraints: string[];
  metric: MetricGoal;
}

export interface BenchmarkManifest {
  version: 1;
  goal_run_id: string;
  selected_at: string;
  tool: string;
  command: string;
  metric: string;
  direction: 'minimize' | 'maximize';
  target?: number | null;
  unit?: string;
  min_reps: number;
  warmup_discarded: number;
  reason: string;
  alternatives?: Array<{
    tool: string;
    reason?: string;
  }>;
}

export type LedgerStatus = 'keep' | 'reject' | 'revert' | 'checks_failed' | 'crash' | 'preempted';

export interface LedgerEntry {
  id: string;
  ts: string;
  iter: number;
  step_id: string;
  commit: string | null;
  hypothesis: string;
  metric: MetricStats | null;
  baseline: MetricStats | null;
  delta_pct: number | null;
  confidence: string;
  ci_low?: number | null;
  ci_high?: number | null;
  p_value?: number | null;
  cost: {
    tokens_input?: number;
    tokens_output?: number;
    usd?: number;
    wall_ms?: number;
  };
  guards: Record<string, string | number | boolean>;
  status: LedgerStatus;
  reflection: string;
  parent_id?: string | null;
}

export interface ToolUsageSummary {
  events: number;
  completed_turns: number;
  completed_items: number;
  tokens_input?: number;
  tokens_output?: number;
  usd?: number;
  failed: boolean;
  errors: string[];
  parse_errors?: number;
}

export interface LessonEntry {
  id: string;
  ts: string;
  source_ledger_id: string;
  step_id: string;
  status: LedgerStatus;
  trigger?: 'measured_reject';
  author?: 'claude' | 'supervisor';
  lesson: string;
}

export interface SkillEntry {
  id: string;
  ts: string;
  source_ledger_id: string;
  step_id: string;
  title: string;
  summary: string;
  tags: string[];
  patch_path: string;
  patch_sha256: string;
  commit: string;
  delta_pct: number | null;
  uses: number;
}

export interface SkillLibrary {
  version: number;
  entries: SkillEntry[];
}

export interface CurriculumEntry {
  id: string;
  ts: string;
  iter: number;
  goal_version: number;
  parent_ledger_id: string | null;
  saturated_step_id: string;
  branch_reason: string;
  stuck_reason: string;
  attempts: number;
  consecutive_failures: number;
  sub_goal: string;
  status: 'applied';
}

export interface GoalInterrogationEntry {
  id: string;
  ts: string;
  iter: number;
  goal_version: number;
  restated_goal: string;
  active_requirement_ids: string[];
  acceptance_checks: string[];
  latest_ledger_id: string | null;
  recent_statuses: LedgerStatus[];
  aligned: boolean;
  concerns: string[];
}

export interface ArchiveEntry {
  ledger_id: string;
  ts: string;
  kind: 'accepted' | 'interesting_reject';
  step_id: string;
  commit: string;
  perf_commit?: string | null;
  metric: MetricStats | null;
  delta_pct: number | null;
  parent_id?: string | null;
  branch_count?: number;
  last_branched_at?: string;
}

export interface ArchiveState {
  version: number;
  entries: ArchiveEntry[];
}

export type SupervisorState =
  | 'INTAKE'
  | 'PLAN'
  | 'EXECUTE'
  | 'MEASURE'
  | 'EVALUATE'
  | 'COMMIT'
  | 'REVERT'
  | 'REFLECT'
  | 'STOP'
  | 'FAILED';

export interface Checkpoint {
  supervisor_state: SupervisorState;
  goal_source?: 'tui_chat' | 'tui_goal_option' | 'cli_goal' | 'api_goal';
  next_step: string | null;
  iter: number;
  setup_iter?: number;
  goal_version: number;
  plan_hash: string | null;
  best_commit?: string | null;
  ledger_seq: number;
  events_seq: number;
  sessions: {
    planner?: string;
    executor?: string;
    executorApp?: {
      threadId: string;
      activeTurnId?: string;
      updatedAt: string;
      workspace?: string;
      lastActivityAt?: string;
      phase?: 'starting' | 'running' | 'idle' | 'stalled' | 'completed';
      lastEventType?: string;
    };
  };
  tool_versions?: {
    mode: ToolMode;
    codex?: string;
    claude?: string;
    github?: string;
    wici?: {
      package_version?: string;
      git_commit?: string | null;
      git_dirty?: boolean;
    };
    checked_at: string;
  };
  active_branch?: {
    parent_id: string | null;
    selected_at: string;
    reason?: string;
  };
  consecutive_continuation_fallbacks?: number;
  drained_inbox: string[];
  updated_at: string;
}

export interface CheckpointSnapshot {
  version: 1;
  iter: number;
  checkpoint: Checkpoint;
  goal: GoalFile;
  head_commit: string;
  best_commit: string | null;
  files: {
    goal_doc?: string;
    lessons?: string;
    skills_index?: string;
    skills?: Record<string, string>;
    curriculum?: string;
    context?: string;
    goal_interrogations?: string;
    archive?: string;
  };
  created_at: string;
}

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RunEvent {
  seq?: number;
  ts: string;
  type: string;
  level: EventLevel;
  message: string;
  data?: unknown;
}

export interface IterResult {
  step_done: boolean;
  tests_pass: boolean;
  notes: string;
  changed_files: string[];
  next?: string | null;
}

export interface EvaluationConfig {
  noise_threshold: number;
  min_reps: number;
  bootstrap_resamples: number;
  checks_timeout_ms: number;
  measure_timeout_ms: number;
  lock_mode?: 'auto' | 'manual';
  legacy_optimizer?: boolean;
}

export interface RetryConfig {
  max_attempts_per_step: number;
  reverts_before_reset: number;
  stall_replan_after: number;
}

export interface WiCiConfig {
  tools: {
    mode: ToolMode;
    auto_update?: boolean;
    chat?: {
      command?: string;
      model?: string;
      effort?: string;
    };
    planner: {
      command: string;
      model?: string;
      effort: string;
    };
    executor: {
      command: string;
      backend?: ExecutorBackend;
      model?: string;
      effort?: string;
      dangerouslyBypassApprovalsAndSandbox: boolean;
    };
  };
  budget: BudgetConfig;
  stop: StopConfig;
  retry: RetryConfig;
  evaluation: EvaluationConfig;
  git: {
    init_if_missing: boolean;
    user_name: string;
    user_email: string;
  };
  safety: {
    container_hint: string;
    forbidden_actions: string[];
  };
}

export interface RunOptions {
  target: string;
  sessionDir?: string;
  goal?: string;
  goalSource?: Checkpoint['goal_source'];
  once?: boolean;
  maxIters?: number;
  mode?: ToolMode;
  lockMode?: 'auto' | 'manual';
  resumeIteration?: number;
  resumePreflight?: boolean;
  runtime?: RuntimeSelection;
  planningContext?: string;
}

export interface ToolInvocationResult {
  ok: boolean;
  sessionId?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  usage?: ToolUsageSummary;
}
