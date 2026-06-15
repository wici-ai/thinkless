import type { GoalFile, MetricStats } from '../shared/types.js';

export const PLANNER_SELECTED_METRIC = 'planner-selected validation';

export function isPlannerSelectedMetricName(name: string): boolean {
  return name === PLANNER_SELECTED_METRIC || name === 'planner-selected metric';
}

export function primaryMetricName(goal: GoalFile): string {
  const name = goal.metric.name.trim();
  if (!name || isPlannerSelectedMetricName(name)) return 'validation';
  return name;
}

export function primaryMetricValue(metric: MetricStats): number {
  return typeof metric.value === 'number' && Number.isFinite(metric.value) ? metric.value : metric.p99;
}

export function formatPrimaryMetric(goal: GoalFile, metric: MetricStats): string {
  return `${primaryMetricName(goal)}=${formatMetricValue(metric)}`;
}

export function formatPrimaryMetricTransition(goal: GoalFile, before: MetricStats, after: MetricStats): string {
  return `${primaryMetricName(goal)} ${formatMetricValue(before)}->${formatMetricValue(after)}`;
}

export function primaryMetricTag(goal: GoalFile, metric: MetricStats): string {
  const name = slug(primaryMetricName(goal));
  const value = slug(`${Math.round(primaryMetricValue(metric))}${metric.unit}`);
  return `${name}-${value}`;
}

function formatMetricValue(metric: MetricStats): string {
  return `${formatNumber(primaryMetricValue(metric))}${metric.unit}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'metric';
}
