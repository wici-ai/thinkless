import type { SupervisorState } from '../shared/types.js';

export const stateOrder: SupervisorState[] = [
  'INTAKE',
  'PLAN',
  'EXECUTE',
  'MEASURE',
  'EVALUATE',
  'COMMIT',
  'REVERT',
  'REFLECT',
  'STOP',
  'FAILED'
];

export function isTerminalState(state: SupervisorState): boolean {
  return state === 'STOP' || state === 'FAILED';
}
