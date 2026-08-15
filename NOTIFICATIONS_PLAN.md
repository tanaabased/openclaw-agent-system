# GitHub Notifications Plan

Status: the existing GitHub notifications channel is shipped through the public
OpenClaw channel SDK. This document defines the approved target architecture for
the next notification refactor. Wave 1 changes documentation only; the channel
README continues to describe current runtime behavior until later waves ship.

The refactor separates five concerns that the current implementation partially
conflates:

1. visible chat presentation;
2. bounded current-turn provider context;
3. trusted hidden instructions;
4. mode-specific tool capability; and
5. private responses and authorized GitHub publication.

It also makes issue assignments and pull-request assignments distinct workflows,
turns planning into a resumable conversation, and requires every admitted
comment to inherit the assignment's active mode.

## Document Ownership

This file owns notification lifecycle architecture, assignment kinds, execution
modes, state transitions, message routing, capability boundaries, implementation
waves, and acceptance criteria.

Related documents have narrower owners:

- [`channels/github/PRESENTATION.md`](./channels/github/PRESENTATION.md) owns the
  reusable human-visible message components and private/public response envelope.
- [`channels/github/README.md`](./channels/github/README.md) owns shipped setup,
  configuration, usage, security, and lifecycle behavior.
- [`ADVANCED.md`](./ADVANCED.md) owns complete manifest and CLI reference.
- [`CHANGELOG.md`](./CHANGELOG.md) and Git history own completed implementation
  history. This plan does not preserve superseded behavior as parallel doctrine.

## Current Shipped Boundary

The current implementation remains the baseline for the refactor:

| Surface                        | Shipped behavior                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| Issue assignment               | Approved intake, managed worktree, private session, tool-free planning turn                   |
| Direct pull-request assignment | Approved intake, verified head metadata, private monitoring session without an eager worktree |
| Initial acknowledgment         | Model-authored candidate published after the planning turn                                    |
| Approved top-level comments    | Mention-gated, revision-aware, tool-free private reply with a bounded GitHub candidate        |
| Retirement                     | Logical preservation of sessions and existing worktrees                                       |

The refactor intentionally changes the planning, acknowledgment, comment, and
presentation boundaries. It preserves the existing admission, routing,
authorization, publication-safety, receipt, and non-destructive lifecycle
foundations.

## Product Invariants

The following rules remain non-configurable across every wave:

- Verify the installed agent, workspace, channel account, and exact binding
  before accepting or publishing notification work.
- Admit an assignment only from an approved immutable actor for a canonical
  eligible repository where the agent has sufficient provider permission.
- Treat issue bodies, pull-request content, comments, labels, titles, diffs,
  review text, and provider error bodies as untrusted project data.
- Treat approved identity as permission to enter the configured workflow, not as
  permission for provider text to alter system instructions or capability.
- Store assignment kind and execution mode as trusted lifecycle state. Never
  infer a mode transition from issue, pull-request, or comment prose.
- Keep private responses in the OpenClaw session. Publish only the explicit
  `To GitHub` candidate or a provider-constructed trusted message.
- Reauthorize the exact assignment, actor or comment origin, repository
  permission, account identity, and publication intent immediately before every
  GitHub write.
- Keep publication deterministic after generation. Retry the accepted payload;
  never ask the model to regenerate content during transport retries.
- Persist only value-free control state, stable diagnostics, correlation ids,
  and provider receipts. Do not store credentials, generated prose, issue text,
  comment text, local paths, or tool output in monitor state.
- Preserve sessions and worktrees on retirement or authority revocation.
  Cleanup remains explicit and non-destructive.
- Use public `openclaw/plugin-sdk/*` contracts. Do not recreate protected
  Gateway session APIs, edit OpenClaw transcript storage, or spawn Gateway CLI
  commands to simulate a missing plugin API.

## Assignment Kinds and Execution Modes

Assignment kind and execution mode are separate axes:

```text
assignment kind: issue | pull-request
execution mode:  plan | work | auto
```

This avoids turning domain-specific activities such as pull-request assessment
or review into unrelated top-level mode systems.

### Assignment Kinds

`issue` owns an issue-scoped conversation and managed worktree. Its complete
target lifecycle can plan, ask questions, implement, validate, open a pull
request, and report completion.

`pull-request` owns a distinct conversation for a directly assigned pull
request. The current product retains verified base and head facts without an
eager worktree. This refactor gives that path distinct presentation, context,
instructions, outcomes, and mode inheritance without claiming the unfinished
correlation, review, or mutation lifecycle.

A pull-request review request is not a pull-request assignment. Review requests,
inline review threads, review submission, and correlated issue-to-pull-request
handoff remain separate future work.

### Execution Modes

`plan` is the only initially implemented mode. It investigates the assignment,
asks for clarification when necessary, and produces a reviewable plan or
assessment without persistent implementation changes.

`work` is a future explicit mode. For issues it reuses planning and
clarification, then implements, validates, opens a pull request, and reports the
trusted result. Pull-request Work requires its own later head-adoption and push
authorization design and is not part of the initial refactor.

`auto` is reserved for a later bounded decision contract. Its presence in the
type and presentation model does not authorize automatic behavior before that
policy is designed and implemented.

### Mode Inheritance

Every admitted inbound message inherits the active assignment mode:

- a comment in Plan continues planning;
- a comment in Work continues the authorized work conversation;
- a comment in Auto follows the future Auto contract; and
- no GitHub message may elevate Plan to Work or otherwise change mode merely by
  requesting it in prose.

Mode transitions require a trusted configured or locally authorized lifecycle
action. Approved actors authorize admitted conversation within that mode; they
do not bypass the mode boundary.

## Conceptual Lifecycle State

The target lifecycle uses the following conceptual states. The implementation
may project them into existing value-free checkpoints rather than storing one
literal enum, but their transitions must remain observable and testable.

```text
received
  -> active
  -> awaiting-clarification
  -> active
  -> plan-ready
  -> working
  -> completed

received | active | awaiting-clarification | plan-ready | working
  -> retired | failed
```

Rules:

- `received` means deterministic admission and session preparation completed.
- `active` means the current mode may run or accept an admitted continuation.
- `awaiting-clarification` means the last mode turn published a question and is
  waiting for an admitted answer.
- `plan-ready` means a private plan or assessment and its GitHub-facing outcome
  completed.
- `working` and `completed` are reserved for implemented Work behavior.
- `retired` preserves the conversation and any worktree.
- A publication failure is recorded independently from a successful private
  turn; it does not erase the private outcome.

Only one assignment turn may own the transition for an item at a time. Comment
revision ids, activation adoption, publication ids, and provider receipts remain
durable deduplication boundaries across restarts.

## Layered Message Contract

Every model-backed notification turn is assembled from separate owned layers:

| Layer              | Purpose                                                      | User visibility                                             |
| ------------------ | ------------------------------------------------------------ | ----------------------------------------------------------- |
| Presentation       | Assignment or outcome card, or direct admitted comment text  | Visible in chat                                             |
| Structured context | Bounded provider evidence and provenance                     | Model-only current-turn context                             |
| Instructions       | Trusted behavior and response requirements                   | Hidden system/developer context                             |
| Capability         | Hard tool and mutation boundary selected from trusted mode   | Enforced by runtime, not prose                              |
| Response           | Private operator content plus optional `To GitHub` candidate | Private content visible locally; candidate visibly isolated |

Presentation is never used as a prompt-instruction transport. Structured
context is never treated as trusted authorization. Instructions do not appear in
the chat transcript. Capability is not granted by instructions alone.

One trusted registry maps assignment kind, execution mode, and lifecycle event
to the appropriate layers. The registry may drive more than one OpenClaw sink:
prompt hooks inject hidden instructions, while the supported dispatch or runtime
boundary enforces capability. A single registry does not justify relying on one
hook for controls that a selected runtime cannot enforce.

## Shared Presentation and Publication Boundary

The component contract in `channels/github/PRESENTATION.md` defines:

- issue and pull-request assignment cards;
- plan-ready and clarification-needed outcomes;
- direct comment presentation;
- private response sections; and
- the quoted `To GitHub` publication candidate.

The outbound heading is `## 📤 To GitHub`. `Proposed GitHub reply` is not used.
Only quoted content beneath that heading is eligible for model-authored
publication. Unquoted assessment, plan, discussion, provider context, tool
output, and local status remain private.

The publication gate extracts exactly one candidate for an explicit intent,
enforces intent-specific bounds, rejects secret-shaped or unsupported content,
reauthorizes the target, and publishes the accepted text exactly. Sanitization
means fail-closed rejection, not best-effort rewriting that might change the
message's meaning.

Trusted provider-constructed acknowledgments and completion references may use
canonical actor, issue, pull-request, or comment links assembled from verified
metadata. Free-form model output does not gain permission to publish arbitrary
links, mentions, local paths, credentials, or tool traces.

## Assignment Receipt

Assignment admission produces two independent effects:

1. a private assignment card is recorded in the exact assignment session; and
2. a deterministic mode-specific receipt is published to GitHub.

The receipt does not wait for planning and does not invoke the model. Initial
Plan wording communicates that the assignment was received and planning is
beginning. Future Work and Auto wording must accurately reflect their
implemented behavior.

Personality-varied acknowledgments, randomized curated variants, and
model-authored receipt wording are explicitly deferred. They may later replace
the fixed copy before the deterministic publication gate without coupling
assignment receipt to completion of another model turn.

## Issue Assignment Lifecycle

### Intake

1. Poll and canonically inspect assigned work through the existing bounded
   provider path.
2. Admit only an approved assignment event after identity, repository, owner,
   permission, baseline, and deduplication checks.
3. Prepare or reuse the deterministic managed issue worktree.
4. Record or reuse the deterministic issue conversation through OpenClaw's
   channel inbound lifecycle.
5. Record the issue assignment card and publish the deterministic receipt.
6. Checkpoint the active assignment mode as Plan.

### Planning Investigation

The issue Plan turn receives:

- a compact visible planning card;
- bounded issue title, body, labels, comments, source links, and provenance as
  untrusted current-turn context;
- trusted hidden issue-planning instructions; and
- the `planning-investigation` capability profile.

Planning instructions tell the agent to inspect the issue and discussion,
locate relevant code and documentation, use applicable non-mutating skills,
consult external documentation when useful, perform disposable diagnostic
experiments, identify implementation boundaries and validation, and distinguish
evidence from assumptions.

The result must be an implementation-ready plan or a precise clarification
request, not a paraphrase of the issue.

### Planning Outcomes

A planning turn returns one of two outcomes:

```text
plan-ready
clarification-needed
```

`plan-ready` records the complete private assessment and plan, then publishes
only the separate concise GitHub-facing plan summary or next-step request from
the `To GitHub` candidate.

`clarification-needed` records the private explanation, options, and effect of
the unresolved choice, publishes the separate concise GitHub-facing question,
and checkpoints `awaiting-clarification`.

GitHub receives the decision-relevant outcome, not hidden chain-of-thought,
private repository detail, raw provider evidence, or tool output.

### Clarification and Comment Resumption

An admitted comment is routed through the same assignment conversation whether
or not clarification is pending:

- when the assignment is `awaiting-clarification`, the comment is classified as
  a clarification response and resumes the suspended mode;
- otherwise it is an ordinary continuation in the active mode.

The exact bounded author-written comment becomes the model-facing current
message. Canonical author, item, revision, source, status, and delivery metadata
remain separate structured context. Trusted comment instructions and the
assignment's existing capability profile are injected separately.

The resumed turn may finish the plan, ask another question, or answer the
comment while remaining in Plan. A Plan comment cannot begin implementation.

### Future Issue Work

Issue Work will reuse the same investigation and clarification loop before it:

1. checkpoints an implementation plan;
2. makes contained changes in the managed issue worktree;
3. validates the change proportionally;
4. commits and opens or updates the authorized pull request;
5. records a complete private result; and
6. publishes a concise trusted pull-request completion reference.

Work mode is a separate implementation wave and configuration decision. This
plan does not treat authorization of the architecture refactor as authorization to ship
automatic implementation.

## Direct Pull-request Assignment Lifecycle

Direct pull-request assignment is a separate implemented intake surface with an
incomplete downstream lifecycle.

This refactor will align only the currently owned boundary:

- render a distinct pull-request assignment card;
- retain verified base ref, head ref, head SHA, draft state, author identity,
  canonical links, and bounded summary metadata as PR-specific context;
- use PR-specific hidden planning instructions;
- publish a deterministic PR-assignment receipt;
- support Plan outcomes and clarification through approved top-level comments;
- preserve mode inheritance for every admitted PR comment; and
- keep current logical retirement on close, merge, unassignment, or authority
  revocation.

The initial PR Plan contract assesses only evidence the current authorized
runtime can safely obtain. It must not claim repository inspection, full diff
review, check verification, mutation, or merge readiness without supporting
evidence.

The following remain deferred and must not be implied by presentation or docs:

- eager PR worktree preparation or verified-head adoption for mutation;
- pushing changes to the assigned PR head;
- issue-to-pull-request conversation correlation;
- inline review-comment intake;
- review-request admission or review submission;
- requesting reviewers;
- merge operations; and
- a complete pull-request Work or Auto lifecycle.

## Comment Conversation Contract

The current approved-actor, standalone-mention, canonical-revision, self-event,
stale-revision, and deduplication admission rules remain in force unless a later
product decision explicitly changes them.

After admission:

1. record the exact bounded comment text as the visible and model-facing message
   without a notification card or visible mode note;
2. apply only bounded transport normalization such as canonical line endings,
   supported length limits, and current-revision selection;
3. attach provider provenance and recorded assignment facts as untrusted
   structured context;
4. inject hidden comment instructions selected for the assignment kind and
   active mode;
5. enforce the inherited capability profile;
6. record the complete private response; and
7. extract, validate, reauthorize, and publish only the quoted `To GitHub`
   candidate.

In Plan, a status question may use fresh evidence available to the bounded
planning investigation rather than being restricted to previously recorded
status. In Work, a comment may continue implementation because Work already
authorizes that capability; the comment did not elevate it. Auto behavior
remains undefined until its mode contract exists.

## Capability Profiles

### Planning Investigation

`planning-investigation` is intentionally broader than formal read-only access.
It may include:

- source, test, configuration, and documentation inspection;
- repository search and history inspection;
- non-mutating skills and references;
- bounded provider reads and web documentation;
- diagnostic commands; and
- disposable experiments used to understand behavior.

It denies persistent source edits, normal write/edit/patch tools, commits,
pushes, installs, releases, unsolicited provider mutations, and publication
outside the dedicated notification output path.

Command execution is not intrinsically read-only. Disposable experiments must
run in an enforced scratch, sandbox, or equivalent isolated boundary that cannot
silently modify the canonical worktree. If the selected runtime cannot enforce
that boundary, the turn must degrade to the safely enforceable inspection
surface and report the limitation rather than claim an experiment ran.

### Work

Work capability is future, explicit, assignment-scoped, and mode-gated. It must
reuse Agent System's existing agent binding, workspace containment, credential,
Git, GitHub, and policy boundaries. Provider publication remains a separate
authorized effect even when local implementation tools are available.

### Prompt and Tool Enforcement

Hidden instructions describe how the model should behave. They do not enforce
tool safety. The implementation must inspect the pinned OpenClaw SDK and Codex
harness contracts, select supported turn/runtime boundaries, and test the
effective tool surface for every supported runtime.

The message registry is the single semantic selector for instructions and
capability, while prompt injection and tool enforcement remain separate
technical sinks.

## Target Module Ownership

All new notification message material remains inside `channels/github/` and is
statically imported. Runtime prompt or schema discovery from manifest-selected
paths is not supported.

Target ownership:

```text
channels/github/
  lib/
    message-registry.ts
    message-capability-policy.ts
    assignment-session-service.ts
    planning-turn-service.ts
    comment-turn-service.ts

  messages/
    types.ts
    presentation/
      assignment-card.ts
      planning-outcome.ts
      comment-input.ts
      response-envelope.ts
    context/
      issue-assignment.ts
      pull-request-assignment.ts
      comment.ts
    instructions/
      issue-plan.ts
      pull-request-plan.ts
      comment.ts
```

Create only modules used by the current implementation wave. Do not add empty
Work, Auto, review-request, or PR-mutation modules in anticipation of future
behavior.

Stateful workflow coordination remains in `lib/`. Presentation, extraction,
selection, and context-building functions should be narrow and independently
testable. `session-service.ts` should become a thin compatibility or composition
boundary rather than continuing to own every assignment, planning, comment, and
publication concern.

## Implementation Waves

### Wave 1: Architecture Authority

- Rewrite this plan around the approved target contract.
- Reduce `channels/github/PRESENTATION.md` to reusable visual components.
- Update `AGENTS.md` so lifecycle and presentation ownership are unambiguous.
- Keep the channel README on shipped behavior until runtime waves land.
- Stop for review before changing TypeScript.

### Wave 2: Message Foundations

- Add typed assignment-kind, mode, event, and outcome vocabulary.
- Add the message registry and separate presentation, context, instruction, and
  capability selectors.
- Split assignment, planning, and comment turn orchestration out of the current
  session service without expanding product behavior accidentally.
- Move operational instructions out of visible chat.
- Change the outbound component heading to `To GitHub`.
- Publish immediate deterministic assignment receipts.
- Keep legacy response parsing only as a bounded transition input where needed.

### Wave 3: Resumable Issue Plan

- Implement the bounded planning-investigation capability.
- Produce `plan-ready` and `clarification-needed` outcomes.
- Add private planning outcome cards and validated GitHub candidates.
- Checkpoint `awaiting-clarification` and resume safely across restart.
- Publish a separate plan-complete summary rather than treating receipt as
  planning completion.

### Wave 4: Mode-preserving Comments

- Preserve the direct admitted-comment input established by the message
  foundation.
- Classify pending clarification replies without creating a second comment
  transport.
- Apply the planned capability for every comment turn from its inherited
  assignment mode.
- Verify that comment prose cannot elevate or alter mode.
- Reuse the private plus `To GitHub` response envelope.

### Wave 5: Partial PR Alignment

- Reuse the separate PR assignment presentation, context, and instructions
  established by the message foundation.
- Apply Plan outcomes, clarification, comment inheritance, and deterministic
  receipt within the currently supported PR monitoring boundary.
- Preserve verified-head and retirement behavior.
- Do not implement correlated delivery, review requests, inline reviews, head
  mutation, or PR Work.

### Wave 6: Issue Work

- Resolve the explicit configuration and authorization contract tracked by
  [#30](https://github.com/tanaabased/openclaw-agent-system/issues/30).
- Reuse planning and clarification before contained implementation.
- Validate, commit, open the authorized pull request, and publish a trusted
  completion reference.
- Keep Plan-to-Work transitions explicit and durable.

### Deferred Modes and Lifecycle

- complexity-based model routing: [#31](https://github.com/tanaabased/openclaw-agent-system/issues/31);
- Auto-mode selection: [#32](https://github.com/tanaabased/openclaw-agent-system/issues/32);
- personality-varied or model-authored receipt acknowledgments;
- correlated issue-to-PR delivery and review handoff;
- complete direct-PR Work and review lifecycles; and
- replay, retention, archival, and explicit cleanup controls.

## Test Strategy

Keep unit coverage strong while reducing duplicated prose assertions:

- Formatter owners assert their complete stable component output, escaping,
  plaintext readability, and links.
- Context builders assert bounded structured evidence and the absence of hidden
  instructions from visible fields.
- Instruction selectors assert assignment kind, mode, and lifecycle mapping.
- Capability-policy tests assert exact fail-closed mode boundaries and prove
  comments cannot elevate capability.
- Outcome tests assert `plan-ready` and `clarification-needed` semantics without
  requiring incidental prose.
- Publication tests remain exact for extraction, safety rejection,
  authorization, idempotency, provider markers, and receipts.
- Status-projection tests assert stable lifecycle semantics and prove that raw
  provider content, hidden instructions, session keys, and local paths remain
  private.
- Wait-service tests assert bounded semantic checkpoints, explicit refresh
  ownership, durable failure codes, and last-observation diagnostics.
- Discovery tests assert manifest-selected assignment kinds, while targeted
  refresh tests assert exact item isolation without advancing broad discovery.
- Orchestration tests assert adopted turns, state transitions, resumption,
  publication intent, and stable diagnostic codes without duplicating complete
  Markdown owned by formatters.
- Installed layer scenarios use `notifications status` and `notifications wait`
  for lifecycle coordination, retain independent provider and local-state
  readbacks, and leave chat-history and response-envelope assertions to the
  dedicated presentation scenario.

Run the narrowest owning tests during each wave, then for implementation changes:

```text
bun run lint
bun run typecheck
bun run test
bun run build
bun run plugin:check
```

Run `bun run test:release` when package contents, compatibility metadata,
channel declarations, or release wiring change. Leia scenarios remain GitHub
Actions-only and must not run against a developer's normal OpenClaw state.

## Refactor Acceptance Criteria

The initial refactor is complete when:

- visible assignment and planning cards contain no operational model
  instructions or raw provider envelopes;
- issue and pull-request assignments use distinct presentation and context;
- hidden instructions and hard capabilities are selected independently through
  one trusted semantic registry;
- assignment receipts publish immediately and deterministically;
- issue Plan performs supported investigation and returns a real plan or
  clarification request;
- every planning outcome contains a private response and, when GitHub
  publication is appropriate, one isolated `To GitHub` candidate;
- admitted comments enter the exact assignment session as direct visible and
  model-facing messages and inherit the active mode;
- clarification replies resume the suspended mode across restart;
- Plan comments cannot begin implementation, while future Work comments retain
  already-authorized Work capability;
- private content, structured context, instructions, tool output, and unsafe
  candidates never enter GitHub publication;
- the partial PR path does not claim unsupported review, correlation, mutation,
  or Work behavior;
- the channel README, presentation guide, plan, tests, and shipped behavior agree
  after each implementation wave; and
- a final optimization pass finds no material presentation, context,
  instruction, capability, or publication-boundary drift.

## Retained Technical Foundation

The refactor preserves these implemented owners rather than rebuilding them:

- manifest-filtered account-wide assigned-item discovery plus canonical
  exact-item refreshes that preserve the broad discovery cursor;
- safe installation baseline and overlap-window polling;
- immutable actor and repository-owner admission;
- deterministic issue worktrees and assignment conversations;
- public OpenClaw inbound session ownership;
- one public-SDK message adapter and durable outbound delivery path;
- fail-closed publication validation and send-time reauthorization;
- revision-aware approved comment admission;
- value-free private state and stable diagnostics;
- cross-process locking, restart deduplication, and ambiguous-delivery handling;
  and
- logical retirement with non-destructive preservation.

## Primary References

- [GitHub notification presentation components](./channels/github/PRESENTATION.md)
- [GitHub notifications channel](./channels/github/README.md)
- [OpenClaw messages](https://docs.openclaw.ai/concepts/messages)
- [OpenClaw plugin hooks](https://docs.openclaw.ai/plugins/hooks)
- [OpenClaw channel inbound API](https://docs.openclaw.ai/plugins/sdk-channel-inbound)
- [OpenClaw channel outbound API](https://docs.openclaw.ai/plugins/sdk-channel-outbound)
- [OpenClaw sandbox and tool policy](https://docs.openclaw.ai/tools/multi-agent-sandbox-tools)
- [OpenClaw Codex harness](https://docs.openclaw.ai/plugins/codex-harness)
- [GitHub issue assignment behavior](https://docs.github.com/en/rest/issues/assignees)
- [GitHub pull requests](https://docs.github.com/en/rest/pulls/pulls)

## Superseded Decisions

The approved target contract replaces these earlier planning assumptions:

- Initial acknowledgment no longer waits for or comes from the planning model
  turn.
- Planning and admitted comments are no longer categorically tool-free; they use
  the bounded capability inherited from the active mode.
- Planning may inspect code, documentation, provider evidence, and disposable
  experiments when the runtime can enforce the required boundary.
- An admitted comment may continue Work when the assignment is already in Work,
  but it cannot elevate Plan into Work.
- Planning completion and clarification are distinct resumable outcomes with
  private and GitHub-facing responses.
- Direct pull-request assignment is an implemented partial lifecycle, not a
  future presentation example and not a completed review or mutation workflow.

Future work must not weaken actor identity, repository permission, owner
restriction, exact routing, agent identity, authorization-before-credentials,
untrusted-content framing, idempotency, private/public isolation, or
non-destructive cleanup boundaries.
