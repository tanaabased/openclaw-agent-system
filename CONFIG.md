# Global Configuration

Set plugin-wide options under `plugins.entries.agent-system.config` in OpenClaw
configuration. These settings belong to the operator; workspace declarations
belong in the [manifest](./MANIFEST.md). Start with the [README](./README.md) for installation.

## `githubNotifications`

Controls operator-wide GitHub notification intake limits.

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
| `mode`            | string  | no       | `timed` | `off`, `timed`, or `process-lifetime`.                                                 |
| `durationSeconds` | number  | no       | `300`   | Timed mode only; greater than zero, at most `4503599627370`.                           |
| `maxEntries`      | integer | no       | `128`   | Maximum agent/workspace entries, from `1` to `1024`; oldest entries are evicted first. |

Timed values expire after the configured duration from retrieval; cache hits do
not extend it. Expiry refreshes values on demand, not an unchanged authenticated
client. Process-lifetime mode retains values until invalidation, eviction, or
exit. Off mode disables reuse between operations.

```bash
# retain values for five hours
openclaw config set plugins.entries.agent-system.config.opCache '{"mode":"timed","durationSeconds":18000}' --strict-json

# inspect the running gateway cache
openclaw agent-system credentials cache status --json

# flush one agent; omit --agent to flush all
openclaw agent-system credentials cache flush --agent data --json
```

Status requires `operator.read`; flush requires `operator.admin`. Both contact
the running Gateway without reading 1Password. Status reports policy, occupancy,
expiry, backoff, and usage counters without secrets. An unreachable or
unauthorized Gateway returns an error.

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
