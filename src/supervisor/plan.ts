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

const CHECKBOX_STEP_RE = /^-\s+\[([ x>!])\]\s+(S\d+)\s+(.+?)(?:\s+<!--.*)?$/;
const HEADING_STEP_RE = /^(#{2,4}\s+)(S\d+)(?:\s+[—-]\s+|\s+)(.+?)(?:\s+<!--.*)?$/;

export async function readPlan(paths: RunPaths): Promise<string> {
  if (!(await exists(paths.plan))) return '';
  return readFile(paths.plan, 'utf8');
}

export function parsePlanSteps(plan: string): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const line of plan.split('\n')) {
    const checkbox = CHECKBOX_STEP_RE.exec(line);
    if (checkbox) {
      steps.push({
        status: statusFromMarker(checkbox[1]),
        id: checkbox[2],
        text: checkbox[3].trim()
      });
      continue;
    }
    const heading = HEADING_STEP_RE.exec(line);
    if (heading) {
      steps.push({
        status: statusFromComment(line) ?? 'pending',
        id: heading[2],
        text: heading[3].replace(/\s+<!--.*?-->\s*$/, '').trim()
      });
    }
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
      const checkbox = /^(-\s+\[)([ x>!])(\]\s+)(S\d+)(\s+.+?)(?:\s+<!--.*)?$/.exec(line);
      const trailer = ` <!-- status:${status}${iter === undefined ? '' : ` iter:${iter}`} -->`;
      if (checkbox) {
        if (checkbox[4] !== stepId) return line;
        return `${checkbox[1]}${marker}${checkbox[3]}${checkbox[4]}${checkbox[5]}${trailer}`;
      }
      const heading = /^(#{2,4}\s+)(S\d+)(.*?)(?:\s+<!--.*)?$/.exec(line);
      if (!heading || heading[2] !== stepId) return line;
      return `${heading[1]}${heading[2]}${heading[3].replace(/\s+<!--.*?-->\s*$/, '').trimEnd()}${trailer}`;
    })
    .join('\n');
  await atomicWriteFile(paths.plan, next);
}

function statusFromComment(line: string): PlanStep['status'] | null {
  const match = /<!--\s*status:(pending|active|done|blocked)\b/.exec(line);
  return match ? (match[1] as PlanStep['status']) : null;
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
