export type ToolMode = 'real' | 'auto' | 'stub';

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

export type LedgerStatus = 'keep' | 'reject' | 'revert' | 'checks_failed' | 'crash';

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

export interface LessonEntry {
  id: string;
  ts: string;
  source_ledger_id: string;
  step_id: string;
  status: LedgerStatus;
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
  avenue: string;
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
  next_step: string | null;
  iter: number;
  goal_version: number;
  plan_hash: string | null;
  ledger_seq: number;
  events_seq: number;
  sessions: {
    planner?: string;
    executor?: string;
  };
  tool_versions?: {
    mode: ToolMode;
    codex?: string;
    claude?: string;
    checked_at: string;
  };
  active_avenue?: {
    name: string;
    parent_id: string | null;
    selected_at: string;
  };
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
    lessons?: string;
    skills_index?: string;
    skills?: Record<string, string>;
    curriculum?: string;
    context?: string;
    goal_interrogations?: string;
    archive?: string;
    avenues?: string;
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
  changed_files?: string[];
  next?: string;
}

export interface EvaluationConfig {
  noise_threshold: number;
  min_reps: number;
  bootstrap_resamples: number;
  checks_timeout_ms: number;
  measure_timeout_ms: number;
  lock_mode?: 'auto' | 'manual';
}

export interface RetryConfig {
  max_attempts_per_step: number;
  reverts_before_reset: number;
  stall_replan_after: number;
}

export interface DiversityConfig {
  avenues: string[];
}

export interface AvenueStat {
  name: string;
  selected: number;
  successes?: number;
  failures?: number;
  downstream_delta_pct?: number;
  last_sample?: number;
  last_selected_at?: string;
  last_parent_id?: string | null;
  last_outcome_ledger_id?: string;
}

export interface AvenueState {
  version: number;
  stats: AvenueStat[];
}

export interface WiCiConfig {
  tools: {
    mode: ToolMode;
    planner: {
      command: string;
      effort: string;
      dangerouslySkipPermissions: boolean;
    };
    executor: {
      command: string;
      dangerouslyBypassApprovalsAndSandbox: boolean;
    };
  };
  budget: BudgetConfig;
  stop: StopConfig;
  retry: RetryConfig;
  diversity: DiversityConfig;
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
  goal?: string;
  once?: boolean;
  maxIters?: number;
  mode?: ToolMode;
  lockMode?: 'auto' | 'manual';
  resumeIteration?: number;
}

export interface ToolInvocationResult {
  ok: boolean;
  sessionId?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
}
