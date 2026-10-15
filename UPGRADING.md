# Upgrading

See the [version compatibility matrix](./README.md#version-compatibility) for supported
OpenClaw versions.

## Minimum-Version Changes

Upgrade OpenClaw before installing an Agent System release that requires a newer
host. Use a supported Node.js version, then run these commands from an operator
terminal in the same OpenClaw profile:

```sh
openclaw gateway stop
openclaw plugins disable agent-system
openclaw update --tag 2026.9.9 --no-restart
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
`@openclaw/codex@2026.9.9` before workspace reconciliation. Agent installation
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

## Managed collaboration

Ordinary install defaults to `auto` (registered managed agents). `all` now includes
unmanaged agents and future registrations. Operator grants are preserved; see
[collaboration configuration](./CONFIG.md#collaboration) for global access effects
and cleanup before deleting the final managed agent. Use ordinary install and
Doctor; the collaboration-only flags and explicit migration gate are removed.
