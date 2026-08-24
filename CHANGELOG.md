## {{ UNRELEASED_VERSION }} - [{{ UNRELEASED_DATE }}]({{ UNRELEASED_LINK }})

### New Features

- Added attributed incoming GitHub comment cards with manifest-owned agent emoji, OpenClaw identity links, and exact source-comment provenance.
- Added canonical GitHub issue forms for Task, Bug, and Feature intake.
- Added linked GitHub assignment cards, varied acknowledgments, active user-centric Work plans, and durable private implementation continuations that commit and push through the managed Git tool while keeping worktree checkpoints and comment reconciliation independent from response failures. [#48](https://github.com/tanaabased/openclaw-agent-system/pull/48)
- Added provider-verified commenter mentions with natural placeholder placement, deterministic fallback attribution, and preserved incoming Markdown source.
- Added registered GitHub lifecycle-mode-event turn contracts with durable prompt selection and file-backed reply candidates. [#44](https://github.com/tanaabased/openclaw-agent-system/pull/44)
- Added structured GitHub turn guidance and conversational GitHub-flavored Markdown replies with deterministic publication safety.

### Bug Fixes

- Fixed `devguard.json` to watch every active TypeScript owner without referencing removed paths.

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
