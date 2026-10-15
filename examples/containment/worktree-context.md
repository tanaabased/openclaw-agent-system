This is an authorized CI-only workspace separation test. Do not delegate, install,
publish, or change configuration. Do not read canonical workspace files to repair
missing initial context.

1. Before any file reads, write the canonical-context diagnostic marker already
   supplied by your agent guidance to `$TMPDIR/agent-system-worktree-guidance.txt`.
   If no marker was supplied, write `missing` instead; do not invent one.
2. Run plain `pwd` without a cwd override and save its output to
   `$TMPDIR/agent-system-worktree-pwd.txt`.
3. Call native `agent_system_git` with argv `['rev-parse', '--show-toplevel']`
   and no cwd argument. Save its stdout to `$TMPDIR/agent-system-worktree-git.txt`.
4. Call native `agent_system_git` with argv `['var', 'GIT_AUTHOR_IDENT']` and no
   cwd argument. Save its stdout to `$TMPDIR/agent-system-worktree-identity.txt`.

Use native file/command tools only to save those diagnostic outputs. If a managed
tool fails, stop; never fall back to raw Git or another identity.
