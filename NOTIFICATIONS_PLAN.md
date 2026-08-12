# GitHub Notifications Plan

Status: Notifications MVP 1 is the scope of `pirog-notifications`. Its repository
implementation is complete. The remaining release gate is the packed,
third-party installed proof in the GitHub Actions-only notifications scenario.
Notifications 2 belongs on the future `pirog-notifications-2` branch.

This document is the durable product and architecture plan. Historical
implementation notes, transient test counts, and completed spike details are
intentionally omitted; Git history and the test suite own that evidence.

## MVP 1 Product Contract

MVP 1 supports one assignment-intake path:

1. A user adds `github.notifications` to an agent manifest with at least one
   immutable approved actor. The polling interval defaults to five minutes.
2. `openclaw agent-system install` reconciles one activation-only local channel
   account and one exact account-scoped binding for that agent.
3. The Gateway starts the agent monitor. Its first successful cycle records the
   currently open assigned issues as a baseline without creating local work.
4. A later cycle discovers a new issue assignment to the authenticated agent.
5. Intake is admitted only when the assignment actor is approved, the canonical
   repository is eligible, and the agent has effective write permission.
6. One admitted issue creates or reuses exactly one managed worktree and one
   issue-scoped local OpenClaw session.
7. OpenClaw's channel inbound lifecycle records the bounded assignment briefing
   and starts one no-tools local turn.
8. The background scheduler and `notifications refresh` command share the same
   provider, baseline, state, admission, delivery, and cross-process lock path.

MVP 1 ends with a durable issue, repository, worktree, and session correlation.
It does not autonomously edit code, write to GitHub, open a pull request, ingest
comments, retire sessions, or clean up worktrees.

### Completed Repository Work

- strict manifest parsing and schema validation;
- local-only `agent-system-github` channel registration;
- manifest-to-global account and binding reconciliation owned by `install`;
- receipt-backed ownership, drift inspection, repair, and cleanup;
- per-agent polling, jitter, provider backoff, and cancellation;
- account identity verification and safe first-run baseline;
- bounded GitHub assignment discovery and canonical item/event lookup;
- immutable actor, repository owner, agent permission, and assignment admission;
- private value-free monitor and routing state;
- deterministic managed-worktree preparation through the Git capability;
- deterministic issue conversation routing through OpenClaw's public channel
  inbound lifecycle;
- value-free delivery checkpoints and bounded untrusted briefing projection;
- one-shot manual refresh through the background monitor path;
- host-owned cross-process file locking with a notification-specific bounded
  wait and busy result; and
- deterministic unit, build, plugin, and package validation.

### Remaining MVP 1 Gate

The GitHub Actions-only notifications scenario must prove a packed third-party
installation across the actual CLI, Gateway, channel, session, and worktree
boundaries. It must cover:

- safe first-use baseline;
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
- recovery diagnostics for ambiguous briefing delivery.

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
5. admits control facts before fetching bounded issue text;
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

Only after admission does the monitor fetch a separate bounded briefing
projection. The automated turn receives explicit untrusted-content framing,
`disableTools: true`, and an empty tool allowlist. GitHub content is not stored
in private control state or routine logs.

## Worktree and Session Delivery

The monitor composes existing owners rather than creating privileged parallel
APIs:

1. the GitHub provider adapter returns typed canonical metadata;
2. the Git worktree capability prepares or adopts the deterministic managed
   repository and worktree;
3. the GitHub channel builds the inbound route and context; and
4. OpenClaw's `runChannelInboundEvent` records or lazily creates the local
   session before dispatching the turn.

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

Delivery is at most once from Agent System's perspective:

- checkpoint before worktree preparation;
- record the deterministic worktree result;
- checkpoint `briefing-running` before channel dispatch; and
- record completion only after the inbound lifecycle returns successfully.

If briefing dispatch becomes ambiguous, MVP 1 does not retry automatically.
The public third-party API cannot safely inspect session history or active-run
state. The stable diagnostic requires operator inspection instead of risking a
duplicate turn.

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

### Phase 1: Assignment Lifecycle and Pull-request Correlation

- Promote pull-request assignments only after installed proof defines their
  distinct semantics.
- Correlate an agent-created pull request to the existing issue work item.
- Use `Closes #<issue-number>` only when merge should close the issue.
- Request review from the original assigner when provider authorization permits.
- Complete restart and ambiguous-delivery reconciliation.
- Define native archival if OpenClaw exposes a public scoped API; otherwise keep
  retirement logical.
- Preserve sessions and worktrees on unassignment or authority revocation.

### Phase 2: Approved GitHub Comments Inbound

- Poll only active canonical issues and correlated pull-request conversations.
- Admit only canonical human comments from approved immutable actor ids.
- Require an exact standalone mention of the verified agent login in current
  author-written prose.
- Treat mentions as addressing, never authorization.
- Deduplicate create, edit, retry, self, quote-only, and stale-revision events.
- Route admitted comments to the existing local conversation with bounded
  provenance and untrusted-content framing.

### Phase 3: Bounded Replies to GitHub

- Produce a separate GitHub-facing response from an explicitly publishable
  payload, never by mirroring or redacting the local transcript.
- Publish at most once through the owning GitHub capability.
- Apply provider permission, applicable narrow tool policy, and a mandatory
  secret-safety gate before every write.
- Never publish tool traces, hidden context, local paths, failed attempts, or
  arbitrary local turns.
- Add an explicit operator action for selected local progress updates.

### Phase 4: Operations and Cleanup

- Add status and replay controls with stable value-free diagnostics.
- Add explicit, non-destructive cleanup through the owning session and Git
  capabilities.
- Define retention for retired routing state and delivery receipts.
- Add webhooks only if measured latency or scale justifies them; preserve the
  polling semantic contract.

Later expansions may include review requests, teams, apps, multiple GitHub
hosts, repository-specific actor sets, and additional providers. They are not
part of Notifications 2 unless separately scoped.

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
8. Keep the first briefing local-only and tool-free.
9. Use fixed, bounded `gh api` calls until measured cost or scale justifies a
   direct transport.
10. Fail closed on ambiguous dispatch rather than retry without a public scoped
    session-inspection capability.

Future work must not weaken actor identity, repository permission, owner
restriction, exact routing, agent identity, lazy credential resolution,
untrusted-content framing, idempotency, or non-destructive cleanup boundaries.
