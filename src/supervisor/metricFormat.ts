import type { GoalFile, MetricStats } from '../shared/types.js';

export function primaryMetricName(goal: GoalFile): string {
  const name = goal.metric.name.trim();
  if (!name) return 'metric';
  return name.toLowerCase().includes('p99') ? 'p99' : name;
}

export function formatPrimaryMetric(goal: GoalFile, metric: MetricStats): string {
  return `${primaryMetricName(goal)}=${formatMetricValue(metric)}`;
}

export function formatPrimaryMetricTransition(goal: GoalFile, before: MetricStats, after: MetricStats): string {
  return `${primaryMetricName(goal)} ${formatMetricValue(before)}->${formatMetricValue(after)}`;
}

export function primaryMetricTag(goal: GoalFile, metric: MetricStats): string {
  const name = slug(primaryMetricName(goal));
  const value = slug(`${Math.round(metric.p99)}${metric.unit}`);
  return `${name}-${value}`;
}

function formatMetricValue(metric: MetricStats): string {
  return `${formatNumber(metric.p99)}${metric.unit}`;
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
