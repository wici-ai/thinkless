import React from 'react';
import { Box, Text } from 'ink';
import type { RunState } from './useRunState.js';
import type { GoalFile, LedgerEntry, RunEvent } from '../shared/types.js';

export function Header({ state }: { state: RunState }) {
  const checkpoint = state.checkpoint;
  const baseline = state.baseline;
  const goal = state.goal;
  const last = state.events.at(-1);
  const iter = checkpoint?.iter ?? 0;
  const status = checkpoint?.supervisor_state ?? 'INTAKE';

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text bold>WiCi</Text>
      <Text color={status === 'FAILED' ? 'red' : status === 'STOP' ? 'green' : 'cyan'}>{status}</Text>
      <Text>iter {iter}</Text>
      <Text>{metricSummary(goal, baseline?.best_metric.p99, baseline?.best_metric.unit)}</Text>
      <Text>{costSummary(state.ledger)}</Text>
      <Text>{elapsedSummary(state.events)}</Text>
      <Text color={last?.level === 'error' ? 'red' : last?.level === 'warn' ? 'yellow' : 'gray'}>{last?.type ?? 'idle'}</Text>
    </Box>
  );
}

export function metricSummary(goal: GoalFile | null, bestP99: number | undefined, unit: string | undefined): string {
  const metricName = goal?.metric.name ?? 'p99';
  const metricUnit = unit ?? goal?.metric.unit ?? '';
  const best = bestP99 === undefined ? 'pending' : `${formatNumber(bestP99)}${metricUnit}`;
  if (goal?.metric.target === undefined || goal.metric.target === null) return `best ${metricName} ${best}`;
  const op = goal.metric.direction === 'minimize' ? '<=' : '>=';
  return `${metricName} ${best} target ${op}${formatNumber(goal.metric.target)}${metricUnit}`;
}

export function costSummary(ledger: LedgerEntry[]): string {
  const total = ledger.reduce(
    (sum, entry) => ({
      wallMs: sum.wallMs + (entry.cost.wall_ms ?? 0),
      tokens: sum.tokens + (entry.cost.tokens_input ?? 0) + (entry.cost.tokens_output ?? 0),
      usd: sum.usd + (entry.cost.usd ?? 0)
    }),
    { wallMs: 0, tokens: 0, usd: 0 }
  );
  if (total.usd > 0) return `cost $${total.usd.toFixed(total.usd < 1 ? 4 : 2)}`;
  if (total.tokens > 0) return `cost ${Math.round(total.tokens)} tok`;
  if (total.wallMs > 0) return `cost ${duration(total.wallMs)}`;
  return 'cost pending';
}

export function elapsedSummary(events: RunEvent[]): string {
  if (events.length < 2) return 'elapsed 0s';
  const first = Date.parse(events[0].ts);
  const last = Date.parse(events[events.length - 1].ts);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return 'elapsed 0s';
  return `elapsed ${duration(last - first)}`;
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds > 0 ? `${minutes}m${restSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h${restMinutes}m` : `${hours}h`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
