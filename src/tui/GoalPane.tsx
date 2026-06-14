import React, { useEffect, useMemo, useRef } from 'react';
import { Box, Text, useFocus } from 'ink';
import type { RunState } from './useRunState.js';

interface PlanLineView {
  text: string;
  added: boolean;
}

export interface PlanDiffView {
  lines: PlanLineView[];
  added: number;
  removed: number;
  changed: boolean;
}

export function GoalPane({ state }: { state: RunState }) {
  const { isFocused } = useFocus({ id: 'goal' });
  const goal = state.goal;
  const goalLines = state.goalDoc.split('\n').filter(Boolean).slice(0, 12);
  const previousPlan = useRef(state.plan);
  const diff = useMemo(() => buildPlanDiffView(previousPlan.current, state.plan, 34), [state.plan]);

  useEffect(() => {
    previousPlan.current = state.plan;
  }, [state.plan]);

  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      <Text bold color={isFocused ? 'magentaBright' : 'magenta'}>
        热 GOAL {goal ? `v${goal.version}` : ''}{diff.changed ? ` Δ +${diff.added} -${diff.removed}` : ''}
      </Text>
      <Box flexDirection="column">
        {goalLines.map((line, index) => (
          <Text key={`${index}-${line}`} color={goalLineColor(line)}>
            {line.length > 72 ? `${line.slice(0, 69)}...` : line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {diff.lines.map((line, index) => (
          <Text key={`${index}-${line.text}`} color={planLineColor(line)}>
            {line.added ? '+ ' : '  '}{line.text.length > 70 ? `${line.text.slice(0, 67)}...` : line.text}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

export function buildPlanDiffView(previousPlan: string, currentPlan: string, limit: number): PlanDiffView {
  const previous = planLines(previousPlan);
  const current = planLines(currentPlan);
  const remainingPrevious = counts(previous);
  const remainingCurrent = counts(current);

  let added = 0;
  const lines = current.map((text) => {
    const previousCount = remainingPrevious.get(text) ?? 0;
    if (previousCount > 0) {
      remainingPrevious.set(text, previousCount - 1);
      return { text, added: false };
    }
    added += 1;
    return { text, added: true };
  });

  let removed = 0;
  for (const text of previous) {
    const currentCount = remainingCurrent.get(text) ?? 0;
    if (currentCount > 0) {
      remainingCurrent.set(text, currentCount - 1);
    } else {
      removed += 1;
    }
  }

  return {
    lines: lines.slice(0, limit),
    added,
    removed,
    changed: added > 0 || removed > 0
  };
}

function planLines(plan: string): string[] {
  return plan.split('\n').map((line) => line.trim()).filter(Boolean);
}

function counts(lines: string[]): Map<string, number> {
  const output = new Map<string, number>();
  for (const line of lines) output.set(line, (output.get(line) ?? 0) + 1);
  return output;
}

function planLineColor(line: PlanLineView): string {
  if (line.added) return 'greenBright';
  if (line.text.includes('[>]')) return 'cyan';
  if (line.text.includes('[x]')) return 'green';
  if (line.text.includes('[!]')) return 'yellow';
  return 'white';
}

function goalLineColor(line: string): string {
  if (line.startsWith('#')) return 'magentaBright';
  if (line.includes('[dropped]')) return 'gray';
  if (line.includes('[active]')) return 'white';
  if (line.startsWith('-')) return 'gray';
  return 'white';
}
