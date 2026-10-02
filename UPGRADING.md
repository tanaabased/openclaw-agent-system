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
openclaw update --tag 2026.9.7 --no-restart
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
select the required release. Agent installation provisions a missing plugin but
leaves conflicting existing versions for explicit operator reconciliation.
Then run `openclaw agent-system install` and `openclaw agent-system doctor` from
each managed workspace to reconcile and verify its desired state before restarting:

```sh
openclaw gateway restart
openclaw gateway status --deep --require-rpc
```

If Node's executable path changed, also align the managed service's runtime;
`--no-restart` does not rebind it. See
[OpenClaw updates](https://docs.openclaw.ai/cli/update) for installation-method
and service-runtime details.
