# Upgrading

See the [version compatibility matrix](./README.md#version-compatibility) for supported
OpenClaw and Node.js versions. This guide covers the changes since `v0.8.0`,
including earlier `v0.9.0` pre-release configurations.

## Skill names

Task workflow skills now use task terminology. Update explicit skill selections in
`agent.yaml`, saved prompts, and operator instructions using this mapping:

| Previous skill                      | Replacement                        |
| ----------------------------------- | ---------------------------------- |
| `agent-system-feedback-reply`       | `agent-system-github-reply`        |
| `agent-system-github-update`        | `agent-system-task-update`         |
| `agent-system-issue-assessment`     | `agent-system-task-assessment`     |
| `agent-system-issue-implementation` | `agent-system-task-implementation` |
| `agent-system-issue-launch`         | `agent-system-task-launch`         |

Preserve the `agent-system:` qualifier where the host requires it. Omitted skill
selections use the new defaults; old explicit IDs have no alias. Do not edit task
journals or retained source snapshots to replace historical names. Renaming a skill does
not change provider configuration keys such as `issue-assignment` or grant a new
workflow stage. Refresh the installed plugin and open a new Codex chat to load its
current skills.

## Minimum-Version Changes

Before changing the installation, [create and verify a backup](./CLI.md#openclaw-agent-system-backup-create).
Restore into a fresh staging directory; a verified archive does not make legacy workflow
state compatible with the new runtime. Review [notification workflow state](#notification-workflow-state)
before upgrading an installation that still has pre-reset tracking.

Upgrade OpenClaw before installing an Agent System release that requires a newer
host. Use a supported Node.js version, then run these commands from an operator
terminal in the same OpenClaw profile:

```sh
openclaw gateway stop
openclaw plugins disable agent-system
openclaw update --tag 2026.10.6 --no-restart
openclaw plugins update agent-system --accept-capabilities
openclaw plugins enable agent-system --accept-capabilities
openclaw plugins inspect agent-system --runtime --json
```

The Agent System update must select a published release compatible with the new
host; re-enabling the old package does not upgrade it. Plugin updates reuse the
recorded source and retain explicit version pins. For a pinned or linked install,
select the intended release or update the checkout using
[OpenClaw's plugin update guidance](https://docs.openclaw.ai/cli/plugins/uninstall-and-update#update).
If a shared Codex plugin is already installed, review its version and follow the
[shared prerequisite instructions](./CLI.md#openclaw-agent-system-install) to
explicitly upgrade an existing `@openclaw/codex@2026.9.8` installation to
`@openclaw/codex@2026.10.6` before workspace reconciliation. Agent installation
installs the plugin if it is required and missing. If an existing version conflicts,
you must resolve the conflict explicitly before retrying.
Start the upgraded Gateway and verify RPC readiness before reconciling workspaces;
OpenClaw automation reconciliation and inspection require a running Gateway:

```sh
openclaw gateway restart
openclaw gateway status --deep --require-rpc
```

Then run `openclaw agent-system install` from each managed workspace. If installation
reports configuration changes that require a Gateway restart, restart it and verify
RPC readiness again. Run `openclaw agent-system doctor` from each workspace to
verify the reconciled state.

If Node's executable path changed, also align the managed service's runtime;
`--no-restart` does not rebind it. See
[OpenClaw updates](https://docs.openclaw.ai/cli/update) for installation-method
and service-runtime details.

## GitHub workflow configuration

Replace retired `github.notifications` V1/V2 declarations with the
[current Version 3 configuration](./channels/github/ADVANCED.md#configuration-reference).
Set `github.schema-version: 3` and place workflow fields directly under `github`;
keep the outer workspace `schema-version: 1`. There is no compatibility alias or
automatic configuration migration.

Review the new identity-list and feedback rules rather than only moving keys.
`issue-assignment.mode` defaults to `auto`; set `plan` explicitly if you want
assessment without automatic implementation. Configured assignment actors and reviewers supply the feedback author set. Independent `review-request` execution
is unavailable, even when its reserved configuration validates.

Validate the updated manifest, then follow the
[native automation activation and verification steps](./channels/github/README.md).
Install creates the derived assignment automation; do not add a second copy under
`automations`. A successful Install or queued refresh is not proof of completed
issue work. Configuration conversion does not migrate saved workflow state.

## Notification workflow state

Legacy workflow decoding and repair are removed after the accepted reset rollout in
[#426](https://github.com/tanaabased/openclaw-agent-system/issues/426). Current work
keeps its explicit stage and native execution/publication receipts. Saved history from
before the reset is inactive. The runtime does not scan, repair, or resume it as active
workflow state.

Restore backups into staging. Do not copy pre-reset notification tracking into the
active state directory: a nonempty store without a reset generation stops with
`notification-state-reset-required`, and retired schema fields are rejected. The
original files are preserved. If old tracking must be restored, perform the supported
notification reset with its compatible reset-capable release before upgrading; do
not delete journals or invent assignment events to force intake. Ordinary reset
preserves issue chats, checkouts, branches, commits, pull requests, and assignments.
Current interrupted-work recovery and reset-generation fencing remain supported.

## Managed task cleanup

Review [cleanup and recovery](./channels/github/ADVANCED.md#cleanup-and-recovery)
before closing an issue with local work you still need. For a verified closed issue,
OpenClaw retirement may discard modified or untracked checkout files; a changed branch
name no longer blocks cleanup. Codex uses native desktop archival and preservation.
These retirement rules are separate from ordinary notification reset, which preserves
issue checkouts.

## Standalone Codex

After updating the plugin, review its hooks through `/hooks` in Codex CLI using the
same profile, then open a new chat. SessionStart loads the trusted binding;
PermissionRequest is optional and delegates approval for recognized runtime calls.
See [workspace setup and the approval boundary](./CODEX.md#workspace-setup) before
enabling it. Installation alone does not approve hooks.

Use Install and Doctor to reconcile and inspect the existing binding. Reinstallation
preserves the installation identity; do not rotate it to retry setup or transfer
active work. See [installation identity](./CODEX.md#workspace-setup) for copied
installations and explicit rotation.

## Managed collaboration

Ordinary install defaults to `auto` (registered managed agents). `all` now includes
unmanaged agents and future registrations. Operator grants are preserved; see
[collaboration configuration](./CONFIG.md#collaboration) for global access effects
and cleanup before deleting the final managed agent. Use ordinary install and
Doctor; the collaboration-only flags and explicit migration gate are removed.
