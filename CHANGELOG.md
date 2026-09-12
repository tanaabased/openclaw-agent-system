## {{ UNRELEASED_VERSION }} - [{{ UNRELEASED_DATE }}]({{ UNRELEASED_LINK }})

### New Features

- Added agent-scoped GitHub identity projection for OpenClaw `install`, `doctor`, and native status tools. [#67](https://github.com/tanaabased/openclaw-agent-system/issues/67)
- Added canonical OpenClaw plugin and GitHub notification channel icons. [#67](https://github.com/tanaabased/openclaw-agent-system/issues/67)
- Added manifest-declared model defaults and work tiers with separate installation and readiness checks. [#85](https://github.com/tanaabased/openclaw-agent-system/issues/85)
- Added optional initial GitHub session owner, color, and group guidance through native OpenClaw session tools.
- Added configurable in-memory 1Password caching with Gateway status and flush commands. [#88](https://github.com/tanaabased/openclaw-agent-system/issues/88)
- Added per-approved-actor `operator-owner` opt-in, read-only doctor diagnostics,
  verified install reconciliation with shared grant provenance, and non-blocking
  initial-assignment session persistence checks.
- Published complete GitHub notification channel metadata for package-time
  discovery and kept it aligned with runtime registration.

### Bug Fixes

- Stopped Doctor from treating model authentication or runtime health as Agent System configuration failures. [#93](https://github.com/tanaabased/openclaw-agent-system/issues/93)
- Made Doctor and Install tables component-first with status-only color, neutral workspace metadata, readable wrapping, and stable attention-first Doctor ordering. [#80](https://github.com/tanaabased/openclaw-agent-system/issues/80)
- Preserved eligible unseen delivery pull-request comments and existing revision receipts during initial handoff, including interrupted retries, without changing reopen baselines. [#72](https://github.com/tanaabased/openclaw-agent-system/issues/72)
- Isolated GitHub reply-candidate turns by lifecycle conversation, bound staging to the active attempt, delayed acknowledgments until session recording, and retained assignment failure codes in refresh results. [#75](https://github.com/tanaabased/openclaw-agent-system/issues/75)
- Made notification doctor report blocked conversation-hook access, normal install reconcile and verify it, and Gateway turns require prompt attestation before model execution. [#76](https://github.com/tanaabased/openclaw-agent-system/issues/76)
- Fixed busy GitHub issues blocking intake and independent issue execution, with separate lifecycle state and shared repository preparation locks. [#71](https://github.com/tanaabased/openclaw-agent-system/issues/71) [#73](https://github.com/tanaabased/openclaw-agent-system/pull/73)
- Fixed managed GitHub worktrees to reuse configured SSH authentication across direct and notification preparation. [#67](https://github.com/tanaabased/openclaw-agent-system/issues/67)
- Made the installed agent and GitHub examples deterministic with strict AIMock fixtures while preserving real Gateway and tool execution. [#67](https://github.com/tanaabased/openclaw-agent-system/issues/67)
- Updated Agent System to support OpenClaw 2026.9.2 and newer while building against 2026.9.3. [#55](https://github.com/tanaabased/openclaw-agent-system/issues/55) [#67](https://github.com/tanaabased/openclaw-agent-system/issues/67)

## v0.5.3 - [August 27, 2026](https://github.com/tanaabased/openclaw-agent-system/releases/tag/v0.5.3)

### Bug Fixes

- Fixed approved GitHub issue and pull request comments to publish ordinary final responses instead of requiring `agent_system_github_reply`. [#62](https://github.com/tanaabased/openclaw-agent-system/pull/62)
- Fixed queued GitHub comments to publish up to two approved replies serially per polling reconciliation. [#62](https://github.com/tanaabased/openclaw-agent-system/pull/62)
- Fixed unsafe GitHub comment responses to publish a deterministic safe notice instead of being silently withheld. [#62](https://github.com/tanaabased/openclaw-agent-system/pull/62)

## v0.5.2 - [August 26, 2026](https://github.com/tanaabased/openclaw-agent-system/releases/tag/v0.5.2)

### New Features

- Added `agent-system-github-update` for publishing missing material progress from an issue's private session. [#58](https://github.com/tanaabased/openclaw-agent-system/pull/58)
- Added `guided` mode to prepare assignments and wait for explicit direction before implementation. [#58](https://github.com/tanaabased/openclaw-agent-system/pull/58)
- Added provider-verified `agent-system-github` retirement that archives inactive sessions and removes only clean managed worktrees. [#53](https://github.com/tanaabased/openclaw-agent-system/issues/53) [#56](https://github.com/tanaabased/openclaw-agent-system/pull/56)
- Added `pull-request-opened` handoffs that keep delivery pull requests in the issue-owned session and route replies to their exact source. [#57](https://github.com/tanaabased/openclaw-agent-system/pull/57)
- Added `work` mode delivery from assignment through planning, implementation, validation, push, and pull-request creation. [#48](https://github.com/tanaabased/openclaw-agent-system/pull/48)
- Updated `agent-system-github` replies with attributed cards, GitHub-flavored Markdown, and provider-verified commenter mentions. [#46](https://github.com/tanaabased/openclaw-agent-system/pull/46)

### Bug Fixes

- Fixed `agent-system-github` worktree recovery after verified GitHub repository renames. [#51](https://github.com/tanaabased/openclaw-agent-system/pull/51) [big-test-bucket#316](https://github.com/tanaabased/big-test-bucket/issues/316)
- Fixed `pull-request-opened` retries to preserve stable provider identity and completed handoffs. [#57](https://github.com/tanaabased/openclaw-agent-system/pull/57)
- Fixed `work` continuation to use trusted lifecycle state instead of model-authored headings. [#48](https://github.com/tanaabased/openclaw-agent-system/pull/48)

## v0.4.0 - [August 22, 2026](https://github.com/tanaabased/openclaw-agent-system/releases/tag/v0.4.0)

### New Features

- Added direct GitHub pull-request assignment intake with verified head metadata and logical retirement. [#34](https://github.com/tanaabased/openclaw-agent-system/pull/34)
- Added lifecycle-owned GitHub assignment intake with issue worktree preparation and neutral `prepared` checkpoints. [#17](https://github.com/tanaabased/openclaw-agent-system/pull/17) [#37](https://github.com/tanaabased/openclaw-agent-system/issues/37) [#42](https://github.com/tanaabased/openclaw-agent-system/pull/42)
- Added redacted `notifications status` and semantic `notifications wait` commands for durable intake inspection. [#42](https://github.com/tanaabased/openclaw-agent-system/pull/42)
- Added trusted issue-comment conversations with private session responses and reauthorized GitHub replies. [#37](https://github.com/tanaabased/openclaw-agent-system/issues/37) [#42](https://github.com/tanaabased/openclaw-agent-system/pull/42)
- Bound registered command-launcher descendants, including `git` and `gh`, to active OpenClaw and Codex agents with fail-closed admission. [#23](https://github.com/tanaabased/openclaw-agent-system/pull/23)

### Bug Fixes

- Fixed GitHub notification baselines, inbound status, and retirement without deleting managed worktrees. [#17](https://github.com/tanaabased/openclaw-agent-system/pull/17) [#19](https://github.com/tanaabased/openclaw-agent-system/pull/19) [#21](https://github.com/tanaabased/openclaw-agent-system/issues/21)
- Fixed managed Codex config to set `allow_login_shell = false` and warn when user-managed config omits it. [#25](https://github.com/tanaabased/openclaw-agent-system/pull/25)
- Fixed managed command launchers to preserve bounded redirected standard input. [#29](https://github.com/tanaabased/openclaw-agent-system/pull/29)
- Fixed notification CLI and lifecycle logging so one-shot JSON commands terminate with clean stdout. [#28](https://github.com/tanaabased/openclaw-agent-system/pull/28) [#42](https://github.com/tanaabased/openclaw-agent-system/pull/42)
- Fixed the Node 26 development baseline to compile against matching Node 26 type definitions. [#42](https://github.com/tanaabased/openclaw-agent-system/pull/42)

### Notes

- Consolidated Leia setup and diagnostics under `examples/.bin` and focused installed coverage on the issue lifecycle. [#42](https://github.com/tanaabased/openclaw-agent-system/pull/42)
- Reorganized GitHub channel source around lifecycle, intake, conversation, publication, provider, routing, state, and runtime owners. [#42](https://github.com/tanaabased/openclaw-agent-system/pull/42)
- Reorganized root source around `agent`, `api`, `core`, `credentials`, `environment`, `manifest`, and `paths` owners. [#42](https://github.com/tanaabased/openclaw-agent-system/pull/42)
- Split GitHub target design, presentation components, and shipped behavior across focused channel documentation. [#42](https://github.com/tanaabased/openclaw-agent-system/pull/42)
- Updated notification state to schema 4, separating intake state from conversation and publication receipts. [#37](https://github.com/tanaabased/openclaw-agent-system/issues/37) [#42](https://github.com/tanaabased/openclaw-agent-system/pull/42)

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
