import type { Checkpoint } from '../shared/types.js';
import type { DirectContinuationVerdict } from './stop.js';

export interface ContinuationFallbackState {
  count: number;
  stateKey?: string;
  counted: boolean;
}

export function continuationFallbackState(
  checkpoint: Pick<Checkpoint, 'ledger_seq' | 'plan_hash' | 'consecutive_continuation_fallbacks' | 'last_continuation_fallback_state_key'>,
  source: DirectContinuationVerdict['source']
): ContinuationFallbackState {
  if (source !== 'fallback') return { count: 0, stateKey: undefined, counted: false };

  const stateKey = `ledger:${checkpoint.ledger_seq}|plan:${checkpoint.plan_hash ?? 'missing'}`;
  const repeatedState = checkpoint.last_continuation_fallback_state_key === stateKey;
  return {
    count: repeatedState
      ? checkpoint.consecutive_continuation_fallbacks ?? 0
      : (checkpoint.consecutive_continuation_fallbacks ?? 0) + 1,
    stateKey,
    counted: !repeatedState
  };
}
