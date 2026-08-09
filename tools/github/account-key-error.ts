/** Identify stable GitHub account-key failures across client, service, and lifecycle boundaries. */
export default class GitHubAccountKeyError extends Error {
  override name = 'GitHubAccountKeyError';

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
