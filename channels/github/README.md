# GitHub Notifications

Agent System turns approved GitHub issue assignments into runtime-owned work.
Native OpenClaw supports issue planning and explicitly requested implementation and
PR delivery in the same issue chat. Standalone Codex additionally supports its
declared automatic implementation and feedback workflows.

## Configuration

Use `github.notifications.schema-version: 2` in `agent.yaml`. Declare the runtime,
pinned repository owners, and allowed assignment actors explicitly. For OpenClaw,
choose Plan mode with feedback disabled and the default assessment skill. See the
[manifest reference](../../MANIFEST.md#githubnotifications) for a complete example,
fields, defaults, and runtime limitations.

Native OpenClaw Work/Auto, feedback, review requests, and replacement assessment
skills remain unsupported. Disabled or unsupported workflows do not activate intake.

After reading a retained plan, ask the agent in that issue chat to implement it and
open a PR, together or separately. The authenticated operator request authorizes
only the requested work. The agent keeps the same worktree and returns a quoted
card linking the issue and PR. If publication is interrupted, continue in that chat
so it can reconcile the existing attempt without creating another PR.

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
