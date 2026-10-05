# Global Configuration

Set plugin-wide options under `plugins.entries.agent-system.config` in OpenClaw
configuration. Workspace declarations belong in the [manifest](./MANIFEST.md).

- [`collaboration`](#collaboration)
- [`githubNotifications`](#githubnotifications)
- [`opCache`](#opcache)

## `collaboration`

| Type                                                     | Required | Default |
| -------------------------------------------------------- | -------- | ------- |
| `"all"`, `false`, or an array of exact managed agent IDs | no       | `"all"` |

Ordinary OpenClaw Agent System installs reconcile collaboration across registered
managed agents. `"all"` selects every managed agent; an explicit list selects one
group whose members can communicate with one another. `false` or `[]` withdraws
only Agent System-owned entries. IDs come from `agent.id`, not display names.
Only registered managed IDs are added. Unresolved selected IDs produce a warning;
deleting an agent still removes its owned entry without requiring a list edit.

```sh
# select every registered managed agent and explicitly migrate initial restrictions.
openclaw config set plugins.entries.agent-system.config.collaboration all
openclaw agent-system install --collaboration

# select one group of managed participants.
openclaw config set plugins.entries.agent-system.config.collaboration '["emori","smutlord"]' --strict-json
openclaw agent-system install --collaboration

# withdraw managed grants while retaining operator-owned entries.
openclaw config set plugins.entries.agent-system.config.collaboration false --strict-json
openclaw agent-system install --collaboration
```

For a nonempty managed group, install sets `tools.sessions.visibility=all` and
`tools.agentToAgent.enabled=true`, then reconciles exact IDs into
`tools.agentToAgent.allow`. This grants **session reading and messaging**, subject
to native tool policy and sandbox restrictions. Pre-existing IDs and wildcards
remain operator-owned, even when an ID matches a managed agent. Retained external
participants can communicate with the managed group; this setting does not promise
an exclusive group or override native tool denials.

An omitted setting does not migrate explicit restrictive session visibility or
disabled agent-to-agent access. Set `collaboration` explicitly to select that
migration. After enrollment, later host restrictions block reconciliation until
the operator changes the selection. To reauthorize the same group, install with
`collaboration=false`, then restore the desired selection and install again.
There is no separate consent prompt, and ordinary setup-consent flags do not
override this rule.

After deleting an agent through OpenClaw, run `install --collaboration` to remove
its owned entry. This works outside any workspace, including after the final
managed agent is gone. If cleanup empties the allowlist, install disables
agent-to-agent access in the same write: OpenClaw treats an empty list as
allow-all. Operator entries remain intact; `false` does not disable communication
that those entries independently permit. Session visibility is not restored.
Missing or invalid registered workspaces block membership cleanup rather than
being treated as removed agents.

`collaborationState` is an install-owned receipt stored alongside this setting.
It records introduced IDs, the last selection, and safe empty-group shutdown.
Do not edit or delete it: matching an ID alone never proves entry ownership.
Configuration and ownership commit together. Doctor and passive discovery do
not repair them. Standalone Codex does not manage this OpenClaw capability.

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
