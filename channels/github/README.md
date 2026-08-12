# Agent System GitHub Notifications Channel

<p align="center">
  <img src="../../assets/github-icon-large.svg" alt="Agent System GitHub notifications" width="180" />
</p>

The GitHub notifications channel observes authorized GitHub work assignments
for agent-scoped local OpenClaw routing. It owns the static
`agent-system-github` channel, its exact per-agent route, the Gateway
monitor, and the `github.notifications` manifest contract.

[Agent System](../../README.md) · [GitHub CLI tool](../../tools/github/README.md)

## Current Behavior

The current release provides the channel, routing, trust core, and local assignment delivery:

- strict `github.notifications` manifest validation
- one activation-only channel account whose id is the Agent System agent id
- one exact account-scoped binding back to that agent and workspace
- private receipt-backed ownership, repair, and cleanup
- a long-lived, stoppable Gateway service with per-agent polling and backoff
- an explicit `notifications refresh` command over the same monitor and cross-process lease
- account identity verification on every poll
- account-wide assigned issue and pull-request discovery with a first-run baseline
- bounded pagination, overlap, replay deduplication, and truncation diagnostics
- canonical repository, owner, effective permission, item, and assignment-event checks
- immutable actor admission, self-event suppression, and active-item revocation checks
- private atomic control state containing no token or issue/comment content
- deterministic work-item conversation ids for inbound assignment delivery
- policy-authorized managed worktree preparation through the Git capability
- value-free, at-most-once delivery checkpoints around worktree and briefing creation
- a separate bounded title, URL, body-excerpt, label, and milestone projection
- one deterministic local session created by OpenClaw's channel inbound lifecycle
- a no-tools automated briefing turn whose GitHub content is explicitly untrusted
- logical retirement that preserves the OpenClaw transcript and managed worktree
- local-only behavior with no outbound GitHub adapter

After a new assignment is admitted, the monitor prepares or adopts one managed
worktree and one deterministic OpenClaw session, then starts one local briefing
turn. It does not fetch comments, publish the response, or otherwise write to
GitHub.

## Requirements

- Agent System installed and enabled
- an Agent System workspace manifest with `github.notifications`
- an explicit `github.username`
- an environment-bound `github.token`
- `git.worktrees` enabled
- a Git author email from `agent.email` or `git.email`

`install` does not resolve the token or contact GitHub. The Gateway monitor
resolves the declared credential only after the installed channel account,
binding, agent id, and workspace agree exactly.

## Configuration

Add the GitHub notification declaration to `.agent-system/agent.yaml` or the
root `agent.yaml` shorthand:

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot
  email: tanaabot@example.com

environment:
  required:
    - GH_TOKEN_TANAABOT

git:
  worktrees: {}

github:
  host: github.com
  username: tanaabot
  token: GH_TOKEN_TANAABOT
  notifications:
    interval-minutes: 5
    approved-actors:
      - login: pirog
        node-id: U_kgDOB9x7Qw
    allowed-repository-owners:
      - login: tanaabased
        node-id: O_kgDOB7x6Qw
```

| Field                       | Required | Default |
| --------------------------- | -------- | ------- |
| `interval-minutes`          | no       | `5`     |
| `approved-actors`           | yes      | none    |
| `allowed-repository-owners` | no       | any     |

The interval must be from `1` through `1440`. Each approved actor and allowed
owner uses a human-readable GitHub login plus an immutable GitHub node id. Node
ids must be unique within each list.

Every assignment requires the verified agent account to have effective
`write`, `maintain`, or `admin` access to the repository. That requirement is a
non-configurable notification admission invariant, not `github.policy`; the
optional owner list narrows eligible repositories without authorizing their
members to assign work.

`github.username` and `github.token` are shared GitHub identity and credential
declarations. The token field names a variable in the completed Agent System
environment and never accepts a literal token.

Public repositories can use their canonical HTTPS clone URL. For private
repositories, configure [`git.ssh`](../../tools/git/README.md#gitsshprivate-keys);
notification worktree preparation then derives the canonical GitHub SSH remote
and uses only the Git capability's isolated SSH resource. The GitHub token is
never embedded in a clone URL or credential helper.

## Installation and Inspection

From the agent workspace:

```sh
openclaw agent-system validate
openclaw agent-system install
openclaw agent-system doctor
openclaw agent-system notifications refresh --json
```

`install` adds or repairs only the non-secret `agent-system-github` account and
its exact binding. Repeated installation is idempotent. Removing
`github.notifications` and running `install` again removes only state proven by
the private ownership receipt.

Conflicting, duplicate, partially unowned, or rebound state fails closed.
Unrelated channel accounts and bindings are preserved. Gateway reload planning
remains host-owned; when `gateway.reload.mode` is `off`, installation reports
that a manual Gateway restart is required.

## Runtime Monitoring

The Gateway establishes a baseline from the account's currently open assigned
items on first activation. Closed historical work is excluded, and existing
assignments are not admitted retroactively. Later
polls use an overlapping update window and immutable event-id deduplication,
then recheck each approved item directly so closure, unassignment, repository
archival or transfer, owner-allowlist drift, deletion, and permission loss retire
the observation.

Changing the verified GitHub account establishes a fresh baseline. Removing
`github.notifications` and running `install` removes the owned route immediately
but retains monitor state while the Gateway retires any local sessions. The
state is removed after retirement converges, so a later re-enable cannot inherit
an earlier activation boundary.

The default interval is five minutes with jitter. Provider retry and rate-limit
controls can defer the next poll, and transient failures use exponential backoff.
Polls never overlap for the same agent. Stopping the plugin service aborts its
timer and any active GitHub CLI child process.

`openclaw agent-system notifications refresh [--agent <id>] [--json]` runs one
complete intake cycle through the same monitor and private cross-process
per-agent lease. It waits up to two minutes for an active cycle rather than
overlapping it. The command bypasses only the configured interval; active
failure and provider backoff still apply, and first use still establishes the
ordinary safe baseline. A deferred or failed manual cycle returns a nonzero exit
code so CI can distinguish it from a completed refresh. It does not enable the
background scheduler and is not a read-only fetch: an admitted assignment can
create its managed worktree and local session.

Delivery state is checkpointed before and after worktree preparation and before
the channel turn is dispatched. The channel passes `createIfMissing: true` to
OpenClaw's inbound kernel; the host records or creates the routed session before
starting the turn. Agent System does not call protected Gateway session RPCs or
edit host session storage.

The pre-dispatch `briefing-running` checkpoint prevents automatic duplicate
turns. If the process loses the dispatch result, the item receives the stable
`github-notification-briefing-ambiguous` diagnostic and requires operator
inspection rather than a speculative retry.

When assignment or repository authority is revoked, the monitor records logical
retirement and stops creating new turns. It does not abort or archive the host
session and does not delete the transcript, managed repository, branch, or
worktree. Native retirement, reassignment, and cleanup are Notifications 2 work.

`doctor` reports whether the route is ready and whether the monitor is pending,
healthy, or deferred by a stable diagnostic code. Gateway logs contain agent ids,
counts, and diagnostic codes, but not tokens, response bodies, issue content, or
raw provider errors.

## Session and Delivery Contract

The channel uses per-account, per-channel, per-peer direct-message scope. A work
item conversation is derived from the immutable repository node id and issue or
pull-request number:

```text
github:<repository-node-id>:<issue-number>
```

The exact channel account binding must select the same agent that owns the
manifest. Missing, default, or cross-agent routing is rejected.

The channel intentionally registers no outbound adapter. Automated briefing
responses remain in the local OpenClaw transcript and cannot be published to
GitHub through this channel.

The automated briefing turn sets `disableTools: true` and an empty per-turn
tool allowlist. The worktree path is included in the bounded briefing and inbound
context for later operator- or agent-led work; the briefing turn itself cannot
invoke it. Agent System keeps correlation in its private monitor state instead
of patching OpenClaw session extensions.

## Trust Boundary

GitHub content is untrusted project data. The monitor authorizes transitions
using only the verified account identity, immutable actor identity, canonical
repository and owner identities, effective repository permission, item state,
and assignment event. Only after those checks pass does it fetch a separate,
bounded briefing projection. GitHub text is marked as untrusted project data,
is never interpreted as notification control state, and is not persisted in the
private monitor record. Comments are not fetched in this phase.

For assignment events, the trusted actor is GitHub's immutable `assigner` field.
The event's `actor` and `assignee` fields are not treated as assignment authority.

The channel configuration contains no token values. Credential resolution must
remain lazy and occur only in the explicit consumer that contacts GitHub.
