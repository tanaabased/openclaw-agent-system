# Global Configuration

Global settings belong in OpenClaw's plugin configuration. Workspace declarations
belong in the [manifest](./MANIFEST.md).

- [OpenClaw plugin configuration](#openclaw-plugin-configuration)
  - [`cleanup`](#cleanup)
  - [`collaboration`](#collaboration)
  - [`opCache`](#opcache)

## OpenClaw plugin configuration

Set these options under `plugins.entries.agent-system.config` in OpenClaw.
Standalone Codex does not read or manage them.

### `cleanup`

Controls the grace period for automatic managed-task retirement in OpenClaw.

| Field          | Type    | Required | Default | Description                                                |
| -------------- | ------- | -------- | ------- | ---------------------------------------------------------- |
| `graceMinutes` | integer | no       | `60`    | Minutes before eligible cleanup, from `0` through `43200`. |

Omitted cleanup or grace uses 60 minutes. Invalid or unavailable settings hold
cleanup instead of substituting a default. There is no enable/disable switch or
per-agent override. Standalone Codex always uses the shared 60-minute default;
it has no configurable cleanup setting.

```sh
# set the grace period for automatic cleanup in openclaw.
openclaw config set plugins.entries.agent-system.config.cleanup.graceMinutes 30 --strict-json
```

OpenClaw verifies the current cleanup setting before resource effects. A change
during the final check defers cleanup to the next pass. Existing deadlines survive
edits, polls, and restarts; new deadlines and activity resets use the current grace.
Even zero grace keeps the [ownership and preservation checks](./channels/github/README.md#task-retirement).

### `collaboration`

| Type                                                                  | Required | Default  |
| --------------------------------------------------------------------- | -------- | -------- |
| `"auto"`, `"all"`, `false`, or an array of exact registered agent IDs | no       | `"auto"` |

Install applies collaboration settings on each run. `"auto"` selects registered Agent
System-managed agents. `"all"` permits every OpenClaw agent, including unmanaged agents
and future registrations. A list selects exact registered IDs, including unmanaged
agents; unregistered IDs produce a warning. `false` or `[]` withdraws only Agent
System-owned grants, not independently configured operator access.

```sh
# select registered managed agents, then reconcile from a managed workspace.
openclaw config set plugins.entries.agent-system.config.collaboration auto
openclaw agent-system install

# select exact registered participants.
openclaw config set plugins.entries.agent-system.config.collaboration '["emori","smutlord"]' --strict-json
openclaw agent-system install

# withdraw owned grants before deleting the final managed agent.
openclaw config set plugins.entries.agent-system.config.collaboration false --strict-json
openclaw agent-system install
```

Install enables agent-to-agent access and `tools.sessions.visibility=all` as needed,
combining selected IDs with existing `tools.agentToAgent.allow` entries. Already
sufficient settings stay unchanged. On first setup, `auto` with fewer than two
managed agents does nothing; later installs still remove obsolete owned grants.
Missing or invalid managed workspaces block `auto` discovery.

> [!IMPORTANT]
> Collaboration settings apply globally. Participants can read sessions and send
> messages, subject to native tool and sandbox restrictions. They do not form isolated
> teams; retained external participants share access.

Install reports the resulting grants and newly connected participants; Doctor only
inspects them. Other permissions remain unchanged.

Operator-owned IDs and wildcard grants are preserved. `all` adds an owned `*` only
when needed; returning to `auto` removes it and restores the managed-agent selection.
Removing agents or changing selections withdraws only owned grants. If that empties
the allowlist, Install disables access because OpenClaw treats an empty enabled list
as unrestricted. Cleanup does not restore session visibility.

> [!WARNING]
> Before deleting the final managed agent, set `collaboration: false` and run Install
> from its workspace. Native deletion removes IDs but can leave an enabled empty
> allowlist, which OpenClaw treats as unrestricted. No background process repairs it.
> If this has already happened, disable native agent-to-agent access until you can
> run Install from a managed workspace.

Leave the adjacent `collaborationState` key unchanged. Install uses this saved record
to identify which grants Agent System may remove.

### `opCache`

Controls in-memory reuse of 1Password clients and resolved values. Gateway tools
share the cache; separate CLI processes do not. GitHub responses, permissions,
and command results are not cached.

| Field             | Type    | Required | Default | Behavior                                                                               |
| ----------------- | ------- | -------- | ------- | -------------------------------------------------------------------------------------- |
| `durationSeconds` | number  | no       | `300`   | Timed mode only; greater than zero, at most `4503599627370`.                           |
| `maxEntries`      | integer | no       | `128`   | Maximum agent/workspace entries, from `1` to `1024`; oldest entries are evicted first. |
| `mode`            | string  | no       | `timed` | `off`, `timed`, or `process-lifetime`.                                                 |

`timed` values expire from retrieval time; cache hits do not extend expiry.
Expired values refresh on demand without replacing an unchanged authenticated
client. `process-lifetime` retains values until invalidation, eviction, or exit;
`off` disables reuse between operations.

```bash
# retain values for five hours
openclaw config set plugins.entries.agent-system.config.opCache '{"mode":"timed","durationSeconds":18000}' --strict-json

# inspect the running gateway cache
openclaw agent-system credentials cache status --json

# flush one agent; omit --agent to flush all
openclaw agent-system credentials cache flush --agent data --json
```

See [`status`](./CLI.md#openclaw-agent-system-credentials-cache-status) and
[`flush`](./CLI.md#openclaw-agent-system-credentials-cache-flush) for Gateway permissions and output.

Agent System checks authorization and local credential or configuration changes on
each operation. Reload, agent removal, credential changes, flush, and shutdown clear
the cache; operations already using a value keep their snapshot. If a
credential command reports **invalidation pending**, restore Gateway access and
flush. External 1Password edits appear after timed expiry or flush; lifetime
mode requires flush or restart.

Failed or partial loads are not cached, and failed refreshes return errors rather
than stale credentials. OTP and unknown reference transforms bypass value
retention. Use off mode for other time-varying credentials whose validity is
shorter than the cache duration. Provider failures back off from 30 seconds to
one hour; SDK quota errors wait one hour. Flush does not reset backoff or quota.
