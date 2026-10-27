# GitHub Notifications

Agent System turns approved GitHub issue assignments into runtime-owned work.
OpenClaw and standalone Codex support Plan, Work, and Auto issue workflows,
including implementation and linked PR delivery. OpenClaw keeps that work and
authorized feedback on the issue and its linked PR in the same issue chat.

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

For OpenClaw, run these operator commands from the configured workspace:

```sh
# reconcile declared configuration and inspect readiness.
openclaw agent-system install
openclaw agent-system doctor

# inspect native intake and dispatch evidence without advancing work.
openclaw agent-system notifications status --json

# request one run of the already installed owning automation.
openclaw agent-system notifications refresh --json
```

Install derives the native `github-issue-assignment` automation from this workflow;
do not add a second job under `automations`. Each agent's retained
`ISSUE ASSIGNMENTS` chat reports intake, capacity, and obstacles. In OpenClaw it
appears in **Agent System**; in Codex it appears under **AGENT SYSTEM**, with the
automation named `📥 ISSUE ASSIGNMENTS`. Follow task progress in the individual
issue chats. See [activation](./ADVANCED.md#activation) for runtime model requirements.

OpenClaw Install also manages the **GitHub Notifications** readiness channel. It shows when
an agent needs setup or automation synchronization, and reports recent intake
health. Remove the supported workflow declaration from the manifest and run Install to deactivate that
agent's account; there is no separate channel setup. See [channel readiness and
compatibility](./ADVANCED.md#v1-retirement) for observation limits.

A queued refresh is an admission receipt. It does not prove a completed scan,
created conversation, or finished plan. Status reads durable intake and dispatch
records; `wait --for plan-ready` requires the retained assessment result.

## Further Reading

- [Workflow configuration, commands, and recovery](./ADVANCED.md)
- [Standalone Codex workflows](../../CODEX.md#github-notification-policy)
- [Presentation contract](./PRESENTATION.md)
