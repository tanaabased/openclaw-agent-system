# Agent System GitHub Notifications Channel

<p align="center">
  <img src="../../assets/github-icon-large.svg" alt="Agent System GitHub notifications" width="180" />
</p>

The GitHub notifications channel currently owns trusted polling, assignment
admission, durable deduplication, routing, and managed issue-worktree intake.
Accepted issues receive a private assignment card and an immediate public
acknowledgment, then run one initial assignment turn that keeps its full report
in the OpenClaw session and publishes a bounded conversational response. For
prepared issues, the channel also admits new approved comments into that session
and publishes the accepted public part of the response.

## Current Behavior

- `install` records the agent's currently assigned open work items as a safe
  baseline without creating local work. An empty result is valid.
- Later polling or `notifications refresh` discovers new issue and pull-request
  assignments and admits only authorized actors, repositories, and events.
- Accepted issues create or reuse one deterministic managed worktree and one
  OpenClaw lifecycle session. The session begins with a compact assignment card,
  then the channel publishes one deterministic, varied acknowledgment before
  running the registered `issue`, `work`, and `assignment` turn. The turn keeps
  its private assessment and plan or blocking questions in the session and may
  publish one bounded conversational response. Pull-request assignments retain
  bounded head metadata without creating a worktree.
- Prepared issues establish a comment baseline without replaying history. A new
  or edited exact-mention comment from an approved human resumes the existing
  issue session with an attributed comment card as its direct message. The card
  replaces admitted account mentions with the installed agent emoji and name,
  links the agent to OpenClaw's Agents page, and links its footer to the GitHub
  author and exact source comment. Agents without an emoji use `🤖`.
- Incoming GitHub prose remains exact apart from the presented account mention,
  including its standard Markdown source, and the untouched comment is retained
  as the raw inbound body. GitHub-specific shorthand may remain literal in
  OpenClaw. Each lifecycle projects its own bounded source, repository, and
  resource facts as private structured context. The current comment flow
  requires the agent's `coding` profile.
- Hidden instructions for assignment and comment turns are composed from their
  registered lifecycle, mode, and event definitions, selected from the private
  active-turn descriptor, and injected through the prompt hook. Missing or
  unsupported selection does not fall back to a different prompt.
- Each completed model turn keeps its private response in the session and may
  publish one validated public response to GitHub. Missing or invalid public
  responses are withheld without discarding the private response.
- Public replies are concise conversational comments and may use GitHub-flavored
  Markdown when it improves clarity. Publication still rejects secrets,
  credentials, hidden context, and literal model-authored mentions. File
  references should use repository-relative paths instead of absolute worktree
  paths. The model can position one reserved commenter placeholder naturally;
  after exact-source reauthorization, Agent System replaces it with the verified
  author login or prefixes that trusted mention when the placeholder is omitted.
- Pull-request comments, Plan and Auto modes, mode transitions, implementation
  after the initial assignment plan, and chat-originated publication remain
  intentionally dormant.
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
  emoji: 🤖

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
openclaw agent-system notifications refresh [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] [--timeout <seconds>] [--json]
openclaw agent-system notifications status [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] [--json]
openclaw agent-system notifications wait [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] --for <target> [--refresh] [--timeout <seconds>] [--json]
```

A repository, kind, and number selector is all-or-nothing. `refresh` runs the
same intake cycle as scheduled polling and defaults to a 300-second timeout. It
may also process one admitted comment for a prepared issue. `status` returns a
redacted view of assignment and intake state.

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
waits return nonzero.

See [Advanced](../../ADVANCED.md) for the complete shared CLI and manifest
reference.

## Security and Lifecycle

- Installed account and workspace routing must match the manifest. Missing,
  duplicate, conflicting, or cross-agent routing fails closed.
- Admission requires the authenticated assigned account, an approved immutable
  assigning actor, an eligible repository owner, and sufficient repository
  access.
- Comment reads are bounded, and conversation state retains revision digests
  rather than incoming provider prose.
- An approved actor may enter the conversation but cannot select capabilities.
  The current channel-owned turn identity selects the registered `issue`,
  `work`, and `assignment` or `comment` combination; its registry rejects
  unsupported combinations, and the trusted Work policy requires the configured
  `coding` profile.
- When material information is missing, assignment instructions tell the agent
  to ask the smallest complete set of blocking questions and stop. A later
  admitted comment resumes the same session; no separate clarification phase is
  persisted.
- A staged reply does not itself authorize publication. Agent System reauthorizes
  the exact source author and destination before loading credentials, substitutes
  only that verified commenter mention, and publishes idempotently. Assignment
  acknowledgments pass through the same publication safety, authorization,
  marker, and reconciliation boundary without model-authored text. Assignment
  responses use the model-turn candidate boundary and are reauthorized before
  publication.
- Private monitor and conversation state contain no tokens.
- Removing `github.notifications` and reinstalling retires tracked assignments,
  removes owned routing and converged monitor state, and stops intake without
  deleting existing issue worktrees.

## Further Reading

- [Design](./DESIGN.md): target message flow, lifecycle types, modes, durable
  conversation state, and response boundaries
- [Presentation](./PRESENTATION.md): reusable visible component definitions
- [Agent System README](../../README.md): installation and common manifest workflow
- [Advanced](../../ADVANCED.md): complete manifest and CLI reference
- [Git tools](../../tools/git/README.md): managed worktree configuration
- [GitHub CLI tool](../../tools/github/README.md): shared GitHub identity and credentials
