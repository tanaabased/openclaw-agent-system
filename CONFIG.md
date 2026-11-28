# Global Configuration

Each installation owns its global settings. Workspace declarations belong in the
[manifest](./MANIFEST.md).

- [OpenClaw plugin configuration](#openclaw-plugin-configuration)
  - [`cleanup`](#cleanup)
  - [`collaboration`](#collaboration)
  - [`opCache`](#opcache)
  - [`storage`](#storage)
- [Standalone Codex configuration](#standalone-codex-configuration)

## OpenClaw plugin configuration

Set these options under `plugins.entries.agent-system.config` in OpenClaw.

### `cleanup`

Controls the grace period for automatic managed-task retirement in OpenClaw and
standalone Codex.

| Field          | Type    | Required | Default | Description                                                |
| -------------- | ------- | -------- | ------- | ---------------------------------------------------------- |
| `graceMinutes` | integer | no       | `60`    | Minutes before eligible cleanup, from `0` through `43200`. |

An invalid or unreadable policy holds automatic cleanup.

```sh
# set the openclaw grace period for automatic cleanup.
openclaw config set plugins.entries.agent-system.config.cleanup.graceMinutes 30 --strict-json
```

New deadlines and activity resets use the current grace period. Even zero grace
keeps the [ownership and preservation checks](./channels/github/README.md#task-retirement).

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

After changing a secret in 1Password, wait for timed expiry or flush the cache.
In `process-lifetime` mode, flush or restart the Gateway. If a credential command
reports **invalidation pending**, restore Gateway access and flush.

Use `off` for time-varying credentials with a lifetime shorter than the cache
duration. Flushing the cache does not reset provider backoff or quota limits.

### `storage`

Set `storage.backend` in `agent.yaml` to select storage for the agent's Agent
System records. Use `sqlite` or `{ type: sqlite }`. Omitting it selects SQLite.

In standalone Codex, the bound agent's `storage.backend` also selects the
shared Agent System store. After switching agents, run Install. Agents configured
for the same shared backend retain access to the installation's records and each
agent keeps its own database.

In OpenClaw, `plugins.entries.agent-system.config.storage.backend` selects the
shared store. The first Install fills it if absent. Use `openclaw config file`
to locate the active configuration.

On OpenClaw, the installation setting also governs the native `state` and `agent`
database families, including enabled built-in memory. Doctor reports engine drift.
Use OpenClaw's database port when switching an existing native database.

If an installation still uses `file`, pause its writers and run
`scripts/import-agent-storage.ts` from the pre-upgrade source checkout. Verify
the import before removing the `file` setting and upgrading.

After the [SQLite cutover](https://github.com/tanaabased/openclaw-agent-system/pull/796),
you can ask in chat, “Switch Agent System to SQLite on this laptop after the
import, then show me the saved setting.” Set the backend in the bound manifest for Codex or the installation
configuration for OpenClaw, then run Doctor to verify access.

## Standalone Codex configuration

Set global options in `instance/config.json` under the Agent System plugin data
directory. Keep the file private (`0600`). For example, to change the default
60-minute cleanup grace period to 30 minutes:

```json
{
  "cleanup": { "graceMinutes": 30 }
}
```

On upgrade, bind the workspace and run Install. Install removes the legacy
`storage` and `onePassword` settings from this file and preserves cleanup
settings and existing SQLite data. SQLite needs no credential. For declared
1Password resources, enroll the bound workspace through Install. Rebinding
requires the new workspace's own enrollment. You can remove the retired
installation token from the OS credential store or revoke it in 1Password
if it has no other users.
