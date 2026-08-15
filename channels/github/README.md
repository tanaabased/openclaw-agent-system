# Agent System GitHub Notifications Channel

<p align="center">
  <img src="../../assets/github-icon-large.svg" alt="Agent System GitHub notifications" width="180" />
</p>

The GitHub notifications channel currently owns trusted polling, assignment
admission, durable deduplication, routing, and managed issue-worktree intake.
For prepared issues, it also admits new approved comments into one OpenClaw
lifecycle session and publishes the accepted public part of the response.

## Current Behavior

- `install` records the agent's currently assigned open work items as a safe
  baseline without creating local work. An empty result is valid.
- Later polling or `notifications refresh` discovers new issue and pull-request
  assignments and verifies the agent account, assigning actor, repository owner,
  repository access, and exact assignment event.
- Each admitted assignment resolves through its lifecycle machine id before
  lifecycle-specific local resources are reconciled.
- Accepted assignments converge on the lifecycle-neutral `prepared` intake
  checkpoint. Issues create or reuse one deterministic managed worktree;
  pull-request assignments retain bounded head metadata without creating one.
- Each prepared issue establishes a bounded comment baseline without replaying
  history. A later new or edited exact-mention comment from an approved human is
  re-read canonically and admitted as a direct message in the issue session.
- The visible inbound message is the normalized author-written comment. Bounded
  source and worktree facts are model-only context, and Work instructions are
  injected behind the scenes for that run.
- The current comment slice requires the configured agent's `coding` profile.
  It preserves that configured native coding surface across the built-in
  OpenClaw and Codex harnesses instead of choosing a harness-specific tool list.
- A comment turn accepts one complete private response with one quoted
  `To GitHub` candidate. Only the bounded candidate is persisted, reauthorized,
  reconciled by exact body and hidden marker, and published to GitHub.
- Pull-request comments, assignment cards and acknowledgments, initial planning
  turns, Plan and Auto modes, mode transitions, and chat-originated publication
  remain intentionally dormant.
- Closing, merging, unassigning, or otherwise losing authority retires the
  tracked item logically without deleting an existing issue worktree.

The target lifecycle, modes, states, and response boundary are documented in
[Design](./DESIGN.md). Visible component definitions live in
[Presentation](./PRESENTATION.md).

## Requirements

- Agent System installed and enabled
- Git available as `git`
- GitHub CLI available as `gh`
- an Agent System workspace manifest with an agent id and Git author email
- `git.worktrees`, `github.username`, `github.token`, and
  `github.notifications` configured
- the named GitHub token available in the completed Agent System environment
- an OpenClaw model configured for the notification agent
- the notification agent's effective OpenClaw tool profile set to `coding`

The GitHub account must have `write`, `maintain`, or `admin` access to every
repository from which the channel accepts assignments.

## Configuration

Add the notification channel to `.agent-system/agent.yaml` or the root
`agent.yaml`:

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
    assignment-types:
      - issue
    interval-minutes: 5
    approved-actors:
      - login: pirog
        node-id: U_kgDOB9x7Qw
    allowed-repository-owners:
      - login: tanaabased
        node-id: O_kgDOB7x6Qw
```

| Field                       | Required | Default                    | Purpose                                 |
| --------------------------- | -------- | -------------------------- | --------------------------------------- |
| `assignment-types`          | no       | `issue` and `pull-request` | Selects assignment kinds to discover    |
| `approved-actors`           | yes      | none                       | GitHub users allowed to assign work     |
| `allowed-repository-owners` | no       | any                        | Filters assignments by repository owner |
| `interval-minutes`          | no       | `5`                        | Sets polling from 1 to 1440 minutes     |

Every approved actor and allowed owner requires a GitHub login and immutable
GitHub node id. Node ids must be unique within each list. The optional owner
filter does not grant repository access or approve that owner's members.

`github.token` names an environment variable and never accepts a literal token.
For private repositories, configure
[`git.ssh`](../../tools/git/README.md#gitsshprivate-keys) so worktree
preparation does not embed a token in a clone URL.

## Usage

From the agent workspace:

```sh
# validate desired state without changing installed state.
openclaw agent-system validate

# reconcile routing and establish the first safe baseline.
openclaw agent-system install

# run intake and prepared-issue comment reconciliation immediately.
openclaw agent-system notifications refresh

# inspect redacted intake state.
openclaw agent-system notifications status --json

# wait for one issue worktree.
openclaw agent-system notifications wait \
  --repository tanaabased/example \
  --kind issue \
  --number 12 \
  --for worktree-ready \
  --refresh \
  --json
```

`install` fails with `github-notification-baseline-failed` when the first
baseline cannot be established. Only assignments observed after that baseline
create local work.

### CLI Reference

```text
openclaw agent-system notifications refresh [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] [--json]
openclaw agent-system notifications status [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] [--json]
openclaw agent-system notifications wait [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] --for <target> [--refresh] [--timeout <seconds>] [--json]
```

A repository, kind, and number selector is all-or-nothing. `refresh` runs the
same bounded, lease-protected intake cycle as the scheduler. `status` projects
only baseline readiness, lifecycle id, admission disposition, intake stage,
issue-worktree readiness, and bounded pull-request head metadata; it omits
provider prose, credentials, session identifiers, and local paths.

For a prepared issue, a refresh may also run one admitted comment turn and wait
for its GitHub response publication. The monitor status schema remains limited
to provider intake; comment revisions and publication receipts live in separate
private conversation state.

`wait` supports these stable intake checkpoints:

| Target                | Meaning                                       |
| --------------------- | --------------------------------------------- |
| `baseline-ready`      | The first safe provider observation completed |
| `assignment-rejected` | The selected assignment failed admission      |
| `prepared`            | Lifecycle-owned intake resources are ready    |
| `worktree-ready`      | The selected issue worktree is ready          |
| `retired`             | The selected assignment retired logically     |

Every target except `baseline-ready` requires a complete item selector.
`--refresh` advances provider-owned intake while waiting. Failed and timed-out
waits return nonzero and include the last redacted observation in JSON.

See [Advanced](../../ADVANCED.md) for the complete shared CLI and manifest
reference.

## Security and Lifecycle

- Installed account and workspace routing must match the manifest. Missing,
  duplicate, conflicting, or cross-agent routing fails closed.
- Admission requires the authenticated assigned account, an approved immutable
  assigning actor, an eligible repository owner, and sufficient repository
  access.
- Comment listings and canonical re-reads are bounded. Conversation state keeps
  revision digests and the accepted public response but does not persist the
  incoming provider prose.
- An approved actor may enter the conversation but cannot select capabilities;
  the trusted Work policy requires the configured `coding` profile.
- Publication checks accepted conversation state before credentials are
  connected, reauthorizes the exact source revision and destination, serializes
  each target across processes, and reconciles both the hidden idempotency marker
  and exact accepted body.
- Private monitor state contains no tokens. Deterministic assignment and
  worktree identities make intake retry-safe.
- Removing `github.notifications` and reinstalling retires tracked assignments,
  removes owned routing and converged monitor state, and stops intake without
  deleting existing issue worktrees.

## Further Reading

- [Design](./DESIGN.md): target message flow, lifecycle types, modes, states,
  and response boundaries
- [Presentation](./PRESENTATION.md): reusable visible component definitions
- [Agent System README](../../README.md): installation and common manifest workflow
- [Advanced](../../ADVANCED.md): complete manifest and CLI reference
- [Git tools](../../tools/git/README.md): managed worktree configuration
- [GitHub CLI tool](../../tools/github/README.md): shared GitHub identity and credentials
