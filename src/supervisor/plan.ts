import { readFile } from 'node:fs/promises';
import { atomicWriteFile, exists } from '../shared/atomic.js';
import type { RunPaths } from '../shared/paths.js';

export interface PlanStep {
  id: string;
  status: 'pending' | 'active' | 'done' | 'blocked';
  text: string;
}

const statusFromMarker = (marker: string): PlanStep['status'] => {
  if (marker === 'x') return 'done';
  if (marker === '>') return 'active';
  if (marker === '!') return 'blocked';
  return 'pending';
};

const markerFromStatus = (status: PlanStep['status']): string => {
  if (status === 'done') return 'x';
  if (status === 'active') return '>';
  if (status === 'blocked') return '!';
  return ' ';
};

export async function readPlan(paths: RunPaths): Promise<string> {
  if (!(await exists(paths.plan))) return '';
  return readFile(paths.plan, 'utf8');
}

export function parsePlanSteps(plan: string): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const line of plan.split('\n')) {
    const match = /^-\s+\[([ x>!])\]\s+(S\d+)\s+(.+?)(?:\s+<!--.*)?$/.exec(line);
    if (!match) continue;
    steps.push({
      status: statusFromMarker(match[1]),
      id: match[2],
      text: match[3].trim()
    });
  }
  return steps;
}

export function nextExecutableStep(plan: string): PlanStep | null {
  return parsePlanSteps(plan).find((step) => step.status === 'pending' || step.status === 'active') ?? null;
}

export async function setPlanStepStatus(paths: RunPaths, stepId: string, status: PlanStep['status'], iter?: number): Promise<void> {
  const plan = await readPlan(paths);
  const marker = markerFromStatus(status);
  const next = plan
    .split('\n')
    .map((line) => {
      const match = /^(-\s+\[)([ x>!])(\]\s+)(S\d+)(\s+.+?)(?:\s+<!--.*)?$/.exec(line);
      if (!match || match[4] !== stepId) return line;
      const trailer = ` <!-- status:${status}${iter === undefined ? '' : ` iter:${iter}`} -->`;
      return `${match[1]}${marker}${match[3]}${match[4]}${match[5]}${trailer}`;
    })
    .join('\n');
  await atomicWriteFile(paths.plan, next);
}

export async function applyPlanDiff(paths: RunPaths, diff: { add?: Array<{ after: string; id: string; text: string }>; modify?: Array<{ id: string; text: string }>; obsolete?: string[] }): Promise<void> {
  const plan = await readPlan(paths);
  let lines = plan.split('\n');

  for (const item of diff.modify ?? []) {
    lines = lines.map((line) => {
      const match = /^(-\s+\[[ x>!]\]\s+)(S\d+)(\s+)(.+)$/.exec(line);
      if (!match || match[2] !== item.id) return line;
      return `${match[1]}${match[2]}${match[3]}${item.text}`;
    });
  }

  for (const id of diff.obsolete ?? []) {
    lines = lines.map((line) => {
      const match = /^-\s+\[([ x>!])\]\s+(S\d+)\s+(.+)$/.exec(line);
      if (!match || match[2] !== id || match[1] === 'x') return line;
      return `- [!] ${match[2]} ${match[3]} <!-- status:blocked obsolete:true -->`;
    });
  }

  for (const item of diff.add ?? []) {
    const insertAt = lines.findIndex((line) => new RegExp(`^-\\s+\\[[ x>!]\\]\\s+${item.after}\\b`).test(line));
    const line = `- [ ] ${item.id} ${item.text}`;
    if (insertAt >= 0) {
      lines.splice(insertAt + 1, 0, line);
    } else {
      lines.push(line);
    }
  }

  await atomicWriteFile(paths.plan, `${lines.join('\n').replace(/\n+$/, '')}\n`);
}
