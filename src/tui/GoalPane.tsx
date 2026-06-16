import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useFocus, useInput } from 'ink';
import type { RunState } from './useRunState.js';
import { isMouseInput, mouseScrollDelta } from './input.js';
import { PAGE_SIZE, scrollBy, wrappedViewport } from './viewport.js';

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

export const GoalPane = React.memo(function GoalPane({
  state,
  contentWidth = 42,
  viewportHeight = 18
}: {
  state: RunState;
  contentWidth?: number;
  viewportHeight?: number;
}) {
  const { isFocused } = useFocus({ id: 'goal' });
  const goal = state.goal;
  const previousPlan = useRef(state.plan);
  const diff = useMemo(() => buildPlanDiffView(previousPlan.current, state.plan), [state.plan]);
  const [scrollOffset, setScrollOffset] = useState(0);
  const sourceLines = useMemo(
    () =>
      [
        ...(state.goalDoc ? state.goalDoc.replace(/^```markdown\n?|\n?```\n?$/g, '').split('\n') : []),
        ...(state.goalDoc || state.plan ? ['', '--- PLAN.md ---'] : []),
        ...(state.plan ? state.plan.replace(/^```markdown\n?|\n?```\n?$/g, '').split('\n') : [])
      ],
    [state.goalDoc, state.plan]
  );
  const view = useMemo(() => wrappedViewport(sourceLines, contentWidth, scrollOffset, viewportHeight), [contentWidth, scrollOffset, sourceLines, viewportHeight]);

  useEffect(() => {
    previousPlan.current = state.plan;
  }, [state.plan]);

  useEffect(() => {
    setScrollOffset((current) => Math.min(current, view.maxScroll));
  }, [view.maxScroll]);

  useInput((input, key) => {
    const wheel = mouseScrollDelta(input);
    if (wheel !== 0) setScrollOffset((current) => scrollBy(current, wheel, view.maxScroll));
    else if (isMouseInput(input)) return;
    else if (key.upArrow || input === 'k') setScrollOffset((current) => scrollBy(current, 1, view.maxScroll));
    else if (key.downArrow || input === 'j') setScrollOffset((current) => scrollBy(current, -1, view.maxScroll));
    else if (key.pageUp || input === 'u') setScrollOffset((current) => scrollBy(current, PAGE_SIZE, view.maxScroll));
    else if (key.pageDown || input === 'd') setScrollOffset((current) => scrollBy(current, -PAGE_SIZE, view.maxScroll));
    else if (key.home || input === 'g') setScrollOffset(view.maxScroll);
    else if (key.end || input === 'G') setScrollOffset(0);
  }, { isActive: isFocused });

  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      <Text bold color={isFocused ? 'magentaBright' : 'magenta'}>
        GOAL / PLAN {goal ? `v${goal.version}` : ''}{diff.changed ? ` d +${diff.added} -${diff.removed}` : ''}
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        {view.lines.map((line, index) => (
          <Text key={`${view.start + index}-${line}`} color={goalLineColor(line)}>
            {line || ' '}
          </Text>
        ))}
      </Box>
      <Text color={scrollOffset > 0 ? 'yellow' : 'gray'}>{view.end}/{view.total || 0}</Text>
    </Box>
  );
});

export function buildPlanDiffView(previousPlan: string, currentPlan: string, limit = Number.POSITIVE_INFINITY): PlanDiffView {
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

function goalLineColor(line: string): string {
  if (line.startsWith('#')) return 'magentaBright';
  if (line.includes('[>]')) return 'cyan';
  if (line.includes('[x]')) return 'green';
  if (line.includes('[!]')) return 'yellow';
  if (line.includes('[dropped]')) return 'gray';
  if (line.includes('[active]')) return 'white';
  if (line === '--- PLAN.md ---') return 'magenta';
  if (line.startsWith('-')) return 'gray';
  return 'white';
}
