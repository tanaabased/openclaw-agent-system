# GitHub Notifications Plan

Status: Notifications MVP 1 is the scope of `pirog-notifications`. Its repository
implementation and packed third-party installed acceptance proof are complete in
the GitHub Actions-only notifications scenario. Notifications 2 belongs on the
`pirog-notifications-2` branch.

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

## Implemented Ahead of MVP 1

The branch contains tested implementation that is deliberately outside the MVP
1 product promise:

- issue-shaped pull-request discovery and classification;
- canonical unassignment and authority-revocation transitions;
- logical retirement that preserves sessions and worktrees;
- reassignment and multi-stage delivery state;
- optional immutable repository-owner restrictions; and
- safely retryable deterministic session recording.

Keep these paths unless they destabilize MVP 1, but describe them as
implemented ahead until Notifications 2 supplies installed acceptance coverage,
operator controls, and a complete lifecycle contract.

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
not stored in private control state or routine logs. Any future briefing must
remain downstream of admission, bounded, explicitly framed as untrusted project
data, and independent from deterministic intake completion.

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

The channel registers no outbound adapter. Agent System does not call protected
Gateway RPCs, edit OpenClaw session storage, patch session extensions, or spawn
Gateway CLI commands to simulate a public SDK.

Ordinary routed sessions cannot use subagent-only cwd fields. The managed
worktree path stays in private monitor correlation and bounded inbound context;
later Agent System tools receive it explicitly under their normal authorization
and credential boundaries.

## State and Failure Semantics

Private state contains assignment ids, canonical repository/item ids, baseline
cursors, delivery checkpoints, worktree/session correlation, retry timing, and
stable diagnostic codes. It does not contain credentials or GitHub prose.

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

| Priority | User outcome                                           | Impact    | Relative effort |
| -------- | ------------------------------------------------------ | --------- | --------------- |
| 0        | Accepted assignments receive a visible acknowledgment  | very high | medium          |
| 1        | Assigned work activates the agent with a safe briefing | very high | medium          |
| 2        | Approved GitHub mentions reach the local conversation  | high      | medium          |
| 3        | Safe conversational responses return to GitHub         | high      | high            |
| 4        | Assignment and pull-request lifecycle stays correlated | medium    | medium          |
| 5        | Operators can inspect, replay, and clean up state      | medium    | medium          |

### Phase 0: Acknowledge Accepted Assignments

- Post only after deterministic intake reaches its active checkpoint with the
  managed worktree prepared and the OpenClaw session recorded.
- Generate one short acknowledgment through the assigned agent's normal
  OpenClaw personality and prompt context. Give that turn no tools, issue prose,
  comments, local paths, or credential values; instruct it only to acknowledge
  that it accepted the assignment in its own voice.
- Treat the generated text as untrusted until a fail-closed publication gate
  accepts one bounded plain-text sentence with no links, mentions, markup,
  paths, token-shaped values, media, tool output, or unsupported claims. Do not
  publish a canned fallback when generation or validation fails.
- Publish through the owning GitHub capability only after provider permission
  and applicable narrow tool policy allow the write.
- Reconcile a deterministic hidden marker and persist a value-free receipt so
  retries, restarts, and ambiguous delivery cannot create duplicate comments.
- Keep local intake active when acknowledgment fails; record a stable diagnostic
  and retry the comment independently. Agent generation must not make polling or
  manual refresh wait for model completion.

### Phase 1: Activate Assigned Work

- Keep polling, admission, worktree preparation, and session recording model-free.
- After deterministic intake commits, claim a separate activation checkpoint
  and dispatch one asynchronous opening turn through OpenClaw's public channel
  inbound lifecycle. Never make refresh wait for model completion.
- Fetch only a bounded canonical issue projection after activation is claimed,
  frame it as untrusted project data, and include the managed worktree context.
- Keep the opening response local until the safe GitHub reply phase exists.
- Make activation retryable and cancellable with stable model-authorization and
  ambiguous-delivery diagnostics.
- Use this phase's monitor-state migration to remove the unused
  `baselineItemNodeIds` inventory while accepting valid MVP 1 state;
  `baselineAt` remains the historical admission boundary.
- Do not call protected Gateway session APIs or write directly to session storage.

### Phase 2: Approved GitHub Mentions Inbound

- Poll only active canonical issue conversations.
- Establish a safe comment baseline when conversation tracking begins.
- Admit only canonical human comments from approved immutable actor ids.
- Require an exact standalone mention of the verified GitHub account login in
  current author-written prose, such as `@emoriwan`, never a literal `@agent`.
- Treat mentions as addressing, never authorization.
- Deduplicate create, edit, retry, self, quote-only, and stale-revision events.
- Dispatch admitted comments asynchronously to the existing local conversation
  with bounded provenance and untrusted-content framing.
- Keep all responses local until Phase 3 publication is available.

### Phase 3: Safe Conversational GitHub Replies

- Produce each model-generated GitHub response as a separate concise,
  conversational, explicitly publishable payload, never by mirroring or
  redacting the local transcript.
- Publish only a response to an admitted GitHub comment or an explicit
  operator-selected progress update.
- Add the explicit operator action for selecting a local progress update.
- Publish at most once through the owning GitHub capability and persist a
  value-free delivery receipt.
- Apply provider permission, applicable narrow tool policy, and a mandatory
  secret-safety gate before every write.
- Fail closed when the payload cannot be proven secret-safe.
- Never publish tool traces, hidden context, local paths, failed attempts, or
  arbitrary local turns.

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
10. Acknowledge completed deterministic intake with one short, personality-aware,
    tool-free, secret-gated, exactly-once GitHub comment.
11. Keep acknowledgment generation separate from the later issue briefing and
    work-activation turn; neither path may delay deterministic intake.

Future work must not weaken actor identity, repository permission, owner
restriction, exact routing, agent identity, lazy credential resolution,
untrusted-content framing, idempotency, or non-destructive cleanup boundaries.
