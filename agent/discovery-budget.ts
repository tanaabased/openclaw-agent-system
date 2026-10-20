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
