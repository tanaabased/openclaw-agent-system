## {{ UNRELEASED_VERSION }} - [{{ UNRELEASED_DATE }}]({{ UNRELEASED_LINK }})

### New Features

- Added explicit issue and direct pull-request lifecycle owners so admitted
  work is classified before lifecycle-specific resources are reconciled. [#37](https://github.com/tanaabased/openclaw-agent-system/issues/37)
- Added direct GitHub pull-request assignment intake with verified head metadata and logical retirement. [#34](https://github.com/tanaabased/openclaw-agent-system/pull/34)
- Added redacted `notifications status` and bounded semantic `notifications wait`
  commands for durable GitHub notification intake inspection and tests.
- Added one Work-mode issue comment loop with bounded comment admission,
  assignment-time OpenClaw session preparation, channel-scoped hidden instructions,
  ordinary inbound dispatch, and reauthorized idempotent GitHub publication. [#37](https://github.com/tanaabased/openclaw-agent-system/issues/37)
- Added manifest-selected GitHub assignment discovery and exact-item notification
  refreshes for isolated lifecycle automation.
- Added live polling and connection health to `agent-system-github` channel status. [#17](https://github.com/tanaabased/openclaw-agent-system/pull/17)
- Bound registered command-launcher descendants, including `git` and `gh`, to active OpenClaw and Codex agents with fail-closed admission. [#23](https://github.com/tanaabased/openclaw-agent-system/pull/23)

### Bug Fixes

- Fixed manual notification refresh and refresh-backed waits to bound agent
  turns, request one-shot harness cleanup, preserve exactly one JSON result on
  standard output, and exit after completion.
- Fixed issue-comment dispatch to require the assignment-created session,
  select hidden response instructions by the canonical channel id across both
  OpenClaw and Codex harnesses, and stage public replies through a typed tool
  instead of parsing the private Markdown response. Comment-turn failures remain
  outside provider polling backoff. [#37](https://github.com/tanaabased/openclaw-agent-system/issues/37)
- Fixed lifecycle intake to converge on a neutral `prepared` checkpoint instead
  of repeatedly reconciling admitted pull requests and worktree-ready issues. [#37](https://github.com/tanaabased/openclaw-agent-system/issues/37)
- Fixed Agent System lifecycle logs to preserve clean CLI command output.
- Fixed GitHub notification deliveries to complete logical retirement while preserving managed worktrees. [#21](https://github.com/tanaabased/openclaw-agent-system/issues/21)
- Fixed `github.notifications` to establish empty baselines during `install` and remove converged channel state on disable. [#17](https://github.com/tanaabased/openclaw-agent-system/pull/17)
- Fixed managed Codex config to set `allow_login_shell = false` and warn when user-managed config omits it. [#25](https://github.com/tanaabased/openclaw-agent-system/pull/25)
- Fixed managed command launchers to preserve bounded redirected standard input.
- Fixed managed `gh` launchers to accept root `--help`, `-h`, and `--version` flags used by repository helpers. [#25](https://github.com/tanaabased/openclaw-agent-system/pull/25)
- Fixed successful GitHub assignment intake to update the Channels UI's `Last inbound` status. [#19](https://github.com/tanaabased/openclaw-agent-system/pull/19)

### Notes

- Reorganized the GitHub channel around lifecycle, mode, intake, conversation,
  publication, provider, routing, state, and runtime owners, with structured
  context and hidden prompt composition in dedicated source files.
- Reorganized root implementation around agent, API, core, credential,
  environment, manifest, and path owners while retaining only cross-owner
  function primitives in `utils/`.
- Moved the GitHub notification CLI implementation into its owning channel.
- Split the packaged GitHub notification target design from its reusable visual
  presentation components and current-behavior channel guide.
- Removed the unfinished GitHub notification turn, planning, and publication
  runtime so the channel is again bounded to polling, admission, routing, and
  worktree intake while lifecycle messaging is rebuilt. [#37](https://github.com/tanaabased/openclaw-agent-system/issues/37)
- Kept comment revisions and publication receipts in separate private
  conversation state rather than adding prompt or messaging progress back to
  provider intake state.
- Removed the standalone pull-request and presentation Leia scenarios while the
  notification messaging refactor focuses on the installed issue lifecycle.
- Extended the issue Leia scenario from intake and worktree durability to one
  short approved comment response and GitHub publication.
- Migrated private notification state to lifecycle-aware schema 4 and removed
  unreachable session, publication, mode, and comment-tracking checkpoints.

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
