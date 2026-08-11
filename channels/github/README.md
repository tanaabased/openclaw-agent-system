# Agent System GitHub Notifications Channel

<p align="center">
  <img src="../../assets/github-icon-large.svg" alt="Agent System GitHub notifications" width="180" />
</p>

The GitHub notifications channel routes authorized GitHub work assignments into
agent-scoped local OpenClaw sessions. It owns the static
`agent-system-github` channel, its exact per-agent route, and the
`github.notifications` manifest contract.

[Agent System](../../README.md) · [GitHub CLI tool](../../tools/github/README.md)

## Current Behavior

The current release provides the channel and routing foundation:

- strict `github.notifications` manifest validation
- one activation-only channel account whose id is the Agent System agent id
- one exact account-scoped binding back to that agent and workspace
- private receipt-backed ownership, repair, and cleanup
- deterministic work-item conversation ids for inbound assignment delivery
- local-only behavior with no outbound GitHub adapter

The channel does not yet poll GitHub, ingest production assignment events,
prepare worktrees, or run an automated briefing. Those capabilities will build
on this routing contract.

## Requirements

- Agent System installed and enabled
- an Agent System workspace manifest with `github.notifications`
- an explicit `github.username`
- an environment-bound `github.token`

Installation does not resolve the token or contact GitHub while only the routing
foundation is active.

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

## Trust Boundary

GitHub content is untrusted project data. Future assignment delivery must verify
the authenticated agent identity, immutable actor identity, canonical repository
identity, effective repository permission, and configured owner policy before
starting local work.

The channel configuration contains no token values. Credential resolution must
remain lazy and occur only in the explicit consumer that contacts GitHub.
