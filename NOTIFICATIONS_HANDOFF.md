# GitHub Notifications Context Handoff

Updated: 2026-08-12

This is a temporary internal handoff for continuing the GitHub notifications
work on another machine. It is not package documentation and should not be
linked from `README.md`, `ADVANCED.md`, or a capability README. Remove it with
`NOTIFICATIONS_PLAN.md` when the notifications pull request is complete.

## Repository State

- Repository: `tanaabased/openclaw-agent-system`
- Pull request: [#7: Add GitHub notification routing foundation](https://github.com/tanaabased/openclaw-agent-system/pull/7)
- Branch: `pirog-notifications`
- Handoff changeset parent: `48e39c5171a462f79d6c73125480ce3e712d43dd`
- Current `origin/main`: `dc52d1855f85769ae7e70b6bc79fa3eaf5212097`
- The branch already contains `origin/main` at this snapshot.
- GitHub reports the pull request as mergeable but blocked by failed checks, not
  by merge conflicts.

The handoff changeset contains:

- `.github/workflows/pr-examples-tests.yml`: removes the example-matrix
  concurrency block, as previously requested;
- `examples/notifications/README.md`: restores the notification workspace cwd
  before the removal case;
- `examples/notifications-lifecycle/README.md`: exits early with `doctor` and
  Gateway evidence after a terminal notification failure;
- `lib/github-notification-assignment-orchestrator.ts`: records a distinct,
  value-free code for session inspection, preparation, briefing dispatch, and
  retirement failures;
- `test/github-notification-assignment-orchestrator.spec.ts`: proves those
  diagnostic boundaries;
- `NOTIFICATIONS_PLAN.md`: corrects the Phase 2 status and records the installed
  OpenClaw API blocker;
- this handoff document.

Local repository validation after those changes is green:

- `bun run lint`
- `bun run typecheck`
- `bun run test` — 547 passing
- `bun run build`
- `bun run plugin:check`

Do not run the Leia examples locally. This repository treats everything under
`examples/` as GitHub Actions-only operational validation.

## Latest Remote CI Snapshot

The latest remote example run is
[31609384793](https://github.com/tanaabased/openclaw-agent-system/actions/runs/31609384793).
Lint, release tests, unit tests, and every non-notification example completed
successfully. These three jobs failed on the remote head:

- [notifications (macos-26)](https://github.com/tanaabased/openclaw-agent-system/actions/runs/31609384793/job/94156512712)
- [notifications (ubuntu-24.04)](https://github.com/tanaabased/openclaw-agent-system/actions/runs/31609384793/job/94156512769)
- [notifications-lifecycle (ubuntu-24.04)](https://github.com/tanaabased/openclaw-agent-system/actions/runs/31609384793/job/94156513045)

The two portable `notifications` failures are scenario bugs, not product
failures. Leia executes annotated cases in fresh shells, so the final removal
case was no longer in the notification workspace. The explicit
`cd "$TMPDIR/agent-system-notifications"` in this changeset fixes both operating
systems.

The lifecycle job was not hung. It eventually finished after the scenario's
long polling timeout. The approved assignment and managed worktree succeeded,
but OpenClaw rejected the first session operation before a notification session
could be created. This changeset makes the scenario fail quickly with the exact
session-stage diagnostic instead of the generic
`github-notification-delivery-failed` code.

## Implemented Product State

`NOTIFICATIONS_PLAN.md` is authoritative for the full feature plan. In short:

- Phases 0 and 1 are implemented: manifest schema, account-scoped channel route,
  install/doctor lifecycle, GitHub discovery, trust admission, durable private
  state, and the long-lived monitor.
- Phase 2B is implemented: approved assignments can prepare the deterministic
  managed Git worktree through the existing trusted Git capability.
- Phase 2C is implemented: the recoverable, value-free assignment delivery
  state machine and restart reconciliation exist.
- Phase 2A, 2D, and 2E contain repository logic and deterministic unit tests, but
  their installed session behavior is blocked by the OpenClaw API boundary
  described below.
- Phase 2 is therefore not complete. Do not start Phase 3 while installed
  assignment-to-session delivery remains unsupported.

The GitHub-facing publication and approved-mention bridge remain future work.
Nothing in the current Phase 2 path comments, pushes, or otherwise writes back
to GitHub after assignment admission.

## The `runtime.gateway.request` Finding

The production session adapter currently receives this dependency from
`lib/register-agent-system.ts`:

```ts
gatewayRequest(method, params) {
  return api.runtime.gateway.request(method, params);
}
```

That compiles because the runtime helper appears in the SDK types. It also works
in unit tests because those tests inject a fake `gatewayRequest`. Neither fact
proves that a packed third-party plugin is authorized to call it.

The installed scenario proved that OpenClaw restricts
`api.runtime.gateway.request` to bundled or trusted official plugins. Agent
System is installed from its packed third-party package, so the runtime rejects
the call before the requested Gateway method runs. This is an OpenClaw trust
boundary, not an Ubuntu difference, GitHub token problem, model problem, missing
account token, policy decision, or polling race.

The current adapter depends on the restricted helper for all of these
operations:

| Gateway method         | Notification requirement                                                                  | Installed third-party status |
| ---------------------- | ----------------------------------------------------------------------------------------- | ---------------------------- |
| `sessions.create`      | create or adopt the deterministic routed session                                          | unavailable                  |
| `sessions.patch`       | set label, deny outbound delivery, unarchive, or archive                                  | unavailable                  |
| `sessions.pluginPatch` | persist Agent System work-item metadata                                                   | unavailable                  |
| `sessions.describe`    | inspect session identity, metadata, and archive state                                     | unavailable                  |
| `sessions.list`        | determine whether an ambiguous briefing still has an active run                           | unavailable                  |
| `sessions.abort`       | stop an in-flight automated briefing after authority revocation                           | unavailable                  |
| `chat.history`         | reconcile the assignment event and assistant response after a restart or ambiguous result | unavailable                  |

OpenClaw's public session API currently lets a plugin register the schema for
its own session-extension namespace through
`api.session.state.registerSessionExtension`. Registration only declares how
the extension is shaped. It does not expose a public operation for the plugin to
write its extension value onto a session, read the session, or perform the other
lifecycle operations above.

The public channel inbound runtime is usable and can assemble a routed,
local-only turn with `disableTools: true`, an empty `toolsAllow`, and no outbound
adapter. However, that does not supply the ownership metadata, inspection,
idempotency, abort, and retirement seams required by the recoverable Phase 2
contract. A one-shot turn that cannot be safely reconciled after ambiguity or
restart is not an acceptable substitute.

The restriction was still present in OpenClaw release `2026.7.1-2` and in the
upstream source inspected on 2026-08-12:

- [Gateway plugin runtime gate](https://github.com/openclaw/openclaw/blob/557a8aeab03fdc55cacdb366f2d0bdbcc6f1784b/src/gateway/server-plugins.ts)
- [Public plugin API session surface](https://github.com/openclaw/openclaw/blob/557a8aeab03fdc55cacdb366f2d0bdbcc6f1784b/src/plugins/plugin-api.types.ts#L100-L103)
- [OpenClaw 2026.7.1-2 release](https://github.com/openclaw/openclaw/releases/tag/v2026.7.1-2)

Recheck current upstream before implementing because this API can change after
the date above.

## What Is Not Currently Possible

Through a supported public third-party plugin API, Agent System cannot currently:

- prepare the exact deterministic session before briefing dispatch;
- set its label and fail-closed outbound `sendPolicy`;
- attach or update its registered `work-item` extension value;
- inspect that session and extension after restart;
- determine whether an ambiguous briefing is running or completed;
- prove the event id already appears in bounded session history;
- abort an in-flight briefing when assignment authority is revoked;
- archive a retired notification session while preserving its transcript.

Consequently, the installed lifecycle scenario cannot honestly pass with the
current OpenClaw API. The repository logic is not evidence that the feature is
installed and deliverable.

## Do Not Use These Workarounds

Do not make the scenario green by:

- editing `sessions.json`, session rows, extension slots, or
  `pluginExtensions` directly;
- importing private OpenClaw modules or copied bundled-plugin internals;
- spawning `openclaw gateway call` or another CLI process from plugin runtime;
- pretending Agent System is bundled or trusted official software;
- weakening or deleting the installed lifecycle scenario;
- treating a prompt-only no-tools instruction as a runtime security boundary;
- dispatching without durable ownership and then assuming a timeout is safe to
  retry.

Those approaches bypass host ownership, locking, validation, or authorization
and would turn restart recovery into a corruption or duplicate-delivery risk.

## Required Upstream Contract

The clean fix belongs in OpenClaw. It should expose narrow public capabilities
scoped to the calling plugin rather than grant third-party plugins arbitrary
Gateway RPC access. The eventual surface needs to support the owned behavior
below, whether as one coherent session service or several smaller APIs:

1. create or adopt the exact agent/channel session key owned by the routed
   inbound event;
2. write only the calling plugin's registered extension namespace, without
   accepting a caller-supplied plugin id;
3. read enough owned session state to verify the key, id, extension value,
   archive state, and active-run state;
4. provide bounded event-id or history reconciliation so an ambiguous inbound
   turn is never dispatched twice;
5. set the session label and fail-closed outbound policy through an owned
   channel/session contract;
6. abort only a run associated with the plugin's owned routed turn;
7. archive the owned session without deleting its transcript, or explicitly
   document that logical retirement is the only supported behavior.

A minimal extension mutation API should infer the plugin id from the caller and
allow writes only to a namespace previously registered by that plugin. Do not
design this as a public equivalent of unrestricted `gateway.request`.

## Recommended Continuation

1. Fetch `origin`, switch to `pirog-notifications`, and fast-forward to the
   latest remote branch before continuing on the other machine.
2. Open a focused OpenClaw issue or pull request for the plugin-scoped session
   lifecycle contract. This repository does not contain an OpenClaw source
   checkout, so that is separate upstream work.
3. Once a released or pinned OpenClaw build contains the public surface, update
   Agent System compatibility metadata deliberately.
4. Replace the generic `gatewayRequest` dependency in
   `GitHubNotificationSessionService` with a narrow typed adapter over the new
   public API.
5. Add a registration test proving the production notification path no longer
   reads `api.runtime.gateway.request`.
6. Keep the existing channel-kernel dispatch, no-tools turn restriction,
   outbound denial, authority rechecks, durable checkpoints, and logical
   retirement fallback.
7. Push and run the packed `notifications-lifecycle (ubuntu-24.04)` scenario.
   Phase 2 is complete only when an approved assignment creates exactly one
   worktree and one local briefing session, restart creates no duplicate,
   unassignment stops further turns, and no GitHub write occurs.

Until the upstream seam exists, the useful stopping point is the current one:
portable routing fixed, failure diagnosis precise, plan corrected, private
workarounds rejected, and Phase 3 paused.
