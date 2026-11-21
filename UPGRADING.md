# Upgrading

See the [version compatibility matrix](./README.md#version-compatibility) for supported
OpenClaw and Node.js versions. This guide covers the changes since `v0.8.0`,
including earlier `v0.9.0` pre-release configurations.

## Automation model defaults

Prompt automations now inherit `models.default` when configured. Review effective
settings before Install: this can change cost, latency, or model availability.
Install also updates settings on existing managed chats. Explicit runtime targets
retain their native settings and reject explicit job model settings.
See [automation configuration and recovery](./MANIFEST.md#automations) for precedence
and handling busy chats or denied updates.

## Issue pickup automation

The generated pickup automation is now `📥 ISSUE PICKUP`, with declaration/YAML ID
`github-issue-pickup` instead of `github-project-pickup`, in OpenClaw and standalone Codex.
Its default chat name is `ISSUE PICKUP`, without the scheduler's emoji. Configure it
under `github.issue-pickup` and use `issue-pickup` in routing workflow lists.
The former `github.project-pickup` key and routing value `project-pickup` are no
longer accepted. Rename them to `issue-pickup` before upgrading, keeping the settings
and the nested `projects` list. If you configured pickup timing with `schedule`
or `window-minutes`, convert it to [start, window, and scans](./channels/github/CONFIG.md#githubissue-pickup).

Run normal Install in each runtime to create the replacement. Verify its name,
chat and native schedule, then manually delete the old scheduled automation.
Identify the old native job by declaration `github-project-pickup`: OpenClaw uses
`agent-system:<scope>:github-project-pickup` as its declaration key; Codex uses
`Managed by Agent System (codex:<scope>:github-project-pickup).` in its prompt.
Native scheduler IDs are installation-specific, not these declaration IDs.
OpenClaw-hosted Codex uses the OpenClaw schedule.

Normal cleanup may pause the old schedule but does not delete it. If standalone
Codex uses an explicit chat ID shared with the old active schedule, pause or delete
that old schedule **before** Install; the existing same-chat guard otherwise blocks
replacement. Do not delete historical chats or task records. This is replacement,
not identity migration or historical chat renaming.

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
selections use the new defaults. After updating explicit IDs, refresh the plugin and open a new Codex chat.

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
openclaw update --tag 2026.11.6 --no-restart
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
explicitly upgrade an existing older installation to
`@openclaw/codex@2026.11.6` before running workspace Install. Agent installation
installs the plugin if it is required and missing. If an existing version conflicts,
you must resolve the conflict explicitly before retrying.
Start the upgraded Gateway and verify RPC readiness before applying workspace settings.
Automation setup and inspection need a running Gateway:

```sh
openclaw gateway restart
openclaw gateway status --deep --require-rpc
```

Then run `openclaw agent-system install` from each managed workspace. If installation
reports configuration changes that require a Gateway restart, restart it and verify
RPC readiness again. Run `openclaw agent-system doctor` from each workspace to
check the resulting configuration.

If Node's executable path changed, also align the managed service's runtime;
`--no-restart` does not rebind it. See
[OpenClaw updates](https://docs.openclaw.ai/cli/update) for installation-method
and service-runtime details.

## GitHub workflow configuration

Declare `github.routing` for every workspace that uses scheduled GitHub workflows.
For example, to accept assignments in Tanaab repositories except those whose names start with `archive-`:

```yaml
github:
  schema-version: 3
  username: tanaabot
  routing:
    - '!tanaabased/archive-*'
    - 'tanaabased/*'
  issue-assignment:
    allowed: ['@pirog']
    mode: plan
```

Replace `github.allowed-repository-owners` with patterns matching the repositories
you intend. A renamed or transferred repository follows its current name. Put exceptions
before broader rules because the first match wins. Keep the workspace-level
`schema-version: 1` and put workflow fields directly under `github`. Preserve the
workspace’s credentials and approved actors. Set `mode: plan` to require direction
before implementation; the default is `auto`.

Validate the manifest, run Install, and [verify intake](./channels/github/README.md#install-and-verify).

## Notification workflow state

If an older installation reports `notification-state-reset-required`, back up the
workspace and use [notification reset](./channels/github/CLI.md#openclaw-agent-system-notifications-reset)
on a compatible release before upgrading. Restore backups to staging. Ordinary reset
preserves issue chats, checkouts, branches, commits, pull requests, and assignments.

## Managed task cleanup

Review [task retirement](./channels/github/README.md#task-retirement)
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
