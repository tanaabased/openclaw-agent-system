# Global Configuration

Set plugin-wide options under `plugins.entries.agent-system.config` in OpenClaw
configuration. Workspace declarations belong in the [manifest](./MANIFEST.md).

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
