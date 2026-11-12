/** only schema-owned guidance belongs here; never include submitted values. */
export default class WorkflowRequestError extends Error {
  readonly recovery: { instruction: string };

  constructor(
    readonly code: string,
    instruction: string,
  ) {
    super(`${code}: ${instruction}`);
    this.recovery = { instruction };
  }
}
