/** one occurrence owns its deadline; completed checkpoints outlive the request signal. */
export default class DiscoveryBudget {
  operation = 'discovery';
  completed = 0;
  readonly signal: AbortSignal;
  readonly deadline: number;
  constructor(
    milliseconds = 20000,
    parent?: AbortSignal,
    readonly clock = Date.now,
  ) {
    this.deadline = clock() + milliseconds;
    this.signal = AbortSignal.any([AbortSignal.timeout(milliseconds), ...(parent ? [parent] : [])]);
  }
  get exhausted() {
    return this.signal.aborted || this.clock() >= this.deadline - 250;
  }
  get remaining() {
    return Math.max(0, this.deadline - this.clock());
  }
  fork(milliseconds: number) {
    return new DiscoveryBudget(
      Math.max(0, Math.floor(Math.min(milliseconds, this.remaining))),
      this.signal,
      this.clock,
    );
  }
  check() {
    if (this.exhausted) throw new DiscoveryPaused();
  }
  async read<T>(operation: string, read: () => Promise<T>) {
    this.operation = operation;
    this.check();
    return read();
  }
}

export class DiscoveryPaused extends Error {
  constructor() {
    super('discovery-budget-exhausted');
  }
}
