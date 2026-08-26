# Agent System GitHub Notifications Channel

<p align="center">
  <img src="../../assets/github-icon-large.svg" alt="Agent System GitHub notifications" width="180" />
</p>

The GitHub notifications channel currently owns trusted polling, assignment
admission, durable deduplication, routing, and managed issue-worktree intake.
Accepted issues receive a private assignment card and an immediate public
acknowledgment, then run one initial assignment turn that keeps its full report
in the OpenClaw session and publishes a bounded conversational response. A
published Work plan schedules one private implementation turn in the same
session and worktree on the next reconciliation. That turn implements,
validates, and creates one local commit. The lifecycle then prepends the trusted
issue number, performs the first ordinary push, and creates or normalizes one
pull request assigned to the issue author. For prepared issues, the channel also
links that delivered pull request to the issue-owned session, publishes a
private `pull-request-opened` turn and deterministic handoff on the issue, admits
new approved comments from either item, and publishes each accepted response back
to its exact source item.

## Current Behavior

- `install` records the agent's currently assigned open work items as a safe
  baseline without creating local work. An empty result is valid.
- Later polling or `notifications refresh` discovers new issue and pull-request
  assignments and admits only authorized actors, repositories, and events.
- Accepted issues create or reuse one deterministic managed worktree and one
  OpenClaw lifecycle session. The session begins with a compact assignment card
  that names the current issue title, then the channel publishes one deterministic,
  varied acknowledgment before running the registered `issue`, `work`, and
  `assignment` turn. The turn receives bounded title, body, labels, and recent
  comments as private structured context, keeps its private assessment and plan in
  the session, and may publish one bounded conversational response. A valid
  published assignment response deterministically registers a pending `issue`,
  `work`, and `implementation` turn from trusted
  tuple state rather than model-authored report formatting. The next reconciliation
  carries out the plan and validates it in the same session and worktree, then
  creates one local commit without publishing another GitHub response. Durable
  lifecycle delivery prepends the trusted issue number to that commit, performs
  the first ordinary push, and creates or normalizes one open pull request with
  the issue title, default base branch, closing reference, and issue-author
  assignee. Delivery checkpoints that pull request as the bounded delivery source,
  baselines its existing comments without replaying them, runs the registered
  `issue`, `work`, and `pull-request-opened` turn with a private card and response,
  and publishes one deterministic handoff comment on the issue. Pull-request
  assignments retain bounded head metadata without creating a worktree.
- Each prepared issue and its open delivery pull request establish independent
  comment baselines without replaying history. A new or edited exact-mention
  comment from an approved human on either item resumes the existing issue-owned
  session with an attributed comment card as its direct message. The card
  replaces admitted account mentions with the installed agent emoji and name,
  links the agent to OpenClaw's Agents page, and links its footer to the GitHub
  author and exact source comment. The accepted reply is published back to that
  same issue or pull request. Agents without an emoji use `🤖`.
- Incoming GitHub prose remains exact apart from the presented account mention,
  including its standard Markdown source, and the untouched comment is retained
  as the raw inbound body. GitHub-specific shorthand may remain literal in
  OpenClaw. Each lifecycle projects its own bounded source, repository, and
  resource facts as private structured context. The current comment flow
  requires the agent's `coding` profile.
- Hidden instructions for assignment, implementation, pull-request-opened, and comment turns are
  composed from their registered lifecycle, mode, and event definitions,
  selected from the private active-turn descriptor, and injected through the
  prompt hook. Missing or unsupported selection does not fall back to a
  different prompt.
- Each completed model turn keeps its private response in the session. Turns
  with a publication intent may publish one validated public response to GitHub;
  the implementation continuation has no publication intent. Missing or invalid
  public responses are withheld without discarding the private response.
- Public replies are concise conversational comments and may use GitHub-flavored
  Markdown when it improves clarity. Publication still rejects secrets,
  credentials, hidden context, and literal model-authored mentions. File
  references should use repository-relative paths instead of absolute worktree
  paths. The model can position one reserved commenter placeholder naturally;
  after exact-source reauthorization, Agent System replaces it with the verified
  author login or prefixes that trusted mention when the placeholder is omitted.
- Plan and Auto modes, mode transitions, directly assigned pull-request comment
  sessions, and chat-originated publication remain intentionally dormant.
- A provider-verified repository rename refreshes the tracked canonical name,
  owner login, clone URL, default branch, and permission. Issue worktree
  preparation may then reconcile the shared managed clone origin after matching
  the immutable repository and owner identities; ordinary worktree callers
  cannot retarget a managed repository.
- Closing the delivery pull request without merging deactivates only that comment
  source; reopening it establishes a fresh baseline before new comments are
  admitted. Merging the delivery pull request retires the issue-owned lifecycle.
  Closing, merging, unassigning, or otherwise losing authority still retires a
  directly tracked item. When retirement is provider-verified and implementation
  is complete, the channel archives the unpinned lifecycle session and removes
  only its clean deterministic worktree. Pinned sessions, active or incomplete
  conversations, and dirty or unsafe worktrees are retained. Redacted cleanup
  outcomes remain visible through notification status and are retried idempotently.

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
  ssh:
    private-keys: ~/.ssh/id_ed25519

github:
  host: github.com
  username: tanaabot
  token: GH_TOKEN_TANAABOT
  ssh-keys: ~/.ssh/id_ed25519.pub
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
Work delivery requires [`git.ssh`](../../tools/git/README.md#gitsshprivate-keys)
for the authenticated branch push. The matching public key must already belong
to the configured GitHub account, or `github.ssh-keys` can declare it for
`install` to reconcile. SSH configuration also keeps private-repository
worktree preparation free of credential-bearing clone URLs.

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
- Assignment and comment reads are bounded. Assignment content is reauthorized at
  model-turn time, and monitor and conversation state do not retain incoming
  provider prose.
- An approved actor may enter the conversation but cannot select capabilities.
  The current channel-owned turn identity selects the registered `issue`,
  `work`, and `assignment`, `implementation`, or `comment` combination; its
  registry rejects unsupported combinations, and the trusted Work policy
  requires the configured `coding` profile.
- The current Work assignment slice requires an implementation-ready plan and
  does not yet expose a clarification pause as a structured lifecycle outcome.
  The target clarification behavior remains documented in `DESIGN.md`.
- A staged reply does not itself authorize publication. Agent System reauthorizes
  the exact source author, derives its issue or delivery pull-request destination
  from the frozen source, then loads credentials, substitutes only that verified
  commenter mention, and publishes idempotently. Assignment
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
