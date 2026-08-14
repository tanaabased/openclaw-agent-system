# Agent System GitHub Notifications Channel

<p align="center">
  <img src="../../assets/github-icon-large.svg" alt="Agent System GitHub notifications" width="180" />
</p>

The GitHub notifications channel is a local
[OpenClaw messaging channel](https://docs.openclaw.ai/channels) that turns
approved GitHub issue and pull-request assignments into agent-scoped local work.
It verifies the agent, assigning actor, and repository before creating one local
OpenClaw session for the assigned work item. Issue assignments also create one
managed worktree. Direct pull-request assignments retain the exact observed PR
head as session metadata without preparing a worktree. The Gateway then asks the
agent to review the work item and prepare a plan before posting one short
acknowledgment.
Later approved comments that address the verified agent account continue the
same private conversation and receive one bounded public reply. A local operator
can also explicitly select one bounded progress update for publication.

> [!IMPORTANT]
> GitHub comments never authorize implementation or local tool use. The channel
> publishes local progress only through an authorized `/agent-system-progress`
> action in the exact assignment session. Direct pull requests have their own
> conversation; the channel does not correlate them with issue conversations or
> participate in inline review threads.

## Overview

- During `install`, records the agent's currently assigned open work items as a
  safe baseline without creating local work. An empty result is a valid,
  persisted baseline.
- On later cycles, discovers new assignments and rechecks the agent account,
  assigning actor, repository owner, and repository access.
- For each accepted issue assignment, creates or reuses one deterministic
  managed worktree and one local OpenClaw session. A direct pull-request
  assignment creates only its local monitoring session.
- Fetches a bounded title, body, labels, and recent comments as untrusted
  context, plus summary-only changed-file metadata for a pull request, then runs
  one tool-free private planning turn. Patch content is never included.
- Publishes only the planning response's separate one-sentence acknowledgment
  through the channel's authorization, safety, and durable delivery path.
- Establishes a complete bounded top-level comment baseline for each admitted
  issue or pull request, then admits only later exact standalone mentions from
  approved immutable human identities.
- Rechecks the exact current comment revision before a tool-free private reply
  turn and again before publishing its separate GitHub reply candidate.
- Publishes a locally selected progress update only from the exact active
  assignment session through an authorized Gateway operator command that
  bypasses the model.

## Private Assignment Presentation

Each admitted assignment first creates its private session with a compact,
mode-neutral receipt in its session metadata:

```markdown
## 📥 Assignment received

You've been assigned [tanaabased/example#7](https://github.com/tanaabased/example/issues/7).
```

Session metadata is not a chat message, so the activation service composes the
assignment introduction into the single visible mode-specific request. The
currently supported plan request uses this shape:

```markdown
## 📋 Planning request

You've been assigned [tanaabased/example#7 — Improve planning](https://github.com/tanaabased/example/issues/7).

Please review it and prepare a private implementation plan.

**Mode:** Plan — do not use tools or begin implementation.
```

For a direct pull request, the link targets the pull request and the request asks
for a stewardship plan covering discussion, blockers, and merge readiness. It
also states that no managed worktree exists and that implementation requires a
separate authorized local action.

The title, body, labels, and comments are supplied separately through OpenClaw's
current-turn untrusted structured context. Pull requests also receive their
verified head identity and summary-only changed-file metadata. These values
remain available to the agent without appearing in normal chat history. The
request also keeps managed worktree paths out of the visible message. A
presentation path that exposes the structured context receives fenced JSON,
which remains readable as plain text and is shown as a collapsed JSON disclosure
by the OpenClaw Control UI.

Only plan mode is currently implemented. The shared assignment introduction and
mode-specific request are deliberately composed from separate formatters so
future work and auto modes can provide accurate instructions without changing
provider-context transport. Work mode still plans before a separately checkpointed
implementation turn; auto mode will add its own structured continue-or-wait
decision and deterministic safety gate.

The private planning response uses this canonical Markdown contract:

```markdown
ACKNOWLEDGMENT: I reviewed the assignment and prepared a plan.

## Assessment

🧭 The requested outcome and its relevant constraints.

## Blockers

None.

## Plan

1. **🔎 Inspect the boundary.** Trace the current behavior.
2. **✅ Verify the result.** Run the relevant checks.
```

`Assessment`, `Blockers`, and `Plan` must each appear once, in that order, and
contain content. `Plan` must contain an ordered or bulleted list. Spacing,
emphasis, emoji, and relevant links are supported inside the private sections;
the required headings stay exact so validation remains deterministic. Legacy
`ASSESSMENT:`, `BLOCKERS:`, and `PLAN:` markers remain accepted during the
transition, but mixed Markdown and plaintext section markers are rejected.
Clients that do not render Markdown show the same literal headings, list
markers, link labels and destinations, and emoji; no HTML-only presentation is
required for the plan to remain readable.

Only the separate `ACKNOWLEDGMENT:` candidate can enter the public publication
path. It remains subject to the one-sentence safety gate and cannot publish the
private sections, links, issue context, or local paths.

Each enabled channel account owns its polling lifecycle while the Gateway is
running. `openclaw channels status --channel agent-system-github --json`
reports whether that account is running, connected, and healthy. The manual
refresh command runs the deterministic intake path immediately and returns
without waiting for a model. The running Gateway owns asynchronous planning,
acknowledgment delivery, and admitted-comment responses. OpenClaw owns each
durable send attempt, provider retry, receipt normalization, and unknown-send
reconciliation. Agent System stores only value-free revision checkpoints,
confirmed comment receipts, or stable failed diagnostics; `doctor` reports
pending and failed acknowledgments, replies, and progress publications
separately from monitor read health.

## Requirements

- Agent System installed and enabled
- Git available as `git`
- GitHub CLI available as `gh`
- an Agent System workspace manifest with an agent id and Git author email
- `git.worktrees`, `github.username`, `github.token`, and
  `github.notifications` configured
- the named GitHub token available in the completed Agent System environment
- an authenticated default OpenClaw model for private planning and comment turns

The GitHub account must have `write`, `maintain`, or `admin` access to every
repository from which the channel accepts assignments.

## Installation and Usage

Add the notification channel to `.agent-system/agent.yaml` or the root
`agent.yaml`. See [Configuration Reference](#configuration-reference) for every
field.

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot
  email: tanaabot@tanaab.dev

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
    approved-actors:
      - login: pirog
        node-id: U_kgDOB9x7Qw
```

From the agent workspace:

```sh
# check the manifest without changing installed state.
openclaw agent-system validate

# reconcile the route and establish the first baseline, including an empty one.
openclaw agent-system install

# inspect the installed route and the last successful observation.
openclaw agent-system doctor

# process later assignments immediately.
openclaw agent-system notifications refresh

# inspect the live gateway scheduler and connection health.
openclaw channels status --channel agent-system-github --json
```

`install` fails with `github-notification-baseline-failed` if it cannot establish
the initial baseline. Only assignments observed after a successful installation
baseline create local work.

## Configuration Reference

Notifications share the surrounding GitHub host, account, and credential:

```yaml
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

| Field                       | Required | Default | Purpose                                  |
| --------------------------- | -------- | ------- | ---------------------------------------- |
| `approved-actors`           | yes      | none    | GitHub users allowed to assign work      |
| `allowed-repository-owners` | no       | any     | Filters assignments by repository owner  |
| `interval-minutes`          | no       | `5`     | Sets the polling interval from 1 to 1440 |

Every approved actor and allowed owner requires a GitHub login and immutable
GitHub node id. Node ids must be unique within each list.

`allowed-repository-owners` is an optional filter. When present, the channel
rejects assignments from repositories whose owner is not listed. It does not
grant repository access or approve that owner's members to assign work; the
agent account still needs sufficient repository access and the assigning actor
must still appear in `approved-actors`.

`github.token` names an environment variable and never accepts a literal token.
For private repositories, configure
[`git.ssh`](../../tools/git/README.md#gitsshprivate-keys) so the Git capability
can prepare the worktree without embedding a token in its clone URL.

## CLI

```text
openclaw agent-system notifications refresh [--agent <id>] [--json]
```

| Option         | Purpose                                                   |
| -------------- | --------------------------------------------------------- |
| `--agent <id>` | Selects an installed agent instead of workspace discovery |
| `--json`       | Returns an undecorated machine-readable result            |

The command runs the same intake lifecycle immediately. It reports baseline
readiness, diagnostics, and retry timing, and it can create a managed worktree
and local session for an accepted issue or a session for an accepted pull
request. It does not wait for planning;
the running Gateway picks up that checkpoint asynchronously. Deferred and failed
cycles return a nonzero exit code.

See the [complete CLI reference](../../ADVANCED.md#openclaw-agent-system-notifications-refresh)
for result and concurrency semantics.

## Explicit Progress Publication

Open the active local notification session for an issue or pull request, complete any desired
tool-enabled inspection in an ordinary local turn, then explicitly select the
public update with:

```text
/agent-system-progress Implementation is underway and the current checks are passing.
```

The slash command bypasses the model. It publishes the selected text only after
the common bounded-content safety gate and the same send-time assignment,
manifest, GitHub policy, repository permission, account identity, durable
delivery, and unknown-send reconciliation used by other notification replies.
The command requires an authorized Gateway client with `operator.write` scope
in the exact active assignment session. GitHub-originated messages and ordinary
local chat cannot trigger it, and owner status on a remote chat surface does not
substitute for Gateway operator scope.

The selected update is trimmed, limited to 800 characters, and rejected if it
contains secrets, links, mentions, local paths, structured tool output, or
unsupported formatting. A failed or pending publication remains visible through
`doctor`; automatic replay is deferred to the notification state-management
phase.

## Security and Lifecycle

The installed channel account and binding must route to the same agent and
workspace that own the manifest. Missing, duplicate, conflicting, or cross-agent
routing fails closed.

An assignment is accepted only when the authenticated account is still assigned,
the immutable assigning actor is approved, the repository owner is eligible,
and the account has sufficient repository access.

Issue and pull-request prose, top-level comments, and summary-only changed-file
metadata are bounded and framed as untrusted project data. Planning and
admitted-comment turns cannot use tools, and their complete responses remain in
the private OpenClaw session. Only separately labeled
acknowledgment or GitHub-reply candidates, plus text explicitly selected by the
local progress command, can pass through the fail-closed publication gate,
which rejects secrets, links, mentions, local paths, and unsupported output.

A comment mention addresses the agent but does not authorize file inspection,
repository commands, tests, implementation, or any other tool use. Status
questions may be answered from evidence already recorded in the assignment
session and Agent System-owned checkpoints. If that evidence is insufficient, the reply
must say that no verified current update is available from the notification
turn. A later tool-enabled status check remains an ordinary local turn, and its
result leaves the private session only when an operator explicitly selects a
bounded update with `/agent-system-progress`.

Private monitor state contains no tokens, GitHub prose, or generated content.
For a directly assigned pull request, Agent System records the verified head ref
and SHA used for admission in the private session context. It does not prepare a
managed worktree or authorize code inspection. Repository commands or
implementation require a separate authorized local action. Closing or merging
the PR retires the route logically while preserving its session. Issue-to-PR
correlation, review requests, and inline review-comment intake remain outside
this phase.

Deterministic issue-worktree, session, activation, and publication identities make
delivery retry-safe without duplicating local work or GitHub comments.

`install` adds or repairs only the channel account and binding owned by Agent
System. Removing `github.notifications` and running `install` again retires
outstanding local assignments, removes the owned route and converged private
monitor state, and stops new intake. Existing issue worktrees and sessions are
preserved deliberately; use a fresh isolated OpenClaw profile and agent id when
a post-delivery test must begin without those artifacts.

## Further Reading

- [Agent System README](../../README.md): installation and the common manifest workflow
- [Advanced](../../ADVANCED.md): complete manifest and CLI reference
- [Git tools](../../tools/git/README.md): managed worktree configuration and behavior
- [GitHub CLI tool](../../tools/github/README.md): shared GitHub identity and credential configuration
