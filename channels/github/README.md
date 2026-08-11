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
- a long-lived, abortable Gateway service with per-agent polling and backoff
- account identity verification on every poll
- account-wide assigned issue and pull-request discovery with a first-run baseline
- bounded pagination, overlap, replay deduplication, and truncation diagnostics
- canonical repository, owner, effective permission, item, and assignment-event checks
- immutable actor admission, self-event suppression, and active-item revocation checks
- private atomic control state containing no token or issue/comment content
- deterministic work-item conversation ids for inbound assignment delivery
- policy-authorized managed worktree preparation through the Git capability
- restart-safe, value-free delivery checkpoints and side-effect reconciliation
- a separate bounded title, URL, body-excerpt, label, and milestone projection
- one deterministic local session with plugin-owned work-item and worktree metadata
- a no-tools automated briefing turn whose GitHub content is explicitly untrusted
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

environment:
  required:
    - GH_TOKEN_TANAABOT

github:
  host: github.com
  username: tanaabot
  token: GH_TOKEN_TANAABOT
  notifications:
    interval-minutes: 5
    approved-actors:
      - login: pirog
        node-id: U_kgDOB9x7Qw
    repository-policy:
      minimum-permission: write
      allowed-owners:
        - login: tanaabased
          node-id: O_kgDOB7x6Qw
```

| Field                                  | Required | Default |
| -------------------------------------- | -------- | ------- |
| `interval-minutes`                     | no       | `5`     |
| `approved-actors`                      | yes      | none    |
| `repository-policy.minimum-permission` | no       | `write` |
| `repository-policy.allowed-owners`     | no       | any     |

The interval must be from `1` through `1440`. Each approved actor and allowed
owner uses a human-readable GitHub login plus an immutable GitHub node id. Node
ids must be unique within each list.

`github.username` and `github.token` are shared GitHub identity and credential
declarations. The token field names a variable in the completed Agent System
environment and never accepts a literal token.

## Installation and Inspection

From the agent workspace:

```sh
openclaw agent-system validate
openclaw agent-system install
openclaw agent-system doctor
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

The Gateway establishes a baseline from the account's currently assigned items
on first activation. Existing assignments are not admitted retroactively. Later
polls use an overlapping update window and immutable event-id deduplication,
then recheck each approved item directly so closure, unassignment, repository
archival or transfer, owner-policy drift, deletion, and permission loss retire
the observation.

Changing the verified GitHub account establishes a fresh baseline. Removing
`github.notifications` and running `install` removes the owned monitor state, so
a later re-enable cannot inherit an earlier activation boundary.

The default interval is five minutes with jitter. Provider retry and rate-limit
controls can defer the next poll, and transient failures use exponential backoff.
Polls never overlap for the same agent. Stopping the plugin service aborts its
timer and any active GitHub CLI child process.

Delivery state is checkpointed before and after worktree preparation, session
creation, and briefing dispatch. On restart, the monitor inspects the canonical
worktree, exact routed session, plugin metadata, and assignment event before it
resumes. It never treats a stale local stage as proof that an external side
effect completed.

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
tool allowlist. The worktree path is stored as value-free session metadata and
included in the briefing for later operator- or agent-led work; the briefing
turn itself cannot invoke it.

## Trust Boundary

GitHub content is untrusted project data. The monitor authorizes transitions
using only the verified account identity, immutable actor identity, canonical
repository and owner identities, effective repository permission, item state,
and assignment event. Only after those checks pass does it fetch a separate,
bounded briefing projection. GitHub text is marked as untrusted project data,
is never interpreted as notification control state, and is not persisted in the
private monitor record. Comments are not fetched in this phase.

The channel configuration contains no token values. Credential resolution must
remain lazy and occur only in the explicit consumer that contacts GitHub.
