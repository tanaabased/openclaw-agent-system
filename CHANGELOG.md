## {{ UNRELEASED_VERSION }} - [{{ UNRELEASED_DATE }}]({{ UNRELEASED_LINK }})

### New Features

- Added a fail-closed, durable GitHub message-adapter foundation for future notification replies.
- Added direct GitHub pull-request assignments with verified head metadata, private planning, safe replies, progress, and logical retirement. [#34](https://github.com/tanaabased/openclaw-agent-system/pull/34)
- Added explicit operator-scoped progress publication from active local GitHub notification sessions.
- Added live polling and connection health to `agent-system-github` channel status. [#17](https://github.com/tanaabased/openclaw-agent-system/pull/17)
- Added plan-first GitHub notification activation with private issue assessment and safety-gated public acknowledgment. [#18](https://github.com/tanaabased/openclaw-agent-system/pull/18)
- Added readable private GitHub assignment requests and structured Markdown plans while keeping issue context out of chat history. [#33](https://github.com/tanaabased/openclaw-agent-system/issues/33)
- Added revision-aware replies for approved GitHub issue mentions, with tool-free private turns, exact comment reauthorization, and durable public delivery. [#22](https://github.com/tanaabased/openclaw-agent-system/pull/22)
- Bound registered command-launcher descendants, including `git` and `gh`, to active OpenClaw and Codex agents with fail-closed admission. [#23](https://github.com/tanaabased/openclaw-agent-system/pull/23)

### Bug Fixes

- Fixed Agent System lifecycle logs to preserve clean CLI command output.
- Fixed GitHub notification doctor activation-failure counts to ignore logically retired items while retaining historical state. [#20](https://github.com/tanaabased/openclaw-agent-system/issues/20)
- Fixed active GitHub notification deliveries to complete logical retirement while preserving sessions and worktrees. [#21](https://github.com/tanaabased/openclaw-agent-system/issues/21)
- Fixed `github.notifications` to establish empty baselines during `install` and remove converged channel state on disable. [#17](https://github.com/tanaabased/openclaw-agent-system/pull/17)
- Fixed malformed notification acknowledgment output to fall back to a safe deterministic response instead of leaving assignment intake failed. [#22](https://github.com/tanaabased/openclaw-agent-system/pull/22)
- Fixed managed Codex config to set `allow_login_shell = false` and warn when user-managed config omits it. [#25](https://github.com/tanaabased/openclaw-agent-system/pull/25)
- Fixed managed command launchers to preserve bounded redirected standard input.
- Fixed managed `gh` launchers to accept root `--help`, `-h`, and `--version` flags used by repository helpers. [#25](https://github.com/tanaabased/openclaw-agent-system/pull/25)
- Fixed notification acknowledgment failures to persist and appear in `doctor` instead of remaining indefinitely pending.
- Fixed successful GitHub assignment intake to update the Channels UI's `Last inbound` status. [#19](https://github.com/tanaabased/openclaw-agent-system/pull/19)

## v0.3.0 - [August 13, 2026](https://github.com/tanaabased/openclaw-agent-system/releases/tag/v0.3.0)

### New Features

- Added the `agent-system-github` channel for OpenClaw. [#7](https://github.com/tanaabased/openclaw-agent-system/pull/7)

## v0.2.3 - [August 12, 2026](https://github.com/tanaabased/openclaw-agent-system/releases/tag/v0.2.3)

### New Features

- Added default-deny `github.policy.releases` protection for GitHub CLI and REST release mutations. [#13](https://github.com/tanaabased/openclaw-agent-system/pull/13)
- Narrowed Git policy to deny force pushes and remote-ref deletion by default while allowing other recognized operations. [#13](https://github.com/tanaabased/openclaw-agent-system/pull/13)

### Notes

- Removed broad Git and GitHub risk categories in favor of controls for specific provider-authorization gaps. [#13](https://github.com/tanaabased/openclaw-agent-system/pull/13)

## v0.2.2 - [August 12, 2026](https://github.com/tanaabased/openclaw-agent-system/releases/tag/v0.2.2)

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
