# Global Configuration

Set plugin-wide options under `plugins.entries.agent-system.config` in OpenClaw
configuration. Workspace declarations belong in the [manifest](./MANIFEST.md).

- [`collaboration`](#collaboration)
- [`githubNotifications`](#githubnotifications)
- [`opCache`](#opcache)

## `collaboration`

| Type                                                                  | Required | Default  |
| --------------------------------------------------------------------- | -------- | -------- |
| `"auto"`, `"all"`, `false`, or an array of exact registered agent IDs | no       | `"auto"` |

Ordinary install reconciles collaboration. `"auto"` selects registered Agent
System-managed agents. `"all"` permits every OpenClaw agent, including unmanaged
agents and future registrations. A list selects exact registered IDs, including
unmanaged agents; unregistered IDs produce a warning. `false` or `[]` withdraws
only Agent System-owned grants, not independently configured operator access.

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

Fresh `auto` with fewer than two managed agents leaves native settings untouched
and reports not applicable. A previously configured team still gets ownership
cleanup. Already sufficient native enablement, visibility, and allow rules stay
unchanged, including an unrestricted host. Otherwise install unions required IDs
with existing `tools.agentToAgent.allow` entries, enables agent-to-agent access,
and sets `tools.sessions.visibility=all` as needed. On a disabled host with no
allow entries, exact selected IDs are written together with enablement.

These **global** settings grant session reading and messaging, subject to native
tool and sandbox restrictions. They cannot create isolated teams: retained
external participants share access with selected agents. Install reports effective
entries and notices newly connected external IDs or patterns. No extra flag,
confirmation, or off/on sequence is needed; ordinary Doctor inspects without
repairing state. Unrelated tool, sandbox, credential, and workspace permissions
are unchanged.

Pre-existing exact IDs and matching wildcard patterns remain operator-owned.
`all` adds an owned `*` only when unrestricted access is not already granted.
Returning to `auto` withdraws that owned wildcard and establishes the required
managed IDs while retaining operator entries. Changing selections or removing
agents withdraws only owned grants; cleanup that empties the list disables access
in the same write, because OpenClaw treats an empty list as unrestricted. Cleanup
does not restore session visibility.

Native OpenClaw deletion prunes exact allow entries itself, but does not disable
access when the list empties or remove Agent System's ownership receipt. There
is no supported agent-deletion plugin hook for immediate reconciliation. The next
ordinary install cleans up the receipt and remaining owned grants. **Before
deleting the final managed agent, withdraw owned grants with `false` and install
from its workspace.** After it is gone there is no workspace-free cleanup command;
if deletion already emptied an enabled allowlist, disable native agent-to-agent
access explicitly until reconciliation can run from a managed workspace. Missing
or invalid registered managed workspaces block `auto` discovery rather than
being treated as deleted agents. No background reconciler runs.

`collaborationState` is an install-owned receipt beside this setting. It records
only introduced grants (exact IDs or `*`), selection, and empty-list shutdown.
Do not edit or delete it: effective access alone never proves ownership.
Configuration and ownership commit together. Standalone Codex does not manage
this OpenClaw capability.

## `githubNotifications`

| Field                  | Type    | Required | Default | Description                                       |
| ---------------------- | ------- | -------- | ------- | ------------------------------------------------- |
| `maxCommentCharacters` | integer | no       | `8000`  | Incoming comment limit, from `1` through `64000`. |

Overlong comments are rejected without executing truncated prose. This does not
change outgoing reply or routing-assessment excerpt limits.

```sh
# reject incoming comments longer than twelve thousand characters.
openclaw config set plugins.entries.agent-system.config.githubNotifications.maxCommentCharacters 12000 --strict-json
```

## `opCache`

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

Authorization and local credential/configuration changes are checked on each
operation. Reload, agent removal, credential changes, flush, and shutdown
invalidate retained state; snapshots already in use are not revoked. If a
credential command reports **invalidation pending**, restore Gateway access and
flush. External 1Password edits appear after timed expiry or flush; lifetime
mode requires flush or restart.

Failed or partial loads are not cached, and failed refreshes return errors rather
than stale credentials. OTP and unknown reference transforms bypass value
retention. Use off mode for other time-varying credentials whose validity is
shorter than the cache duration. Provider failures back off from 30 seconds to
one hour; SDK quota errors wait one hour. Flush does not reset backoff or quota.
