# GitHub Notifications Plan

Status: Phase 0 routing foundation implemented; installed inbound delivery and
later phases proposed

Phase 0 now ships the strict manifest schema, static local-only channel,
account-scoped routing projection, private ownership receipt, lifecycle
inspection/reconciliation, and an injected inbound-kernel route-selection test.
It deliberately does not register production assignment delivery, poll GitHub,
resolve a token, create a worktree, or start a real agent briefing.

This document plans an Agent System-owned GitHub work-notification channel. The
Phase 0 configuration and routing foundation described below are implemented;
installed inbound delivery, remote event discovery, and work execution remain
planned behavior.

## Recommendation

Build this as three cooperating pieces rather than one privileged poller:

1. a GitHub assignment monitor discovers assigned work and verifies its actor,
   repository, and agent authority;
2. the existing Git worktree capability prepares the authorized repository work
   area from canonical GitHub metadata;
3. an `agent-system-github` inbound channel routes the accepted event into one
   deterministic OpenClaw session.

Put the per-agent configuration under `github.notifications`, not in a new
top-level section. The feature is GitHub-specific, reuses the existing GitHub
identity and token contract, and does not yet justify a provider-neutral
notification abstraction. If another provider later proves the same lifecycle,
extract common orchestration then rather than designing it speculatively now.

The channel should create a local OpenClaw conversation record, but it should
not automatically publish every assistant reply to GitHub. An explicit publish
action is a safer later addition: automatic mirroring could expose private chat,
local paths, failed attempts, or sensitive output.

## Important Corrections to the Initial Idea

- Do not use GitHub's Notifications REST endpoint as the authoritative event
  stream. Its notification reason can change and then remain sticky, and the
  endpoint does not support fine-grained personal access tokens or GitHub App
  tokens. Use authenticated account-wide assignment search for discovery, then
  targeted assignment events and canonical issue or pull request state for
  admission. The product may still be called notifications.
- Treat pull requests as issue-shaped only for assignment state. GitHub's Issues
  API returns pull requests too, but pull-request review requests are a distinct
  workflow and should be added separately.
- Do not delete a session on unassignment. Retire the work item, stop routing new
  events, and preserve the transcript. OpenClaw or an operator can archive it
  when a supported archive seam is available.
- Do not remove a worktree automatically on unassignment. It may contain useful
  or dirty work. Retain it and make cleanup an explicit, policy-checked operator
  action.
- Require an approved actor to start work or send instructions, but honor any
  canonical unassignment of the agent as a revocation. Continuing after the
  assignee was removed is less safe than accepting the possibility of a
  repository-authorized user stopping work.
- A linked issue closes when the pull request is merged into the default branch,
  not merely when the pull request is closed. Use `Closes #<number>` in the pull
  request body and request review from the original assigner when possible.

## MVP Outcome

For each configured agent, the Gateway will:

- poll GitHub for work assigned to the authenticated agent, with five minutes
  as the default interval;
- verify the token's GitHub identity on every polling cycle before consuming
  repository data;
- establish a baseline on first activation without starting work for every
  existing assignment;
- detect a new issue or pull request assignment to the authenticated agent;
- prove that the assignment event came from an approved immutable GitHub actor;
- require the agent to have at least write permission on the canonical
  repository and optionally constrain repository owners by immutable id;
- derive the worktree repository id, clone URL, and base ref from canonical
  GitHub metadata rather than a per-repository manifest entry;
- prepare one deterministic managed worktree;
- create or reuse one deterministic issue-scoped OpenClaw session;
- run one bounded, read-only briefing turn that summarizes the work item and
  identifies initial questions or risks;
- preserve the work item's repository, issue, assignment, worktree, and session
  correlation in private durable state;
- retire the work item when the agent is unassigned, while preserving both the
  transcript and worktree.

The automated briefing is the end of autonomous MVP behavior. It may inspect
bounded issue metadata, but it must not edit code, comment on GitHub, push, or
open a pull request. The operator continues the work in the created session
under normal Agent System tool policy and approval rules.

## Non-goals for the First MVP

- GitHub webhooks or GitHub App installation management
- per-repository manifest enumeration
- treating organization membership alone as repository authorization
- automatic ingestion of arbitrary issue bodies or comments as instructions
- review-request, mention, team, project, discussion, or workflow notifications
- automatic issue, branch, commit, push, or pull request creation
- automatic mirroring of every local assistant response to GitHub
- destructive session or worktree cleanup
- multiple GitHub hosts
- a generic cross-provider notifications framework

## Proposed Manifest Shape

The exact schema is a Phase 0 deliverable. The intended public shape is:

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot

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
    repository-policy:
      minimum-permission: write
      allowed-owners:
        - login: tanaabased
          node-id: O_kgDOB7x6Qw
```

Configuration rules:

- The presence of `github.notifications` enables the monitor for that agent.
- `interval-minutes` defaults to `5`, has a minimum of `1`, and is still subject
  to provider rate-limit and backoff instructions.
- At least one `approved-actors` entry is required.
- Actor authorization uses the opaque `node-id`; `login` is required for human
  review and drift diagnostics but is not the authorization key.
- `repository-policy.minimum-permission` defaults to `write`. The MVP does not
  permit `read` or `triage`, because the expected workflow must be able to push
  a branch and open a pull request. GitHub's legacy `write` result includes the
  `maintain` role; `admin` also satisfies the gate.
- `allowed-owners` is optional. When present, the repository owner's opaque
  user or organization node id must match. When absent, any repository is
  eligible if the verified agent has write permission and the assignment actor
  is approved.
- `allowed-owners` restricts repository ownership; it does not authorize every
  member of an allowed organization to instruct the agent. Assignment and
  comment authority remains the exact `approved-actors` user-id set. If that
  list later becomes burdensome, add approved GitHub teams with explicit member
  lookup rather than trusting an entire organization by default.
- Agent organization membership is not an admission shortcut. Membership does
  not imply access to every organization repository, excludes valid outside
  collaborators, and can require additional organization-member scopes. The
  effective repository permission is both more direct and easier to revoke.
- The provider response, never the event or model, supplies the canonical
  repository node/database id, owner identity, supported clone URL, and default
  branch. Agent System derives a stable internal repository id such as
  `github-<database-id>` and an `origin/<default-branch>` base ref.
- The event and model cannot supply a clone URL, base ref, local path,
  executable, repository id, or agent id.
- The authenticated agent's GitHub node id is resolved from `/user` at poll
  time. Assignment targets must match that verified identity, not only a login
  string from the event.
- GitHub App and bot actors are denied in the MVP. A later schema can add
  explicitly pinned app identities if a real use case requires them.

No cleanup options are proposed initially. The safe behavior is fixed:
retire the session association and retain the worktree.

## Manifest-to-OpenClaw Reconciliation

The workspace manifest remains the source of desired per-agent behavior, but a
channel cannot be entirely workspace-local. OpenClaw routes inbound messages
through global channel accounts and `bindings`, so Agent System must project a
small, non-secret routing record into the active OpenClaw configuration.

For an agent named `tanaabot`, the intended global projection is semantically:

```json5
{
  channels: {
    'agent-system-github': {
      accounts: {
        tanaabot: { enabled: true },
      },
    },
  },
  bindings: [
    {
      agentId: 'tanaabot',
      match: {
        channel: 'agent-system-github',
        accountId: 'tanaabot',
      },
    },
  ],
}
```

The channel account id equals the normalized Agent System agent id. Each work
item is a distinct channel conversation beneath that account. The account-level
binding therefore selects the correct agent and workspace, while the work-item
conversation id selects the deterministic session.

This global projection contains only activation and routing facts. Keep the
GitHub token binding, poll interval, approved actors, repository-owner policy,
work state, and GitHub content in the owning workspace manifest or private
Agent System state. Never duplicate those values under `channels.*`.

Lifecycle ownership:

- `validate` checks the manifest projection without reading or mutating global
  OpenClaw state.
- `doctor` reads the manifest, global channel account, routing bindings, and an
  Agent System ownership receipt. It reports missing, duplicate, conflicting,
  or stale projections without repairing them.
- `install` is the only Agent System command that creates or repairs the channel
  account and exact account-scoped binding. It runs after agent registration,
  re-reads the config, and verifies that OpenClaw resolves this channel account
  to the same agent and workspace.
- Removing `github.notifications` makes the desired state disabled. A later
  `install` removes only the exact channel account and binding recorded in the
  private ownership receipt. If either target was changed or is now owned by
  another agent, installation stops with a conflict instead of replacing it.
- The runtime monitor stays stopped unless the loaded manifest, channel account,
  account-scoped binding, agent id, and workspace all agree. OpenClaw's fallback
  to the default agent must never activate this channel.

The pinned SDK exposes a supported transactional `mutateConfigFile` boundary
with explicit reload intent. Phase 0 therefore creates or removes the
activation-only account and exact binding in one focused source-config mutation
with `afterWrite: auto`, then verifies the resolved route before writing or
removing the private receipt. The mutation preserves unrelated channel accounts
and bindings and avoids editing `openclaw.json` directly or leaving a
multi-command half-install behind.

OpenClaw hot-applies `bindings`. Updating an existing `channels.*` account can
restart only the affected channel, while creating or removing the top-level
channel configuration can require a full Gateway restart. The owning GitHub
Actions-only Leia scenario runs the Gateway with in-process restarts enabled,
then verifies runtime config convergence and cleanup without losing process
tracking. If reload watching is disabled, installation should report that a
manual Gateway restart is still required. The implemented binding also sets
`dmScope: per-account-channel-peer`, so each stable GitHub work-item conversation
becomes a distinct session. Repository validation never mutates the developer's
live Gateway.

## Trust and Prompt-Injection Model

An approved GitHub identity is necessary but not sufficient to make every byte
of a GitHub object a trusted instruction.

### Trusted control facts

- configured agent id and workspace
- verified GitHub account node id and login
- verified global channel account and account-scoped agent binding
- canonical repository and owner ids, effective agent permission, supported
  clone URL, and default branch returned by GitHub
- assignment or unassignment event id, actor node id, assignee node id, and
  timestamp returned by GitHub
- worktree result returned by the existing Agent System service
- deterministic session and work-item ids generated locally

### Untrusted content

- issue and pull request titles and bodies
- comments, quoted text, links, patches, filenames, and repository contents
- labels and milestone descriptions
- any text supplied by a GitHub actor, including an approved actor quoting
  someone else

Authorization must complete using only trusted control facts. Untrusted content
is fetched only after admission and is placed in a bounded, explicitly labelled
data block. The automated briefing turn should receive no mutating tools. It may
summarize the data and propose an approach, but it cannot turn pasted issue text
into a side effect.

Subsequent interactive turns use normal Agent System policy. The GitHub token's
repository permissions remain the final remote authorization boundary.

## Event Admission

An assignment is accepted only when all of these are true:

1. the monitor has an exact account-scoped OpenClaw binding from
   `agent-system-github:<agent-id>` to the loaded manifest's agent and workspace;
2. the GitHub token resolves and `/user` matches `github.username`;
3. GitHub's canonical repository response is active and its owner satisfies any
   configured `allowed-owners` constraint;
4. GitHub reports that the verified agent has at least the configured repository
   permission, defaulting to `write`;
5. the item is currently assigned to the verified GitHub agent identity;
6. a new `assigned` event targets that identity;
7. the assigner's opaque node id matches `approved-actors`;
8. the event is newer than the initial baseline and has not been processed;
9. the work item is not already active through an issue-to-pull-request
   correlation.

An unassignment is acted on when the canonical item state no longer contains
the agent or a new `unassigned` event targets it. The actor is recorded, but
revocation does not require an approved actor.

Events authored by the agent itself and outbound records already written by
Agent System are ignored to prevent feedback loops.

## Polling and State

Use an authenticated account-wide issue and pull-request search for discovery,
with a bounded overlap on `updated` time and `assignee:<verified-login>`. Search
results are candidates, not authority. For each new candidate, fetch the
canonical repository, effective agent permission, item state, and targeted
assignment events before admission. Recheck every active work item directly so
an unassignment is detected even though the item disappears from the assignee
search result.

The GitHub Notifications REST endpoint may be an optional discovery accelerator
for compatible credentials, but it is never required and never authorizes a
transition. Detect and diagnose search-result truncation rather than silently
skipping work. Do not pass arbitrary URLs, search strings, or GraphQL documents
from the manifest or model. Keep the provider client typed and
transport-neutral; an initial implementation may reuse the existing fixed `gh
api` child environment, while allowing a later direct HTTP transport without
changing the workflow contract.

Each agent gets private durable state beneath the plugin state directory. Store
only non-secret facts:

- repository identity, verified permission, and poll high-water mark
- conditional-request metadata when supported
- processed event node ids
- active and retired work-item records
- assigner, assignee, worktree, branch, session, and linked pull request ids
- last successful poll, current backoff, and stable diagnostic code

Do not persist tokens, issue bodies, comment bodies, model prompts, or command
output in the monitor state.

Polling behavior:

- no overlapping poll for the same agent;
- bounded concurrency across discovered and active work items;
- a small search overlap window plus event-id deduplication to avoid cursor
  gaps;
- jitter around the configured interval;
- exponential backoff for transient failures;
- honor GitHub rate-limit and retry headers;
- stop through an `AbortSignal` when the Gateway or plugin service stops;
- make every transition idempotent so restart and retry cannot duplicate a
  worktree, session, briefing, or GitHub write.

On first enablement, record the current assigned-item snapshot and search
boundary without creating sessions. A future explicit replay command may opt
into older assignments, but replay is not implicit.

## Work-item Identity and Lifecycle

Use the stable work-item key:

```text
github:<repository-node-id>:<issue-number>
```

GitHub pull requests also have issue numbers, so the repository node id and
number are sufficient. Store the item type separately.

Derive a human work id from trusted and sanitized metadata:

```text
gh-<owner>-<repo>-<number>-<title-slug>
```

Pass that work id to the existing worktree service and use the returned branch
and path as authoritative. Pass the internally derived
`github-<repository-database-id>`, provider-selected canonical clone URL, and
`origin/<default-branch>` rather than requiring a manifest repository entry. Do
not predict the worktree service's digest or reimplement its naming rules.

```mermaid
stateDiagram-v2
    [*] --> Baseline
    Baseline --> Rejected: unauthorized assignment
    Baseline --> Preparing: authorized new assignment
    Preparing --> Preparing: retryable failure
    Preparing --> Active: worktree and briefing session ready
    Active --> Active: duplicate event or normal conversation
    Active --> Retired: unassigned, closed, or merged
    Retired --> Preparing: later authorized reassignment
```

Persist the transition before and after each external side effect. Worktree
preparation and session routing use deterministic ids, so recovery can inspect
and resume rather than blindly repeat.

## Session and Channel Behavior

Register a static channel id such as `agent-system-github`; do not claim the
generic `github` channel id. The plugin already owns multiple capabilities, so
keep the root `index.ts` entry and register the channel explicitly rather than
turning the whole package into a channel-only entrypoint.

Map one GitHub work item to one stable channel conversation id. The channel
inbound pipeline should create or reuse the corresponding agent session and
record origin metadata. The inbound route uses the manifest agent id as its
channel account id; delivery fails closed if the exact global account binding is
missing or selects another agent. The initial inbound event contains:

- repository, item type, number, title, URL, labels, and milestone summary;
- assigner identity and assignment time;
- returned worktree path and branch;
- an explicit statement that GitHub content is untrusted project data;
- a request to summarize the issue, its surrounding context, likely approach,
  risks, and open questions.

The automated briefing is local-only. A no-op or suppressed outbound adapter
must not post its answer to GitHub. The response remains visible in the OpenClaw
session transcript.

The pinned SDK exposes channel inbound routing and long-lived plugin services,
but it does not expose a clear external-plugin API for setting an arbitrary
native session title, binding its cwd, or archiving it. Phase 0 must prove these
behaviors. Safe fallbacks are:

- project worktree and issue metadata through a plugin session extension;
- a conversation label derived from the returned branch;
- explicit tool `cwd` values pointing at the managed worktree;
- logical retirement in Agent System state without deleting the OpenClaw
  transcript.

Do not depend on the bundled-only `scheduleSessionTurn` helper. The channel's
accepted inbound event should start the briefing turn directly.

## Pull-request Completion Contract

The assignment workflow does not automatically open a pull request. Once the
operator and agent finish the work in the session, the existing Git and GitHub
tools remain the execution surface.

Session guidance should require:

- a pull request body containing `Closes #<issue-number>` when the pull request
  targets the repository's default branch;
- the stored original assigner requested as a reviewer when that user is
  eligible, rather than merely assigning the pull request to them;
- the linked pull request id persisted on the existing work item so the agent's
  own pull request does not create a duplicate session;
- normal GitHub write policy and approvals for every mutation;
- no claim that a closed-but-unmerged pull request closes the issue.

## Phased Implementation

### Phase 0: Platform Contract Spike (routing foundation implemented)

Goal: prove the design against the supported OpenClaw SDK before adding remote
polling.

- Update or confirm the pinned OpenClaw compatibility version before using any
  newer channel API.
- Register an inert `agent-system-github` channel in discovery and full modes.
- Exercise a synthetic assignment through the current channel inbound helper in
  a unit test and prove deterministic route selection.
- Before Phase 2 enables assignment delivery, prove a local-only reply appears
  in the installed OpenClaw session without an outbound GitHub side effect.
- Before Phase 2, determine whether the current host supports a session label
  and per-session cwd. Record the fallback contract if it does not.
- Before Phase 2, determine the supported retirement/archive seam. Keep logical
  retirement if native archive is unavailable.
- Finalize an activation-only multi-account channel schema whose account id is
  the Agent System agent id.
- Add a notifications lifecycle contribution that always participates so
  `validate`, `doctor`, and `install` can detect both enabled state and removal.
- Prove supported creation and removal of the global channel account plus exact
  account-scoped binding without duplicating secrets or notification policy
  under `channels.*`.
- Record a private ownership receipt, reject a binding owned by another agent,
  preserve unrelated accounts and bindings, and verify the post-install route.
- Prove binding hot reload and channel configuration convergence, including a
  full in-process Gateway restart when the top-level channel appears or leaves.
  Report the manual-restart case when reload is disabled.
- Finalize the strict `github.notifications` schema and static plugin manifest
  channel metadata.

Implemented proof includes channel registration, strict schema normalization,
install/doctor reconciliation, idempotency, unrelated-state preservation, one
injected inbound-kernel route-selection test, explicit rejection of default or
mismatched routing, and receipt-backed cleanup. It does not yet prove production
assignment delivery, real transcript recording, or native session title, cwd,
and archive behavior. Those installed-runtime seams remain Phase 2 entry work.
The Leia scenario is the operational configuration-reload proof and remains
GitHub Actions-only.

### Phase 1: Read-only Monitor and Trust Core

Goal: discover and classify events without creating sessions or worktrees.

- Add manifest parsing and normalization for `github.notifications`.
- Add a typed GitHub work-event client with fixed endpoints and bounded output.
- Verify the authenticated agent's login and node id per polling cycle.
- Add account-wide assigned-item discovery, baseline, overlap, pagination-limit
  diagnostics, dedupe, backoff, and rate-limit handling.
- Fetch canonical repository identity, owner, clone/default-branch metadata, and
  effective agent permission before fetching untrusted issue content.
- Recheck active items directly for unassignment, permission loss, archival,
  transfer, or deletion.
- Add immutable actor admission and self-event suppression.
- Add a private atomic state store with symlink and permission checks.
- Register one long-lived Gateway plugin service with clean abort/stop behavior.
- Report value-free status through logs and `doctor`; add a read-only
  `notifications status` CLI only if it materially improves diagnosis.
- Run in observe-only mode in the owning Leia scenario.

Exit criteria: approved, rejected, duplicate, assignment, unassignment, first
baseline, repository-permission, owner-policy, search truncation, restart,
pagination, and transient-failure cases are deterministic under fake GitHub
responses and no local work is created.

### Phase 2: Assignment to Worktree and Briefing Session

Goal: complete the core MVP user experience.

- Expose the existing worktree service to the trusted workflow orchestrator;
  do not shell through the model-facing tool or impersonate a tool call.
- Treat an admitted assignment as authority only for deterministic worktree
  preparation and one read-only briefing turn.
- Derive the internal repository id from the immutable GitHub repository id and
  prepare the provider-authorized clone URL and default branch with the
  deterministic work id.
- Persist the returned branch and path.
- Dispatch the sanitized assignment through the channel into its deterministic
  session.
- Restrict the automated turn to non-mutating capabilities and bounded context.
- Project work-item metadata into the session using the supported extension or
  fallback contract.
- Honor unassignment by retiring routing and cancelling in-flight work without
  deleting the transcript or worktree.
- Recover correctly from failure before worktree creation, after worktree
  creation, and after session creation.

Exit criteria: a new approved assignment creates exactly one worktree and one
briefing session; retries and restarts create no duplicates; an unauthorized
assignment creates neither; unassignment prevents further automated turns and
preserves local state.

### Phase 3: Completion and Pull-request Correlation

Goal: keep one work item coherent through normal agent-led implementation.

- Add session guidance and metadata for the issue number, worktree, original
  assigner, and expected pull request linkage.
- Detect a pull request linked to the issue and correlate it to the existing
  work item rather than opening a second session.
- Ensure generated pull request guidance uses a closing keyword only for the
  default-branch completion path.
- Request review from the original assigner when eligible and authorized by
  normal GitHub policy.
- Retire completed work on merge or issue closure while retaining transcript
  and worktree until explicit cleanup.

Exit criteria: one issue remains one session across assignment, work, pull
request, review, and merge, with no self-notification loop.

Phases 0 through 3 are the complete assignment-driven MVP.

### Phase 4: Approved GitHub Comments Inbound

Goal: let authorized collaborators continue the active discussion from GitHub.

- Poll comments only for active configured work items.
- Require an exact approved actor node id and reject bot/app actors by default.
- Start with an explicit addressing rule, such as a comment beginning with an
  agent mention. Do not make every collaborator comment an instruction.
- Deduplicate by comment node id and track edits as revisions rather than
  replaying the original instruction.
- Route the accepted comment to the existing issue session with structured
  provenance and bounded content.
- Ignore comments authored by the agent or previously written by Agent System.
- Continue to apply normal tool policy and remote token permissions.

Exit criteria: an approved addressed comment reaches exactly one active
session; unapproved, unaddressed, edited-duplicate, retired-item, and self
comments produce no agent turn.

### Phase 5: Explicit Replies Back to GitHub

Goal: support a durable GitHub discussion without leaking the entire local
conversation.

- Add an explicit semantic publish action scoped to the active work item.
- Show the exact bounded comment content and target before any required
  approval and resolve credentials only after approval.
- Write the comment, store its node id, and render the same published text in
  the local session.
- Mark outbound comments for loop suppression using stored provider ids; a
  hidden marker may aid diagnosis but must never be the trust boundary.
- Consider an opt-in automatic mirror only after the explicit path proves safe.

Exit criteria: only explicitly published assistant text appears on GitHub, it
also remains in the local transcript, and its resulting notification is not
ingested again.

### Phase 6: Webhooks and Broader Workflows

Only after the polling MVP is stable:

- signed GitHub webhooks or a GitHub App for lower latency and higher scale;
- review-request events as a distinct pull-request-review workflow;
- approved GitHub App actors;
- approved GitHub teams as a narrower scalable actor policy than trusting every
  member of an organization;
- repository-specific actor sets;
- explicit replay and cleanup commands;
- richer issue hierarchy, project, dependency, and milestone context;
- additional providers after extracting a proven common notification core.

## Testing Strategy

### Unit and integration tests

- strict manifest schema, kebab-case keys, normalization, and unknown-key
  rejection;
- global account and binding planning, conflict detection, ownership receipts,
  idempotent install/removal, and post-install route verification;
- token identity, agent assignee identity, repository permission, owner policy,
  and actor gates;
- issue versus pull request classification;
- account-wide search baseline, overlapping windows, truncation, pagination,
  event ordering, dedupe, and restart recovery;
- assignment, reassignment, unassignment, closure, merge, and self-event state
  transitions;
- private state permissions, atomic replacement, malformed state, and symlink
  rejection;
- bounded prompt construction and trusted/untrusted provenance separation;
- deterministic work ids without reimplementing worktree naming;
- partial failures around worktree and session creation;
- local-only channel delivery and outbound loop suppression;
- no token, issue body, comment body, or raw command in logs and diagnostics.

Fake GitHub, OpenClaw, Git, clock, filesystem, and transport boundaries in the
default Mocha suite. Do not rely on live network, timing, or the user's installed
Gateway.

### Installed behavior

Add an owning GitHub-notifications Leia scenario in the GitHub Actions matrix.
Use named approved, unapproved, and agent personas and a disposable fixture
repository. Prove:

- correct agent and workspace binding;
- manifest install creates only the non-secret channel account and exact
  account-scoped binding, and manifest removal removes only owned state;
- approved assignment creates one worktree and session;
- unauthorized assignment fails closed;
- a repository with insufficient agent permission or a disallowed owner creates
  neither a worktree nor a session;
- issue content cannot trigger a mutating automated turn;
- unassignment retires the route while preserving the worktree;
- restart does not duplicate the workflow;
- later comment and outbound phases preserve actor and loop gates.

Leia remains GitHub Actions-only. Update the matrix credential ownership rules
explicitly when this scenario is introduced rather than silently borrowing
credentials from another entry.

## Likely Repository Surfaces

- `index.ts`: retain the plugin entrypoint and register the static channel and
  full-runtime service through `lib/` orchestration.
- `utils/manifest-types.ts` and `utils/parse-agent-manifest.ts`: add the strict
  external and internal notification projection.
- `tools/github/`: own GitHub notification schema, typed provider access,
  assigned-item discovery, repository permission/owner admission, event
  normalization, and user documentation.
- `tools/git/`: expose the existing worktree service to trusted internal
  orchestration without duplicating it.
- `lib/`: own global channel/binding lifecycle reconciliation, polling,
  work-item orchestration, session routing, state coordination, and diagnostics.
- `test/`: add flat behavior-focused Mocha specs.
- `examples/`: add the installed assignment lifecycle only when implementation
  crosses the Gateway and session boundary.
- `openclaw.plugin.json`: declare the channel and its static cold-path schema
  when the Phase 0 contract is proven.
- `ADVANCED.md` and `tools/github/README.md`: document implemented manifest and
  GitHub behavior; keep `README.md` to a short common-path link.
- `CHANGELOG.md`: record only implemented phases, not this proposal.

Do not add a generic `src/` directory or load schemas, transports, or modules
from manifest values.

## Validation by Phase

For every implementation phase, run:

```text
bun run lint
bun run typecheck
bun run test
bun run build
bun run plugin:check
```

Also run `bun run test:release` when channel declarations, package contents,
compatibility metadata, or release wiring change. Run the installed Leia
scenario only in GitHub Actions.

## Primary References

- [OpenClaw channel plugin guide](https://docs.openclaw.ai/plugins/sdk-channel-plugins)
- [OpenClaw channel inbound API](https://docs.openclaw.ai/plugins/sdk-channel-inbound)
- [OpenClaw channel routing and bindings](https://docs.openclaw.ai/channels/channel-routing)
- [OpenClaw agent binding commands](https://docs.openclaw.ai/cli/agents)
- [OpenClaw configuration and hot reload](https://docs.openclaw.ai/gateway/configuration)
- [OpenClaw plugin entry points](https://docs.openclaw.ai/plugins/sdk-entrypoints)
- [OpenClaw plugin manifest](https://docs.openclaw.ai/plugins/manifest)
- [GitHub notification API limitations](https://docs.github.com/en/rest/activity/notifications)
- [GitHub issue and pull request search](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests)
- [GitHub repository permission lookup](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user)
- [GitHub issue event types](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types)
- [GitHub issue and pull request assignment behavior](https://docs.github.com/en/rest/issues/assignees)
- [GitHub pull request and issue linking](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)

## Decisions to Revisit After Phase 0

1. Whether current OpenClaw supports setting the native session label to the
   returned worktree branch without private APIs.
2. Whether current OpenClaw supports binding the session cwd to the worktree;
   otherwise Agent System tools must receive the stored worktree path explicitly.
3. Whether the pinned SDK's credentialless setup hook can create the
   activation-only channel account or whether install needs a hash-guarded
   `config.patch` for that exact account path.
4. Whether logical retirement is sufficient until OpenClaw exposes a supported
   plugin archive action.
5. Whether fixed `gh api` calls are efficient enough for the first monitor or a
   direct HTTP transport is justified immediately.

None of these questions should weaken the actor, repository-permission,
owner-policy, global-binding, agent-identity, credential-timing,
prompt-provenance, idempotency, or non-destructive cleanup boundaries above.
