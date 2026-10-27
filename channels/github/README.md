# GitHub Notifications

Agent System starts work from approved GitHub issue assignments. OpenClaw and standalone
Codex support native Plan, Work, and Auto issue workflows, including implementation and
linked PR delivery. OpenClaw keeps that work and authorized feedback on the issue and
its linked PR in the same issue chat.

## Configuration

Start with an agent workspace that has working [GitHub credentials](../../tools/github/README.md#configuration-reference)
and [model profiles](../../MANIFEST.md#models). Merge these workflow fields into
its existing `github` mapping, retaining the token and other tool settings. Replace
the account and approved owner/actor names with yours:

```yaml
github:
  schema-version: 3
  username: tanaabot
  runtimes: [openclaw]
  allowed-repository-owners: ['@tanaabased']
  issue-assignment:
    mode: plan
    allowed: ['@pirog']
```

This example selects planning for approved assignments. Work continues an actionable
plan through implementation and PR delivery; Auto chooses Plan or Work and is the
default when `mode` is omitted. An empty actor list admits no new assignments.
See the [configuration reference](./ADVANCED.md#configuration-reference) for all
fields, defaults, identity forms, reviewers, and skill/guidance customization.
Independent review requests remain unavailable.

For standalone Codex, use the [Codex setup guide](../../CODEX.md#github-notification-policy)
and [Codex profile example](./ADVANCED.md#issue-only-profile-example). Codex uses
native host GitHub authorization rather than the manifest token.

Plans, questions, implementation, and follow-ups belong in the individual issue
chat. When planning is complete, ask there to implement the plan and open a PR.
Approved GitHub feedback also returns to that chat; see
[feedback and public replies](./ADVANCED.md#feedback-and-public-replies) for author
selection, supported comment surfaces, and publication behavior. Invalid skill
selections block the affected operation; correct them and refresh context in the
same chat instead of creating a replacement.

## Install and Verify

Install creates the native `github-issue-assignment` automation from your workflow
configuration. You do not need a second job under `automations`; that ID is reserved.
The runtime's native scheduler runs intake in a retained conversation for each agent.
Repeated Install reuses that job and conversation. See
[activation](./ADVANCED.md#activation) for runtime model requirements and
first-activation behavior.

For OpenClaw, run these operator commands from the configured workspace:

```sh
# reconcile declared configuration and inspect readiness.
openclaw agent-system install
openclaw agent-system doctor
```

For standalone Codex, complete [workspace setup and hook approval](../../CODEX.md#workspace-setup),
then use `$agent-system-install` in the app and `$agent-system-doctor` to inspect
readiness. Install reconciles the native automation through the app's controls.

### Follow the workflow

| Runtime  | Schedule                                                                                                           | Intake conversation                        |
| -------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| OpenClaw | `github-issue-assignment`, visible through [automations list](../../CLI.md#openclaw-agent-system-automations-list) | `ISSUE ASSIGNMENTS` in **Agent System**    |
| Codex    | **📥 ISSUE ASSIGNMENTS** in native automations                                                                     | `ISSUE ASSIGNMENTS` under **AGENT SYSTEM** |

The intake chat reports newly started issues, pending assignments, occupied
capacity, and intake obstacles. Follow its issue links for plans, questions,
implementation progress, and PR delivery. Those updates stay in the individual
issue chats; the intake chat does not provide a task-progress feed.

OpenClaw Install also manages the **GitHub Notifications** readiness channel.
It reports setup needs, automation synchronization, and recent intake health;
the native automation runs the workflow. Removing a workflow declaration and
running Install deactivates that agent's channel account. See
[channel readiness](./ADVANCED.md#channel-readiness) for probe and observation limits.

### Verify a run

For OpenClaw, inspect the saved schedule, request a run, then check its native history
and saved notification state:

```sh
# inspect the saved automation and any drift.
openclaw agent-system automations list --json

# request one run of the installed assignment automation.
openclaw agent-system notifications refresh --json

# replace RUN_ID with the runId returned by refresh.
openclaw agent-system automations runs github-issue-assignment --run-id RUN_ID --json

# inspect intake and issue workflow evidence without advancing work.
openclaw agent-system notifications status --json
```

A `queued` refresh proves the scheduler accepted the request. Native history
reports execution and delivery separately. In notification status, inspect the scan
completion time and any blockers; a created issue chat still does not prove a
finished plan. Use [notification wait](./ADVANCED.md#openclaw-agent-system-notifications-wait)
with `--for plan-ready` and an issue selector when you need the retained assessment
checkpoint.

For Codex, inspect the saved native automation and follow a real scheduled
occurrence in `ISSUE ASSIGNMENTS`, then open the issue chat to verify its work.
Doctor's saved-definition check does not prove unattended execution. See
[Codex automation limitations](../../CODEX.md#repository-automations) for the native
history and execution evidence available through the adapter.

Healthy, unchanged intake checks do not notify. Silence alone does not prove success: a
missing or paused automation cannot report from its own run. Use Doctor and the saved
schedule to distinguish that condition from an unchanged scan. For reported setup or
schedule drift, follow the diagnostic and reconcile through Install. If work on an issue
is blocked, continue in its existing chat using the
[recovery guidance](./ADVANCED.md#interrupted-publication) or
[Codex recovery controls](../../CODEX.md#workflow-recovery); preserve retained work and
uncertain attempts.

To pause future occurrences, set `github.issue-assignment.paused: true` and run
Install. Set it to `false` and run Install to resume the same job and chat. Running
turns may finish, and a native UI pause can be reversed by the next Install if the
manifest still requests active intake. See [pause and resume](./ADVANCED.md#pause-and-resume)
for retained work and feedback behavior.

## Further Reading

- [Workflow configuration, commands, and recovery](./ADVANCED.md)
- [Standalone Codex workflows](../../CODEX.md#github-notification-policy)
- [Presentation contract](./PRESENTATION.md)
