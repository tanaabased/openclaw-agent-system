# Upgrading

See the [version compatibility matrix](./README.md#version-compatibility) for supported
OpenClaw versions.

## GitHub V3 configuration

V3 keeps the existing workflow engine and retained state. It requires
`github.schema-version: 3` and moves workflow fields directly under `github`.
Production V2 decoding remains available during profile adoption; removing it is a
separate change. Do not reset intake, chats, or worktrees to change syntax.

Preview the effective policy from the base manifest and any local overlay:

```sh
openclaw agent-system migrate-github --json
```

For standalone Codex, use the installed plugin's `codex-runtime.js` with
`migrate-github --plugin-data <the trusted binding's plugin-data path>`. This route
uses the existing binding, reads both manifest sources, and returns the same JSON
preview without accessing provider credentials or installed OpenClaw state.

The preview does not write files. Its YAML is a **workflow fragment**, not a
replacement for the whole document: preserve account, token-binding, tool config,
keys, and unrelated sections. `requires-resolution` identifies feedback grants,
recipient overrides, or cleanup declarations that cannot be carried over without
an explicit operator decision. Do not adopt that draft until those decisions are
resolved. In particular, V3 has no feedback-off/replacement-author switch and always
assigns the original assignment actor to its PR.

Apply the reviewed workflow fragment to the base and overlay deliberately. Arrays
replace and mappings merge. Remove obsolete workflow fields from both sources;
retaining an old overlay can otherwise override the new values. With an explicit
V3 marker, the whole legacy `github.notifications` block is ignored and produces a
source-attributed warning; omitted V3 fields never inherit V2 values. Invalid V3
fails without fallback. Remove ignored blocks once the migration is verified.

Validate offline, then use the owning runtime's authorized Install and Doctor.
A supported workflow declaration provisions its required machinery even when
`allowed: []`; adding actors later is a live-policy edit. Confirm fresh versus
retained baseline behavior and one ordinary assignment/feedback journey separately
from parser and source-test success. Record readiness for each affected installation
before retiring V2 compatibility. Keep private profile contents private.

See the [V3 manifest contract](./MANIFEST.md#githubnotifications) for defaults,
identity forms, derived feedback authors, and rename behavior.

## Minimum-Version Changes

Upgrade OpenClaw before installing an Agent System release that requires a newer
host. Use a supported Node.js version, then run these commands from an operator
terminal in the same OpenClaw profile:

```sh
openclaw gateway stop
openclaw plugins disable agent-system
openclaw update --tag 2026.9.8 --no-restart
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
explicitly upgrade an existing `@openclaw/codex@2026.9.7` installation to
`@openclaw/codex@2026.9.8` before workspace reconciliation. Agent installation
provisions a missing applicable plugin but leaves conflicting existing versions
for explicit operator reconciliation.
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

## Shared cleanup policy

`github.notifications.cleanup` is no longer active configuration. Every explicit
legacy block, including `{}`, default values, and `enabled: false`, holds that
agent's automatic cleanup while unrelated issue work remains usable.

1. Inspect each agent's `agent.yaml` and sibling overlays for cleanup declarations.
2. Choose one installation grace using [shared cleanup settings](./CONFIG.md#shared-cleanup).
   Conflicting agent values are not imported or combined automatically. Omission
   means 60 minutes; there is no replacement disable switch.
3. Deliberately remove every legacy `github.notifications.cleanup` block. Removing
   `enabled: false` opts that agent into normal safe automatic cleanup.
4. Inspect the manifest diagnostics and retained retirement state on the next
   intake check. Resolve `retirement-cleanup-migration-required` or shared-file
   diagnostics before expecting resource reclamation. No re-admission or new chat
   is required for this configuration change.

Existing deadlines and uncertain cleanup receipts remain intact. Retirement first
observed while settings are blocked starts its grace only after configuration is
usable. Historical terminal records do not authorize cleanup or revive managed work.
Preserve archived resources and their ownership evidence.

## Notification workflow state

Legacy workflow decoding and repair are removed after the accepted reset rollout in
[#426](https://github.com/tanaabased/openclaw-agent-system/issues/426). Current work
keeps its explicit stage and native execution/publication receipts. Retained pre-reset
history is inert; it is not scanned, repaired, or resumed as active workflow state.

Restore backups into staging. Do not copy pre-reset notification tracking into the
active state directory: a nonempty store without a reset generation stops with
`notification-state-reset-required`, and retired schema fields are rejected. The
original files are preserved. If old tracking must be restored, perform the supported
notification reset with its compatible reset-capable release before upgrading; do
not delete journals or invent assignment events to force intake. Ordinary reset
preserves issue chats, checkouts, branches, commits, pull requests, and assignments.
Current interrupted-work recovery and reset-generation fencing remain supported.

## Managed collaboration

Ordinary install defaults to `auto` (registered managed agents). `all` now includes
unmanaged agents and future registrations. Operator grants are preserved; see
[collaboration configuration](./CONFIG.md#collaboration) for global access effects
and cleanup before deleting the final managed agent. Use ordinary install and
Doctor; the collaboration-only flags and explicit migration gate are removed.
