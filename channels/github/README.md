# GitHub Notifications

Agent System turns approved GitHub issue assignments into runtime-owned work.
Native OpenClaw currently supports issue planning; standalone Codex additionally
supports its declared implementation, delivery, and feedback workflows.

## Configuration

Use `github.notifications.schema-version: 2` in `agent.yaml`. Declare the runtime,
pinned repository owners, and allowed assignment actors explicitly. For OpenClaw,
choose Plan mode and the default assessment skill. See the
[manifest reference](../../MANIFEST.md#githubnotifications) for a complete example,
fields, defaults, and runtime limitations.

Native OpenClaw Work/Auto, feedback, review requests, and replacement assessment
skills remain unsupported. Unavailable feedback and reviews produce warnings without
stopping supported assignment intake. Unsupported assignment modes or assessment skills
block assignment execution; they are never silently replaced.

## Install and Verify

From the configured workspace:

```sh
# reconcile declared configuration and inspect readiness.
openclaw agent-system install
openclaw agent-system doctor

# inspect native intake and dispatch evidence without advancing work.
openclaw agent-system notifications status --json

# request one run of the already installed owning automation.
openclaw agent-system notifications refresh --json
```

Install also manages the **GitHub Notifications** readiness channel. It shows when
an agent needs setup or automation synchronization, and reports recent intake
health. Disable notifications in the manifest and run Install to deactivate that
agent's account; there is no separate channel setup. See [channel readiness and
compatibility](./ADVANCED.md#v1-retirement) for observation limits.

A queued refresh is an admission receipt. It does not prove a completed scan,
created conversation, or finished plan. Status reads durable intake and dispatch
records; `wait --for plan-ready` requires the retained assessment result.

## Further Reading

- [CLI reference and V1 retirement](./ADVANCED.md)
- [Standalone Codex workflows](../../CODEX.md#github-notification-policy)
- [Presentation contract](./PRESENTATION.md)
