export default class GitWorktreeConflict extends Error {
  override name = 'GitWorktreeConflict';
  readonly code: string;

  constructor(reason: 'branch-exists' | 'path-occupied' | 'owner-mismatch', message: string) {
    super(message);
    this.code = `git-worktree-${reason}`;
  }
}
