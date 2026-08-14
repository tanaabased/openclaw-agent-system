# GitHub Notifications Plan

Status: Notifications MVP 1 is shipped. Notifications 2 Phase 0, Phase 1A, and
Phase 2 are implemented through the public channel SDK and covered by the packed
third-party notifications scenario. Phases 3 through 7 remain planned work, with
Phase 3 as the next implementation target.

This document is the durable product and architecture plan. Historical
implementation notes, transient test counts, and completed spike details are
intentionally omitted; Git history and the test suite own that evidence.

## MVP 1 Product Contract

MVP 1 supports one assignment-intake path:

1. A user adds `github.notifications` to an agent manifest with at least one
   immutable approved actor. The polling interval defaults to five minutes.
2. `openclaw agent-system install` reconciles one activation-only local channel
   account and one exact account-scoped binding for that agent, then establishes
   a baseline before installation succeeds. Zero assigned issues is a valid
   persisted baseline.
3. The Gateway starts one poll scheduler owned by that channel account and
   exposes its running, connected, and health state through channel status.
4. A later cycle discovers a new issue assignment to the authenticated agent.
5. Intake is admitted only when the assignment actor is approved, the canonical
   repository is eligible, and the agent has effective write permission.
6. One admitted issue creates or reuses exactly one managed worktree and one
   issue-scoped local OpenClaw session.
7. OpenClaw's channel inbound lifecycle records the issue-scoped session in
   observe-only mode without starting an agent turn.
8. The background scheduler and `notifications refresh` command share the same
   deterministic, model-free provider, baseline, state, admission, delivery,
   and cross-process lock path.

MVP 1 ends with a durable issue, repository, worktree, and session correlation.
It does not autonomously edit code, write to GitHub, open a pull request, ingest
comments, retire sessions, or clean up worktrees.

### Completed Repository Work

- strict manifest parsing and schema validation;
- local-only `agent-system-github` channel registration;
- manifest-to-global account and binding reconciliation owned by `install`;
- receipt-backed ownership, drift inspection, repair, and cleanup;
- per-channel-account polling, jitter, provider backoff, cancellation, and
  runtime health status;
- account identity verification and safe install-time baseline, including an
  empty first observation;
- bounded GitHub assignment discovery and canonical item/event lookup;
- immutable actor, repository owner, agent permission, and assignment admission;
- private value-free monitor and routing state;
- deterministic managed-worktree preparation through the Git capability;
- deterministic issue conversation routing through OpenClaw's public channel
  inbound lifecycle;
- value-free delivery checkpoints and observe-only session recording;
- one-shot manual refresh through the background monitor path;
- host-owned cross-process file locking with a notification-specific bounded
  wait and busy result; and
- deterministic unit, build, plugin, and package validation.

### Completed MVP 1 Acceptance Proof

The GitHub Actions-only notifications scenario proves a packed third-party
installation across the actual CLI, Gateway, channel, session, and worktree
boundaries. It covers:

- safe empty first-use baseline completed by `install`;
- approved issue assignment;
- rejected unauthorized assignment;
- exactly one managed worktree and local session;
- manual refresh without waiting for the interval;
- no GitHub write; and
- clean installation from the produced package rather than source-only imports.

Leia scenarios remain CI-only and must not run against a developer's normal
OpenClaw state.

## Current Notifications 2 Implementation

The current implementation contains tested behavior deliberately outside the
MVP 1 product promise:

- issue-shaped pull-request discovery and classification;
- canonical unassignment and authority-revocation transitions;
- logical retirement that preserves sessions and worktrees;
- reassignment and multi-stage delivery state;
- optional immutable repository-owner restrictions;
- safely retryable deterministic session recording;
- asynchronous bounded issue-context planning with tools disabled;
- one model-authored, personality-aware acknowledgment candidate extracted from
  the private planning response;
- revision-aware comment baselines and immutable human mention admission for
  active canonical issue conversations;
- tool-free comment turns in the existing private issue session, with bounded
  recorded status evidence and untrusted-content framing;
- fail-closed publication through the public channel message adapter and durable
  outbound lifecycle for initial acknowledgments and admitted-comment replies;
  and
- value-free activation, acknowledgment, comment-revision, turn, and
  provider-receipt checkpoints.

The packed notifications scenario covers the plan-only turn, one public
acknowledgment, approved and rejected comment mentions, one revision-bound public
reply, restart deduplication, and logical retirement. Locally initiated progress,
pull-request conversations, operator replay, cleanup, and automatic-work behavior
remain unavailable until their owning phases are implemented and accepted.

## Configuration Contract

Notifications remain under `github` because they share the GitHub identity,
host, and credential contract. A provider-neutral notification abstraction is
not justified until a second provider proves the same lifecycle.

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

Rules:

- `github.notifications` enables intake for that agent.
- `interval-minutes` defaults to `5` and accepts `1` through `1440`.
- At least one `approved-actors` entry is required.
- Immutable GitHub node ids authorize actors and owners; logins are required
  only for review and drift diagnostics.
- The verified agent needs effective `write`, `maintain`, or `admin` access to
  the canonical repository.
- `allowed-repository-owners` is optional and only narrows eligible repository
  ownership. It does not authorize organization members to instruct the agent.
- Organization membership is not an authorization shortcut.
- Provider responses, never event text or model output, supply canonical
  repository identity, clone URL, default branch, item state, and actor ids.
- GitHub App and bot actors are denied for MVP 1.
- The manifest stores credential names, never credential values.

The approved actor and effective repository permission checks are notification
admission invariants, not GitHub tool policy. Future GitHub mutations must use
the owning GitHub capability and its narrow effect-specific policy.

## Manifest-to-OpenClaw Reconciliation

`agent.yaml` remains workspace-owned desired state. OpenClaw routes inbound
messages through global channel accounts and bindings, so `install` projects
only the non-secret routing state the channel needs:

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

Ownership rules:

- `install` is the only reconciler of owned global state.
- Passive hooks may inspect and cache non-secret metadata but do not mutate
  configuration or resolve credentials.
- An exact channel, account, agent, and workspace route is required.
- Missing, default, duplicate, cross-agent, or partially unowned routing fails
  closed.
- A private receipt proves what Agent System may repair or remove.
- Unrelated accounts and bindings are preserved.
- Configuration reload planning remains host-owned.

## Polling and Admission

The product is called notifications, but GitHub's Notifications REST endpoint is
not the authoritative stream. Its reasons are sticky and its token support does
not fit the credential contract. The monitor instead uses authenticated
account-wide assigned-item discovery, then targeted canonical reads.

Each cycle:

1. verifies the token identity against the configured agent;
2. lists bounded pages of currently assigned, updated work;
3. establishes or advances a safe overlap-window baseline;
4. loads the canonical repository, owner, issue, permission, and assignment
   event for each candidate;
5. admits only canonical control facts and does not fetch issue prose;
6. suppresses self-events, duplicates, and assignments older than the baseline;
7. prepares the worktree and routed conversation for an admitted issue; and
8. persists only value-free control and correlation state.

The first successful cycle never starts historical work. Changing the verified
GitHub identity creates a fresh baseline.

## Trust Boundary

Trusted control facts are limited to:

- installed manifest and exact OpenClaw route;
- verified GitHub account identity;
- immutable actor and repository-owner ids;
- canonical repository permission and issue state;
- canonical assignment events;
- deterministic repository, worktree, conversation, and delivery ids; and
- private monitor state.

Titles, bodies, labels, milestone text, URLs, comments, and provider error bodies
are untrusted project data. They cannot choose an agent, credential, repository,
clone URL, base ref, local path, executable, tool, or policy outcome.

MVP 1 does not fetch issue prose or start an automated turn. GitHub content is
not stored in private control state or routine logs. Any future work-start
context must remain downstream of admission, bounded, explicitly framed as
untrusted project data, and independent from deterministic intake completion.

## Worktree and Session Delivery

The monitor composes existing owners rather than creating privileged parallel
APIs:

1. the GitHub provider adapter returns typed canonical metadata;
2. the Git worktree capability prepares or adopts the deterministic managed
   repository and worktree;
3. the GitHub channel builds the inbound route and context; and
4. OpenClaw's `runChannelInboundEvent` records or lazily creates the local
   session under an observe-only admission without dispatching an agent turn.

The conversation id is deterministic:

```text
github:<repository-node-id>:<issue-number>
```

The MVP 1 channel registers no outbound adapter. Notifications 2 Phase 0 replaces
that limitation through OpenClaw's public message-adapter and durable-delivery
contracts. Agent System does not call protected Gateway RPCs, edit OpenClaw
session storage, patch session extensions, or spawn Gateway CLI commands to
simulate a public SDK.

Ordinary routed sessions cannot use subagent-only cwd fields. The managed
worktree path stays in private monitor correlation and bounded inbound context;
later Agent System tools receive it explicitly under their normal authorization
and credential boundaries.

## State and Failure Semantics

Private state contains assignment ids, canonical repository/item ids, baseline
cursors, delivery checkpoints, worktree/session correlation, retry timing, and
stable diagnostic codes. It does not contain credentials or GitHub prose.

Acknowledgment state is explicit and value-free: `pending` while activation or
publication is in progress, `published` only with a confirmed provider comment
receipt, and `failed` with a stable diagnostic code after a terminal publication
outcome. Doctor reports pending and failed acknowledgments independently from
monitor read health; a healthy poll does not hide an incomplete publication.

Delivery is deterministic and idempotent from Agent System's perspective:

- checkpoint before worktree preparation;
- record the deterministic worktree result;
- checkpoint `session-recording` before the public inbound lifecycle; and
- record completion only after the host records the deterministic session.

Session recording may be retried after interruption because the route and
session key are deterministic and the host record uses `createIfMissing: true`.
No model turn or transcript entry exists to duplicate.

Logical retirement, native archival, reassignment recovery, and explicit state
or worktree cleanup are Notifications 2 contracts. No revocation path deletes a
transcript or dirty worktree automatically.

## Manual Refresh

```text
openclaw agent-system notifications refresh [--agent <id>] [--json]
```

The command runs one normal monitor cycle. It does not enable the scheduler and
is not a read-only fetch: an admitted assignment may create its worktree and
local session.

- Without `--agent`, resolve the manifest from the current workspace.
- With `--agent`, resolve that installed agent through the normal binding.
- Require existing notification configuration and exact installed routing.
- Bypass only the interval deadline; preserve backoff, admission, baseline,
  state, and delivery rules.
- Wait up to two minutes for another process's cycle lock, then return a stable
  busy result rather than overlap it.
- Use OpenClaw's supported file-lock primitive for owner identity, process-exit
  cleanup, stale recovery, and race-safe release.
- Keep human output concise and JSON value-free and machine-readable.
- Return nonzero for busy, deferred, configuration, authentication, provider,
  state, or delivery failure.

## Notifications 2 Plan

Notifications 2 owns everything after initial issue intake.

| Priority | User outcome                                                       | Impact    | Relative effort |
| -------- | ------------------------------------------------------------------ | --------- | --------------- |
| 0        | Every GitHub write uses one safe channel delivery path             | very high | medium          |
| 1        | The agent understands the issue, proposes a plan, and acknowledges | very high | high            |
| 2        | Approved GitHub mentions receive local and GitHub responses        | very high | high            |
| 3        | Operators can deliberately publish progress from local chat        | high      | medium          |
| 4        | Assignment and pull-request lifecycle stays correlated             | medium    | medium          |
| 5        | Operators can inspect, replay, and clean up state                  | medium    | medium          |
| 6        | Operators can opt into automatic work after planning               | high      | medium          |
| 7        | The agent can safely choose whether to wait or continue            | medium    | high            |

### Message Flow

OpenClaw and GitHub intentionally receive different outputs from one agent turn:

1. an admitted GitHub event resolves the deterministic issue conversation;
2. OpenClaw records the full agent response in the private local session;
3. bounded model generation produces a separately labeled, concise,
   conversational, personality-aware GitHub candidate without exposing the
   complete transcript;
4. the initial planning turn emits its acknowledgment candidate alongside the
   private assessment, blockers, and plan; admitted comment turns use their own
   bounded GitHub-reply composer, while operator progress remains unavailable
   until Phase 3;
5. a deterministic fail-closed gate rejects unsafe or unsupported candidates;
6. one GitHub message adapter reauthorizes and durably publishes the accepted
   candidate; and
7. Agent System persists only value-free checkpoints and delivery receipts.

Formatting, summarization, and personality belong to bounded model generation
before the final safety gate. The message adapter remains a deterministic
transport and authorization boundary so retries cannot regenerate different
content. Sanitization means rejecting a candidate that cannot be proven safe,
not attempting best-effort redaction.

Publication eligibility is origin-aware:

- the first successful assignment activation may produce one initial
  acknowledgment;
- an admitted GitHub mention may produce one GitHub reply;
- an ordinary OpenClaw chat message remains local; and
- a local progress update becomes eligible only through an explicit operator
  publication action, never through an autonomous model decision.

### Phase 0: GitHub Outbound Foundation

- Register one `message` adapter through `defineChannelMessageAdapter(...)` from
  `openclaw/plugin-sdk/channel-outbound`.
- Route inbound final-reply delivery through
  `deliverInboundReplyWithMessageSendContext(...)` and use OpenClaw's durable
  outbound helpers for queueing, retries, hooks, and normalized receipts.
- Model one Agent System publication target vocabulary for the explicit
  `initial-acknowledgment`, `github-reply`, and `operator-progress` intents.
  Enable `initial-acknowledgment` and `github-reply` through their implemented
  phases, and keep `operator-progress` inactive until Phase 3.
- Resolve the channel account and conversation target to one admitted canonical
  issue before any credential resolution or provider mutation.
- Reauthorize the current assignment or admitted comment, verified GitHub
  identity, repository permission, and applicable narrow GitHub policy
  immediately before every write.
- Apply intent-specific shape rules plus a common secret-safety gate. Reject
  links, mentions, local paths, credentials, token-shaped values, tool traces,
  hidden context, unsupported media, or other disallowed content according to
  the intent contract.
- Reconcile deterministic provider markers and OpenClaw message receipts so
  retries, restarts, and ambiguous delivery cannot create duplicate comments.
- Let OpenClaw's durable send own each publication attempt, provider retries,
  normalized receipts, and unknown-send reconciliation. Agent System owns only
  the resulting confirmed-comment or stable-failure checkpoint and does not add
  a parallel automatic retry transport.
- Keep credentials, GitHub prose, local paths, and generated payloads out of
  private control state and routine diagnostics.
- Replace the current context-free acknowledgment capture and direct GitHub
  publication path. Caller-owned delivery may observe local turn completion but
  must not remain a parallel external transport.
- Preserve value-free progress diagnostics around scheduling, generation,
  adapter delivery, and receipt commitment.

### Phase 1A: Plan Assigned Work and Acknowledge Understanding

- Keep polling, admission, worktree preparation, and session recording model-free.
- After deterministic intake reaches its active checkpoint, claim a durable
  activation checkpoint and dispatch one asynchronous planning turn through
  OpenClaw's public channel inbound lifecycle. Never make polling or manual
  refresh wait for model completion.
- After activation is claimed, fetch a bounded canonical projection of the issue
  title, body, labels, and existing comments. Frame all prose as untrusted project
  data; comments provide context but do not authorize instructions or replace the
  approved-mention rules in Phase 2.
- Deliver the bounded context and managed-worktree identity to the existing
  issue-scoped session. The first planning turn runs with tools disabled and
  produces a concise assessment, blockers, and proposed implementation plan from
  issue context without inspecting or mutating the repository.
- Record the complete planning response only in the private OpenClaw session.
  In plan-only behavior, stop there and wait for a subsequent operator-authored
  local message in that same session. A GitHub comment never approves work, and
  this pause is not represented as an OpenClaw command-confirmation request.
- After the planning turn is adopted and completes, create one
  `initial-acknowledgment` publication intent from its bounded final response.
  The GitHub candidate must accurately communicate whether the agent reviewed
  the issue and prepared a plan, found a blocker, or is beginning work. Once the
  issue has been processed and planning has begun, conversational wording such
  as "I've started working" is accurate; plan-only behavior must not claim that
  repository inspection, code changes, or other implementation steps occurred.
- Compose and publish the acknowledgment asynchronously through Phase 0's single
  outbound path. A delayed or failed acknowledgment must not block the local
  planning or implementation lifecycle. Persist a confirmed provider receipt or
  a stable terminal failure, surface pending and failed outcomes through doctor
  and logs, and leave explicit replay to Phase 5.
- Make activation retryable and cancellable, and distinguish a turn the host has
  adopted from one that failed before adoption so ambiguous delivery cannot start
  duplicate planning turns.
- Persist only value-free activation checkpoints and stable authorization,
  context-fetch, dispatch, cancellation, and ambiguous-delivery diagnostics.
- Remove the unused `baselineItemNodeIds` inventory as a state-contract update;
  schema 2 is an intentionally unsupported legacy shape because the only known
  installation was manually upgraded. Do not add migration or retroactive
  activation unless the support policy changes. `baselineAt` remains the
  historical admission boundary.
- Do not call protected Gateway session APIs or write directly to session storage.

Phase 1A shipped as plan-only activation without a manifest setting because it
has only one supported choice. Its GitHub-facing publication boundary ends at
the initial acknowledgment; Phase 2 owns approved-comment replies.

### Phase 2: Approved GitHub Mention Conversations

- Poll only active canonical issue conversations.
- Establish a safe comment baseline when conversation tracking begins.
- Admit only canonical human comments from approved immutable actor ids.
- Require an exact standalone mention of the verified GitHub account login in
  current author-written prose, such as `@emoriwan`, never a literal `@agent`.
- Treat mentions as addressing, never authorization.
- Deduplicate create, edit, retry, self, quote-only, and stale-revision events.
- Dispatch admitted comments asynchronously to the existing local conversation
  with bounded provenance and untrusted-content framing.
- Let status questions use only bounded evidence already recorded in the issue
  session and Agent System-owned checkpoints. Do not let an admitted GitHub
  comment trigger tools or fresh repository inspection, and do not claim a
  current repository, test, or pull-request status without recorded evidence.
- When recorded evidence is insufficient, say that no verified current update
  is available from the notification turn and retain the status request for a
  locally authorized continuation.
- Keep the full response in the private OpenClaw session, then create one
  `github-reply` intent from the bounded final response because the admitted
  GitHub origin supplies explicit reply intent.
- Produce and publish the concise GitHub-facing response through Phase 0's
  composer, safety gate, message adapter, and durable receipt path. Never mirror,
  redact, or expose the local transcript.
- Do not publish responses to rejected, stale, self-authored, quote-only, or
  unmentioned comments.

### Phase 3: Explicit Local Progress Publication

- Add an explicit operator action that selects a bounded local progress update
  for GitHub publication.
- Let the operator satisfy a retained status request through a normal locally
  authorized, tool-enabled turn before selecting its bounded result for
  publication. The GitHub request itself never authorizes that inspection.
- Create one `operator-progress` intent and use the same composer, authorization,
  safety, adapter, marker, and receipt pipeline as every other GitHub message.
- Keep ordinary OpenClaw chat turns local by default. Do not let a model rubric
  independently decide that local content should leave the private session.
- Never publish tool traces, hidden context, local paths, failed attempts,
  arbitrary local turns, or content that cannot be proven secret-safe.

### Phase 4: Assignment and Pull-request Lifecycle

- Add installed proof for directly assigned pull requests and their distinct
  lifecycle semantics.
- Correlate an agent-created pull request to its existing issue conversation.
- Extend approved-comment intake to correlated pull requests.
- Use `Closes #<issue-number>` only when merge should close the issue.
- Request review from the original assigner when provider authorization permits.
- Complete restart and ambiguous-delivery reconciliation for lifecycle changes.
- Preserve sessions and worktrees on unassignment or authority revocation.
- Use native archival only if OpenClaw exposes a public scoped API; otherwise
  keep retirement logical.

### Phase 5: Operations and Cleanup

- Add status and replay controls with stable value-free diagnostics.
- Add explicit, non-destructive cleanup through the owning session and Git
  capabilities.
- Define retention for retired routing state and delivery receipts.

### Phase 6: Configured Work Continuation (Formerly Phase 1B)

- Add optional `activation-mode` with `plan` and `work` values and a default of
  `plan`.
- Make both modes complete and checkpoint the same tool-free planning turn.
- Keep `plan` waiting for a local operator response. Let `work` dispatch a
  separately checkpointed implementation turn to the same session only after
  planning completes.
- Give the implementation turn the normal Agent System tool surface under the
  existing binding, containment, credential, and tool-policy boundaries.
- Do not reinterpret or silently continue an existing assignment when
  configuration changes after its planning checkpoint.

### Phase 7: Automatic Activation Selection (Formerly Phase 1C)

- Add `auto` only after both explicit activation modes have installed acceptance
  coverage.
- Require the planning turn to return a bounded structured continue-or-wait
  decision under an explicit rubric.
- Resolve ambiguity, missing acceptance criteria, broad or destructive changes,
  security-sensitive work, migrations, releases, and other high-consequence
  work to `plan`. Continue automatically only for clearly actionable bounded
  work.
- Keep planning completion and implementation adoption as separate durable
  checkpoints.

## Validation

For implementation changes run:

```text
bun run lint
bun run typecheck
bun run test
bun run build
bun run plugin:check
```

Also run `bun run test:release` when package contents, compatibility metadata,
channel declarations, or release wiring change. Fake GitHub, OpenClaw, Git,
clock, filesystem, and transport boundaries in the default Mocha suite.

Every optimization pass must inventory OpenClaw imports and injected runtime
calls against the pinned SDK. Prefer public `openclaw/plugin-sdk/*` surfaces and
host-owned lifecycle primitives. Do not call `runtime.gateway.request` or the
bundled- or trusted-official-only `runtime.state` store and ingress-queue
constructors from this third-party plugin, or import private OpenClaw
implementation modules.
`test/openclaw-api-policy.spec.ts` enforces those prohibited paths.

## Primary References

- [OpenClaw channel plugin guide](https://docs.openclaw.ai/plugins/sdk-channel-plugins)
- [OpenClaw channel inbound API](https://docs.openclaw.ai/plugins/sdk-channel-inbound)
- [OpenClaw channel outbound API](https://docs.openclaw.ai/plugins/sdk-channel-outbound)
- [OpenClaw channel routing and bindings](https://docs.openclaw.ai/channels/channel-routing)
- [OpenClaw agent binding commands](https://docs.openclaw.ai/cli/agents)
- [OpenClaw configuration and hot reload](https://docs.openclaw.ai/gateway/configuration)
- [OpenClaw plugin entry points](https://docs.openclaw.ai/plugins/sdk-entrypoints)
- [OpenClaw plugin manifest](https://docs.openclaw.ai/plugins/manifest)
- [GitHub Notifications REST limitations](https://docs.github.com/en/rest/activity/notifications)
- [GitHub repository permission lookup](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user)
- [GitHub issue event types](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types)
- [GitHub assignment behavior](https://docs.github.com/en/rest/issues/assignees)
- [GitHub pull request and issue linking](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)

## Resolved Decisions

1. Use account-wide assignment discovery plus canonical targeted reads, not the
   GitHub Notifications REST endpoint.
2. Keep configuration under `github.notifications` until another provider proves
   a reusable abstraction.
3. Authorize new intake with an approved immutable assignment actor plus the
   agent's effective repository write permission.
4. Let `install` project and own the minimal global channel account and exact
   binding; passive hooks never reconcile it.
5. Let OpenClaw's public channel inbound lifecycle own session recording and
   lazy creation.
6. Let the Git capability own managed-worktree preparation.
7. Preserve transcripts and worktrees by default; later cleanup is explicit.
8. Keep MVP 1 notification refresh and session creation deterministic and model-free.
9. Keep polling through fixed, bounded `gh api` calls. Webhook ingestion is not
   supported.
10. Use one public-SDK message adapter and one fail-closed publication entry
    point for every GitHub write; do not retain acknowledgment-specific external
    transport.
11. Keep full agent responses in the private OpenClaw session and generate each
    GitHub comment as a separate bounded publication payload rather than copying
    or redacting the transcript.
12. Complete the first issue-context assessment before producing the initial
    acknowledgment, while keeping deterministic intake and work activation
    independent from GitHub publication success.
13. Let an admitted GitHub origin authorize one corresponding reply candidate.
    Keep ordinary local chat private unless an operator explicitly selects a
    progress update for publication.
14. Apply conversational formatting and personality before the deterministic
    final safety gate; the adapter must not invoke a model or regenerate content
    during retries.
15. Make assignment activation plan-first. The initial planning turn is
    tool-free; `work` is a separately checkpointed implementation turn, and
    `auto` is added only after an explicit bounded decision contract exists.
16. Treat a later operator-authored message in the private issue session as the
    continuation mechanism for plan-only work. Do not model that pause as a
    command confirmation or let a GitHub comment authorize implementation.
17. Let the planning model write the initial acknowledgment in its own voice as
    a separately labeled candidate. Treat planning as work from the user's
    perspective, while reserving claims about repository inspection, code
    changes, or implementation completion for phases that actually perform them.
18. Let OpenClaw own durable send attempts, provider retries, normalized receipts,
    and unknown-send reconciliation. Agent System records only the confirmed
    comment receipt or stable failed outcome and exposes incomplete publication
    separately from monitor health.
19. Keep monitor-state schema 2 unsupported. The only known installation was
    manually upgraded, so future optimization passes must not add a migration or
    retroactive activation without a changed support policy.
20. Keep admitted GitHub comment turns tool-free. Status replies may use only
    evidence already recorded in the issue session and Agent System-owned
    checkpoints; fresh inspection and progress publication require a locally
    authorized operator turn.
21. Establish the comment baseline during deterministic issue admission so a
    comment posted immediately after assignment cannot fall into a later baseline.
    After that baseline, poll comments only for active canonical issue
    conversations.

Future work must not weaken actor identity, repository permission, owner
restriction, exact routing, agent identity, lazy credential resolution,
untrusted-content framing, idempotency, or non-destructive cleanup boundaries.
