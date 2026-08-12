## {{ UNRELEASED_VERSION }} - [{{ UNRELEASED_DATE }}]({{ UNRELEASED_LINK }})

### New Features

- Allowed clean managed-worktree removal without enabling destructive Git deletion policy. [#12](https://github.com/tanaabased/openclaw-agent-system/pull/12)

### Bug Fixes

- Allowed trusted operator Git commands to run in manifest-declared local repositories while preserving native-tool containment. [#10](https://github.com/tanaabased/openclaw-agent-system/pull/10)
- Fixed manifest-derived tool access across both per-agent allowlists and blocked installs on explicit deny conflicts. [#9](https://github.com/tanaabased/openclaw-agent-system/pull/9)
- Updated policy denials to identify the controlling field and required operator change. [#12](https://github.com/tanaabased/openclaw-agent-system/pull/12)

### Notes

- Removed transport-dependent `ask` policy decisions in favor of explicit `allow` and `deny` settings with migration diagnostics. [#12](https://github.com/tanaabased/openclaw-agent-system/pull/12)

## v0.2.1 - [August 11, 2026](https://github.com/tanaabased/openclaw-agent-system/releases/tag/v0.2.1)

### New Features

- Added agent-command guardrails and `doctor` diagnostics for cross-agent identity and operator-surface exposure. [#6](https://github.com/tanaabased/openclaw-agent-system/pull/6)
- Updated managed worktrees to use one deterministic branch and path for each repository and work id. [#6](https://github.com/tanaabased/openclaw-agent-system/pull/6)

### Bug Fixes

- Fixed managed repositories to refresh remotes only when creating a worktree while leaving configured local repositories untouched. [#6](https://github.com/tanaabased/openclaw-agent-system/pull/6)

### Notes

- Added dedicated Leia scenarios for managed worktrees and agent-command security boundaries. [#6](https://github.com/tanaabased/openclaw-agent-system/pull/6)
- Refactored plugin startup into capability-owned Git and GitHub composition with focused unit tests. [#6](https://github.com/tanaabased/openclaw-agent-system/pull/6)

## v0.2.0 - [August 10, 2026](https://github.com/tanaabased/openclaw-agent-system/releases/tag/v0.2.0)

### New Features

- Added direct 1Password secret references for named environment values. [#5](https://github.com/tanaabased/openclaw-agent-system/pull/5)
- Added the Agent System-managed [`git`](./tools/git/README.md) tool. [#5](https://github.com/tanaabased/openclaw-agent-system/pull/5)

### Bug Fixes

- Fixed Git private-key path containment, packaged shim resolution, managed-worktree manifest discovery, and policy handling for hazardous commands and raw worktree mutations. [#5](https://github.com/tanaabased/openclaw-agent-system/pull/5)

### Notes

- Added a reusable packaged launcher for Agent System command shims. [#5](https://github.com/tanaabased/openclaw-agent-system/pull/5)

## v0.1.1 - [August 9, 2026](https://github.com/tanaabased/openclaw-agent-system/releases/tag/v0.1.1)

- Initial release delivery

## v0.1.0 - [August 9, 2026](https://github.com/tanaabased/openclaw-agent-system/releases/tag/v0.1.0)

- Initial payload delivery
