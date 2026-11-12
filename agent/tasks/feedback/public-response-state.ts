export interface PublicResponseState {
  attempted?: boolean;
  receipt?: unknown;
  code?: string;
  withheld?: boolean;
}

/** eligibility never erases an attempted write or turns uncertainty into permission to repost. */
export default function publicResponseState(state: PublicResponseState) {
  if (state.withheld) return 'withheld';
  if (
    state.code &&
    /denied|revoked|cancel|changed|mismatch|conflict|unavailable|permission|authentication/.test(
      state.code,
    )
  )
    return 'blocked';
  if (state.receipt && !state.code) return 'delivered';
  if (state.attempted) return 'unconfirmed';
  return state.code ? 'blocked' : 'pending';
}
