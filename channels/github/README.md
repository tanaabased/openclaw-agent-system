# GitHub Notifications

Agent System turns approved GitHub issue assignments into runtime-owned work.
Native OpenClaw currently supports issue planning; standalone Codex additionally
supports its declared implementation, delivery, and feedback workflows.

## Configuration

Use `github.notifications.schema-version: 2` in `agent.yaml`. Declare the runtime,
pinned repository owners, and allowed assignment actors explicitly. For OpenClaw,
choose Plan mode with feedback disabled and the default assessment skill. See the
[manifest reference](../../MANIFEST.md#githubnotifications) for a complete example,
fields, defaults, and runtime limitations.

Native OpenClaw Work/Auto, feedback, review requests, and replacement assessment
skills remain unsupported. Disabled or unsupported workflows do not activate intake.

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

A queued refresh is an admission receipt. It does not prove a completed scan,
created conversation, or finished plan. Status reads durable intake and dispatch
records; `wait --for plan-ready` requires the retained assessment result.

## Further Reading

- [CLI reference and V1 retirement](./ADVANCED.md)
- [Standalone Codex workflows](../../CODEX.md#github-notification-policy)
- [Presentation contract](./PRESENTATION.md)
