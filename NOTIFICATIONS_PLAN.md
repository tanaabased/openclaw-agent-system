# GitHub Notifications Plan

Status: Phases 0 and 1 and Phase 2A through 2E repository behavior implemented;
Phase 2 installed assignment proof and Phases 3 through 6 remain

Phases 0 and 1 now ship the strict manifest schema, static local-only channel,
account-scoped routing projection, private ownership receipt, lifecycle
inspection/reconciliation, typed GitHub monitor, trust admission, private durable
state, recoverable assignment delivery, trusted managed-worktree preparation,
and a bounded local-only briefing session with deterministic unit coverage.

This document plans an Agent System-owned GitHub work-notification channel. The
Phase 0 routing foundation, Phase 1 read-only discovery, and Phase 2A through 2E
assignment delivery and retirement described below are implemented; installed
assignment proof, work execution, and the approved-mention conversation bridge
remain planned behavior.

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

The channel should form a selective conversational bridge, not mirror two
transcripts. Only a canonical comment from an approved immutable actor that
directly mentions the verified agent is eligible to create an inbound turn.
For a turn that originated from such a comment, the agent produces a separate,
bounded GitHub-facing response draft derived from the local response. That
response passes normal GitHub write policy and approval before publication.
Local-only turns remain local unless an operator explicitly publishes an
update. Tool traces, hidden context, local paths, failed attempts, and the full
OpenClaw transcript are never synchronization inputs.

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
- Treat a direct agent mention as an addressing signal, not authorization. The
  provider-returned comment author node id must still match an approved actor,
  the comment must belong to the canonical active work item or its linked pull
  request, and the current comment revision must contain an exact standalone
  mention of the verified agent login.
- Do not call the conversational bridge comment synchronization. An admitted
  GitHub comment creates one local turn, and that turn may produce one distinct
  GitHub-facing response. The published response is intentionally less detailed
  than the local transcript and must be rendered from an explicit bounded
  publishable payload rather than by copying or redacting the transcript.

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

## Feature-complete Outcome

For this plan, feature complete means the GitHub notifications channel supports
the full assignment-driven conversation lifecycle on `github.com`, not every
event or integration GitHub can provide. After Phases 0 through 6, it will:

- discover and safely admit approved assignments;
- prepare or reuse one deterministic managed worktree and OpenClaw session;
- keep the issue, linked pull request, worktree, and session correlated through
  completion and retirement;
- accept new or materially edited issue, pull-request conversation, and linked
  review comments only when the canonical human author is approved and the
  current comment revision contains an exact standalone
  `@<verified-github-login>` mention in author-written prose;
- route each admitted comment to the existing local session with immutable
  provenance and bounded untrusted content;
- produce at most one bounded, conversational GitHub-facing response for that
  GitHub-originated turn, subject to mandatory secret-safety checks, normal
  write policy, and approval;
- support an explicit publish action for selected local updates without making
  the whole local transcript remotely visible;
- suppress self-events and duplicate delivery across retries, edits, restarts,
  and ambiguous provider-write outcomes;
- expose sufficient status, replay, retirement, and explicit cleanup controls
  to operate and recover the channel safely; and
- prove the complete lifecycle in deterministic tests and the installed
  GitHub Actions-only scenario.

Signed webhooks or GitHub App installation management, team or app actors,
review-request workflows, multiple GitHub hosts, repository-specific actor
sets, and additional notification providers are later expansions. Polling can
deliver the complete behavior above; webhooks improve latency and scale but do
not change its semantic contract.

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
- canonical comment node id, author node id, repository and item association,
  revision timestamp, and URL returned by GitHub
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

Comment admission additionally requires the current canonical comment body to
contain an exact standalone `@<verified-github-login>` mention in author-written
prose. The verified login comes from `github.username` after it matches the
authenticated `/user` response; `@agent` is not a literal product keyword.
The login comparison follows GitHub's case-insensitive username semantics while
still requiring one complete standalone mention token.
Mention detection is a routing condition over untrusted content, not an
authorization boundary. Mentions inside quoted text, code blocks, inline code,
or hidden markup do not address the agent.

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

### Comment Admission

A comment creates an agent turn only when all of these are true:

1. the work item is active and already has the exact routed session;
2. the comment belongs to the canonical issue, pull-request conversation, or a
   pull request already correlated to that work item;
3. GitHub's canonical response identifies a human author whose opaque node id
   matches `approved-actors` and is not the authenticated agent;
4. the current canonical body contains an exact standalone mention of
   `@<verified-github-login>` in author-written prose;
5. the comment node id and current revision have not already been delivered;
6. the comment is not an outbound comment previously written by Agent System;
   and
7. the item has not been retired, closed, transferred, or otherwise lost its
   admission authority.

An edit is eligible for one new turn only when its canonical revision changes
materially and the current body still satisfies the mention rule. Adding the
mention may make a previously ignored comment eligible; removing it before
delivery makes the comment ineligible. Deletion never creates an instruction.
Pull-request review requests and reviews without an addressed comment remain a
separate future workflow.

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
- processed comment node ids and revision timestamps
- active and retired work-item records
- assigner, assignee, worktree, branch, session, and linked pull request ids
- outbound comment node ids and locally generated operation ids used only for
  retry reconciliation and loop suppression
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

After the initial briefing, an admitted GitHub comment creates one turn in that
same session. Its prompt contains immutable provenance, the exact source URL,
and a bounded untrusted-content block. The local response may be as detailed as
normal work requires. For a GitHub-originated turn, the workflow separately
constructs a bounded GitHub-facing response containing only an appropriate
conversational update, decision, question, or next step. It must not derive that
response from tool traces or the wider transcript, and redaction alone is not a
sufficient publication boundary.

The GitHub-facing response is published only after normal tool policy and any
required approval. If publication is denied or fails, the local response and a
recoverable unpublished status remain in the session. A local operator turn is
never published automatically; it requires the explicit publish action. Every
successful write records the exact published text and provider comment id in
the local session and records the provider id in private state for loop
suppression.

### GitHub-facing Secret Safety

A GitHub-facing response must never contain a secret or secret-bearing private
information. This is a fail-closed publication invariant, not a best-effort
prompt instruction.

- Construct the remote response from a separate, bounded publishable payload
  with explicit fields. Never pass the full transcript, tool trace, environment,
  command output, or arbitrary local files into a sanitizer for publication.
- Exclude content with secret provenance, including resolved environment values,
  access tokens, authorization headers, private or signing keys, credential
  references paired with values, signed URLs, cookies, and tool output marked
  sensitive.
- Run deterministic secret detection and sanitization before showing the exact
  preview for policy or approval. Cover common token, key, credential, and
  high-entropy secret forms, and replace detected material with a stable safe
  placeholder.
- Resolve the GitHub credential only after policy and approval. Immediately
  before the provider write, check the exact UTF-8 bytes again, including against
  sensitive values already held by that explicit consumer. Never resolve
  unrelated secrets merely to expand the scan.
- If the final check detects secret material, sensitive provenance is unclear,
  the content changed after approval, or the sanitizer cannot complete, abort
  publication. Regenerate and preview a safe response rather than silently
  sending altered text.
- Never log, diagnose, persist in monitor state, or include in approval metadata
  the detected secret, its source value, or the rejected unsanitized payload.

Tests use synthetic canary secrets to prove that known token and key forms,
values already held by the writer, and secret-derived content cannot reach the
provider adapter, logs, diagnostics, approval records, or durable control state.

The pinned SDK exposes channel inbound routing, long-lived plugin services, and
trusted Gateway methods for creating and patching sessions, including label,
plugin metadata, abort, and archive fields. Its `spawnedCwd` and
`spawnedWorkspaceDir` patches are restricted to `subagent:*` and `acp:*`
lineage, so they cannot bind this ordinary routed channel session to a cwd. The
session adapter must use the supported fallback:

- project worktree and issue metadata through a plugin session extension and
  pass the projected path explicitly as cwd to later Agent System tool calls;
- a conversation label derived from the returned branch;
- explicit tool `cwd` values pointing at the managed worktree;
- logical retirement in Agent System state without deleting the OpenClaw
  transcript.

Do not schedule an immediate assignment through `scheduleSessionTurn` or bypass
the channel kernel with `sessions.send`. The accepted inbound event starts one
assembled channel turn directly so the runtime can enforce a per-turn no-tools
policy. Durable transition claims and reconciliation own duplicate prevention.

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

### Phase 1: Read-only Monitor and Trust Core (implemented; CI proof pending)

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

#### Phase 2A: Prove the Installed Session Contract (repository seams implemented; installed proof pending)

- Add a narrow session adapter around supported public OpenClaw surfaces rather
  than reading or rewriting session files directly.
- Prove that the channel kernel can create or adopt the exact deterministic
  routed session and that the trusted plugin Gateway runtime can set its label,
  patch a plugin-owned metadata namespace, abort an active briefing, and archive
  a retired session without deleting its transcript.
- Prove that the channel inbound kernel can record the GitHub provenance and
  start one immediate local turn with a stable provider event id. Do not use a
  scheduled turn for immediate assignment delivery.
- Prove that the local response is visible in the OpenClaw transcript while the
  channel still has no GitHub outbound adapter.
- Use plugin-owned worktree metadata plus explicit cwd on later Agent System
  tool calls because native cwd fields reject ordinary channel sessions. Use
  logical retirement if native archive is unavailable.

The pinned SDK currently exposes trusted `sessions.patch`,
`sessions.pluginPatch`, and `sessions.abort` Gateway methods plus the public
channel inbound runtime. The assembled inbound contract carries
`disableTools: true` and an empty per-turn `toolsAllow`, while the synthetic
channel has no outbound adapter and the session uses `sendPolicy: deny`.
`sessions.send` is not suitable for this automated briefing because it cannot
carry the required per-turn tool restriction. Treat the supported shapes as
evidence for the spike, not proof of installed behavior until the owning Leia
scenario exercises them.

#### Phase 2B: Expose Trusted Worktree Preparation (implemented)

- Factor one narrow internal worktree-preparation service out of the existing
  Git capability assembly and share the same `GitWorktreeService`, layout,
  runner, identity, SSH resource, and cleanup implementation as the native tool.
- Keep the service owned by `tools/git/`, and inject it into a root `lib/`
  assignment orchestrator because that workflow coordinates a channel and a
  tool capability.
- Do not invoke `agent_system_git_worktree`, synthesize a model tool call, shell
  through the CLI surface, or expose a generic policy bypass.
- Treat the admitted assignment as authority only for the ordinary
  `git.worktree.prepare` write operation. Apply Git authorization before
  resolving environment values or acquiring SSH material.
- Accept only the internally derived `github-<repository-database-id>`, a work
  id persisted on first admission, the provider-verified clone URL, and
  `origin/<default-branch>`. Never accept a model- or event-supplied local path,
  repository id, clone URL, or base ref.
- Return the existing service's canonical branch and path and dispose every
  invocation-scoped Git or SSH resource on success, failure, or cancellation.

#### Phase 2C: Add a Recoverable Assignment State Machine (implemented; production delivery disabled)

- Extend the private monitor state with a versioned, value-free delivery record
  containing the stable work id, assignment event id, workflow stage, worktree
  branch and path, routed session key and id when available, briefing
  idempotency key, and stable failure code. Do not persist GitHub bodies, prompts,
  transcript content, command output, environment values, or credentials.
- Migrate valid Phase 1 state explicitly or establish a diagnosed safe baseline;
  never reinterpret an older record silently.
- Have the pure poller return typed admitted and retirement transitions instead
  of only aggregate counts. Keep remote discovery and trust admission separate
  from side-effect execution.
- Serialize one work item transition at a time per agent and persist a checkpoint
  before and after every external side effect: admitted, worktree-ready,
  session-ready, briefing-running, active, and retired.
- On restart, reconcile the deterministic worktree, OpenClaw session, plugin
  metadata, and briefing idempotency key before deciding whether to resume.
  Never infer completion from a stale local stage alone.

#### Phase 2D: Deliver the Bounded Briefing (implemented; installed proof pending)

- After admission, fetch a separate bounded canonical briefing projection with
  the title, URL, body excerpt, labels, and milestone summary. Keep all textual
  GitHub content explicitly marked as untrusted and do not persist it in monitor
  state.
- Build the deterministic conversation id from the repository node id and item
  number, then create or adopt that exact routed session.
- Patch the session label and plugin-owned issue, repository, assignment,
  branch, and path metadata before dispatch. Include the canonical worktree path
  in the bounded briefing and pass it explicitly as cwd to later Agent System
  tools; do not attempt the host's subagent-only cwd fields.
- Claim the assignment event durably before running it through
  `runGitHubNotificationAssignment` as an assembled inbound turn. Carry the
  stable provider event id into the channel context and reconcile the claimed
  session on restart before any retry.
- Enforce a no-tools automated briefing turn at the runtime boundary with both
  `disableTools: true` and an empty per-turn `toolsAllow`. Do not rely on prompt
  wording or a session-level restriction that the host normalizes away.
- Keep session outbound delivery denied. The briefing response stays local and
  Phase 2 performs no GitHub mutation.
- Mark the item active only after the claimed turn is adopted and its session
  metadata is durable. A timeout or ambiguous response must reconcile the
  provider event id and session transcript before retrying, never create another
  briefing speculatively.

Implemented delivery reuses the Phase 2C orchestrator and optimized private
state codec. The monitor reconciles persisted nonterminal assignments before a
normal poll is due, while honoring failure backoff, and introduces no second
delivery queue or state store. The production adapter rechecks canonical GitHub
authority, uses only the trusted managed-worktree service, creates or adopts the
exact routed session through the trusted Gateway runtime, and sends one bounded
local-only no-tools briefing. The owning GitHub Actions-only installed proof
remains Phase 2F work.

#### Phase 2E: Retirement and Failure Recovery (implemented)

- Recheck assignment, repository, permission, and route authority immediately
  before each side effect, not only at the beginning of the polling cycle.
- If authority is revoked before worktree creation, retire without creating
  local work. If revoked later, cancel or abort the in-flight briefing, retire
  routing, and preserve the worktree and transcript.
- Archive the session only through the proven host seam; otherwise record
  logical retirement. Never delete the session or automatically remove the
  worktree.
- Recover deterministically from failures before worktree creation, after
  worktree creation, after session creation, during briefing adoption, and after
  briefing settlement. Reuse proven side effects and report stable value-free
  diagnostic codes.

#### Phase 2F: Proof and Documentation (partially implemented)

Unit coverage and documentation are implemented; installed assignment proof is
pending.

- Add focused unit tests for the trusted worktree adapter, transition planner,
  orchestrator, session adapter, bounded briefing builder, tool restriction,
  cancellation, migration, and every partial-failure restart boundary.
- Prove that rejected, duplicate, mismatched-route, disallowed-owner,
  insufficient-permission, and revoked assignments create neither a worktree nor
  a session.
- Extend the existing GitHub Actions-only notifications scenario to prove one
  approved assignment creates one managed worktree and one local transcript,
  restart creates no duplicate, unassignment retires without deletion, and no
  GitHub comment or other outbound write occurs.
- Update channel and Git worktree documentation only for behavior that is
  implemented, and record the delivered phase in the changelog at release time.

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

- Poll issue and pull-request conversation comments only for active configured
  work items, plus review comments on an already correlated pull request.
- Require an exact approved actor node id and reject bot/app actors by default.
- Require an exact standalone `@<verified-github-login>` mention in the current
  canonical comment body. The verified login is the configured
  `github.username` after `/user` identity verification; the rule never matches
  a literal generic `@agent` token. Ignore mentions found only in quoted text,
  code, or hidden markup. Do not make every collaborator comment an instruction.
- Deduplicate by comment node id and track edits as revisions rather than
  replaying the original instruction.
- Route the accepted comment to the existing issue session with structured
  provenance and bounded content.
- Ignore comments authored by the agent or previously written by Agent System.
- Continue to apply normal tool policy and remote token permissions.

Exit criteria: an approved comment that directly mentions the verified GitHub
user reaches exactly one active session; unapproved, unmentioned,
quoted-mention-only, edited-duplicate, retired-item, and self comments produce
no agent turn.

### Phase 5: Conversational Replies Back to GitHub

Goal: carry the useful part of the discussion back to GitHub without mirroring
the local conversation.

- For a turn created by an admitted GitHub comment, construct at most one
  separate GitHub-facing response from an explicit bounded publishable payload.
- Expose a scoped comment-write service to the trusted workflow orchestrator;
  do not shell through or impersonate the model-facing GitHub tool, and preserve
  the same policy, approval, and credential-timing boundaries.
- Keep the GitHub response conversational and useful, but omit private context,
  tool traces, local paths, hidden instructions, raw failures, credentials, and
  unrelated transcript history. Do not treat after-the-fact redaction of the
  full transcript as the security boundary.
- Pass the separately constructed response through the mandatory GitHub-facing
  secret-safety pipeline before preview and again on the exact bytes immediately
  before send. Any secret hit, uncertain provenance, or post-approval change
  blocks publication and exposes only a value-free local diagnostic.
- Add an explicit semantic publish action for operator-originated local updates;
  no other local turn is automatically eligible for publication.
- Show the exact bounded comment content and target before any required
  approval, apply normal GitHub write policy, and resolve credentials only
  after approval.
- Post a new issue or pull-request comment rather than mutating local history,
  store its node id, and render the exact published text and URL in the local
  session.
- Mark outbound comments for loop suppression using stored provider ids; a
  hidden operation marker may support ambiguous-write recovery but must never
  be the trust boundary or visible source of authority.
- When an outbound write has an ambiguous result, reconcile by the local
  operation id before retrying so recovery cannot post duplicates.

Exit criteria: each admitted GitHub comment can yield at most one policy-checked
GitHub-facing response; selected local updates require explicit publication;
the exact remote text remains visible locally; retries do not duplicate it; and
its resulting notification is never ingested as a new turn.

### Phase 6: Operational Completion and Recovery

Goal: close the operational gaps required for a feature-complete channel.

- Add value-free status and diagnostics for assignment, comment, session,
  worktree, outbound publication, retry, and retirement state.
- Add explicit bounded replay for missed assignments or comments without
  changing the safe first-run baseline.
- Add explicit, policy-checked cleanup for retired routing state and worktrees,
  refusing dirty worktrees by default; archive sessions through a supported
  seam when available and otherwise preserve their transcripts.
- Reconcile uncertain worktree, session, and outbound-comment side effects
  before retrying.
- Bound comment pagination and revision history, detect truncation, and recover
  without silently skipping addressed comments.
- Complete documentation, migration notes, and installed GitHub Actions-only
  coverage for the assignment, comment, reply, restart, retirement, replay, and
  cleanup lifecycle.

Exit criteria: an operator can diagnose, replay, retire, and explicitly clean
up the channel; crash recovery is idempotent across every side effect; and the
complete assignment-to-conversation lifecycle passes unit, package, and
installed-runtime validation.

Phases 0 through 6 are the feature-complete GitHub notifications channel.

## Post-feature Expansions

Consider only after the polling channel is stable:

- signed GitHub webhooks or a GitHub App for lower latency and higher scale;
- review-request events as a distinct pull-request-review workflow;
- approved GitHub App actors;
- approved GitHub teams as a narrower scalable actor policy than trusting every
  member of an organization;
- repository-specific actor sets;
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
- approved-author and exact verified-login mention admission for issue,
  pull-request conversation, and linked review comments;
- mentions in quotes, code, hidden markup, stale revisions, retired items, and
  self-authored comments produce no turn;
- bounded local-only briefing delivery, separate GitHub-facing response
  construction, explicit local-update publication, and outbound loop
  suppression;
- synthetic secret canaries and sensitive-provenance fixtures never reach the
  provider adapter, approval metadata, logs, diagnostics, or durable state;
- ambiguous comment-write recovery cannot create duplicate remote comments;
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
- an approved actor's direct mention of the verified GitHub user reaches the
  existing session exactly once, while all other comments are ignored;
- the resulting bounded GitHub-facing response passes policy and approval,
  appears exactly once on the canonical item, remains visible locally, and does
  not loop back into the session;
- replay and explicit cleanup preserve ownership and non-destructive defaults.

Leia remains GitHub Actions-only. Update the matrix credential ownership rules
explicitly when this scenario is introduced rather than silently borrowing
credentials from another entry.

## Likely Repository Surfaces

- `index.ts`: retain the plugin entrypoint and register the static channel and
  full-runtime service through `lib/` orchestration.
- `utils/manifest-types.ts` and `utils/parse-agent-manifest.ts`: add the strict
  external and internal notification projection.
- `channels/github/`: own the static channel schema and runtime, typed provider
  access, assigned-item and comment discovery, repository permission/owner and
  actor/mention admission, event normalization, provider write adapter, and
  channel documentation.
- `tools/git/`: expose the existing worktree service to trusted internal
  orchestration without duplicating it.
- `lib/`: own global channel/binding lifecycle reconciliation, polling,
  work-item orchestration, session routing, state coordination, and diagnostics.
- `test/`: add flat behavior-focused Mocha specs.
- `examples/`: add the installed assignment lifecycle only when implementation
  crosses the Gateway and session boundary.
- `openclaw.plugin.json`: declare the channel and its static cold-path schema
  when the Phase 0 contract is proven.
- `ADVANCED.md` and `channels/github/README.md`: document implemented manifest
  and GitHub behavior; keep `README.md` to a short common-path link.
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
