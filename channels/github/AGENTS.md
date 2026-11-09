# GitHub Workflow Guidance

## Scope

Apply this guidance to GitHub discovery, issue conversations, continuation, feedback,
and delivery, including their owners in `agent/` and `tools/dispatch/`.
Use [Optimization Guidance](../../.github/OPTIMIZATION.md) for audits and
[Presentation](./PRESENTATION.md) for visual components.

## Workflow State and Progress

These constraints apply to implementation, review, and repairs in both Codex and
OpenClaw, including owners outside this directory.

- Native conversation owns investigation, plans, questions, answers, implementation,
  and continuation. Agent System supplies verified issue context, configured guidance,
  live policy, and routing. Do not mirror the conversation in a second state machine.
- Before adding a persisted field, receipt, checkpoint, retry, or blocking gate,
  identify the concrete wrong external action or resource loss it prevents and why
  existing native/provider evidence cannot prevent it. Explain this in the existing
  change review, not a new tracking artifact. Convenience, observability, or making
  internal records agree does not justify a prerequisite for work.
- Retain only the state needed for owned effects such as admission, routing,
  duplicate prevention, uncertain publication, and safe resource cleanup. Optional
  progress and presentation records must remain optional. Missing assessments,
  summaries, cards, or acknowledgments must not stop otherwise authorized work.
- A verified child chat must not depend on its coordinator finishing later
  bookkeeping before it can obtain task context. Reuse native creation evidence;
  do not add a readiness handshake or polling loop to compensate for that dependency.
  Missing local bookkeeping is not proof that a chat is unmanaged. Preserve actual
  identity, source, destination, authorization, and uncertain-effect protections.
- Repair observed failures in their existing owner. First consider removing an
  unnecessary dependency; do not turn each pilot failure into another controller
  layer or a workflow redesign.
- Verified issue closure retires the task through native archival and checkout
  cleanup. Reconcile stale checkout paths against current native ownership and
  repository identity; historical bookkeeping must not permanently block cleanup.
  Preserve actual shared-resource conflicts and native denials, and distinguish
  confirmed archival from observed checkout reclamation.
- Test the user-visible behavior with realistic incomplete state and controlled
  ordering, including child startup before coordinator reconciliation. Do not
  prepopulate the very records the test claims are unnecessary. Hook delivery and
  successful bookkeeping are supporting checks, not proof that an assigned task
  investigates, asks and publishes a needed question, continues after an answer,
  or delivers a PR within its authorized mode. Cover those outcomes and their
  required presentation at the owning runtime boundary before claiming them verified.

## Live Policy

- Read the current bound `agent.yaml` when deciding the next automatic operation.
  Its workflow settings apply to existing issues as well as new ones. Admission
  snapshots and saved configuration hashes never preserve an obsolete grant.
- Separate discovery, eligibility, and execution. Observe bounded assignment and
  comment activity within configured repository/issue scope even when its author,
  feedback setting, or mode does not currently permit dispatch. Retain observations
  independently of the queue of eligible effects.
- Reevaluate already admitted, unprocessed work after policy changes without
  rebuilding its queue, replaying completed effects, or requiring Install.
- Feedback intake inherits its approved actors from the parent workflow by default. Once verified, feedback is native chat input with independent delivery and reply receipts.
  Configured reviewers extend issue feedback authors; feedback customization never grants authority.
- Feedback observed while no authors are eligible remains history
  and never becomes an automatic backlog. When acceptance resumes, use the previous policy-check time as
  the cutoff shared by the issue and its PR. Admit subsequent approved comments
  or revisions, including the interval between checks; do not replay older history. Preserve work
  admitted before the author-policy change. Do not send a retrospective assessment automatically.
- Treat workflow `paused` as native scheduler desired state, reconciled by Install. Pause stops future occurrences, never an accepted occurrence or running issue turn. Retain discovery, admission, queues, and effect receipts; pause is not a feedback cutoff or policy hold.
- Use reversible policy holds for disabled effects and ineligible actors. Turning
  the setting back on resumes eligible pending work automatically. A hold is not
  cancellation, lost identity, native denial, or a request for renewed consent.
- Live Plan permits assessment; live Work permits actionable implementation and
  PR delivery without another routine stage approval; live Auto additionally
  requires a verified Work decision. Mode selects the planning-to-implementation transition for existing active
  issues. Once implementation is recorded, a later mode edit does not send the
  issue back to planning or demand another Auto decision. Only verified comments from live approved feedback authors may provide task direction; unverified provider prose cannot grant authority.
- Workflow declaration and original-assigner eligibility govern admission, not progression within an admitted issue. Live mode still governs
  its first implementation transition. Preserve an entered implementation stage while the issue remains
  active; feedback still requires its current approved source.
- Native chat owns planning, questions, implementation and subsequent conversation from
  admission onward. Saved assessments and results are optional history. Work permits
  scoped implementation without a saved plan; Plan requires explicit operator or
  verified approved-feedback direction; Auto uses a bounded reasoned decision in the
  current turn. Permission survives clarification, but never overrides newer user
  instructions, local-only scope or actual native denials.
- Do not schedule initial Auto handoffs or recurring keep-going messages. Missing
  plans, results, cards, announcements or answers never justify a continuation send.
  Observe actual native requests and uncertain external effects through their
  original receipts. Native recovery owns interrupted conversation execution.
- Eligible feedback is revalidated at delivery and then treated as native input.
  Implementation cancellation or old workflow progress must not block that input
  or its source-bound reply. Keep exact source and account/chat identity checks;
  do not create a per-comment assessment, implementation or result workflow.
- Create a PR when the requested work is complete and appropriately verified, suitable
  for review and merge. Initial task/PR linkage and supported attachment, card
  presentation, and the originating-issue PR-available update are independent effects.
  The association is mutable metadata; explicit relinking or unlinking must preserve
  pending effects at their original destinations. Later substantial updates may
  repeat the card and use Task Update without repeating initial linkage or announcement.
- Retain legacy records as readable history and actual pending effect receipts.
  They do not require a migration message, reassessment or generic resume before
  existing chats can accept ordinary native direction. Defer bulk migration and
  schema removal to their owning cutover work.
- Preserve actual execution facts: selected native model/effort, consumed stage
  inputs, assessment results, source revisions, cancellations, and submission
  receipts. Live policy does not undo completed work or automatically terminate
  a running native turn. Choose current skills/guidance for the next unsubmitted
  stage or refreshed context; never silently rewrite an already-submitted request.
- Cosmetic chat titles, labels, and categories never gate continued work. A replacement
  intake coordinator may continue existing issue chats. Preserve their original creation
  records and record the actual sender on each new feedback attempt.
- Install reconciles installed machinery, such as native cadence, executable
  identity, and scheduler configuration. Mode, approved authors, recipients,
  guidance, capacity, and other runtime policy edits must not change the installed
  orchestration definition or produce an automation-update requirement.

## Provider Permissions and Local Boundaries

- Let GitHub credentials, repository roles, organization rules, and server-side
  protections enforce provider permissions. The manifest selects what automation
  should attempt; it does not grant privileges denied by GitHub.
- Do not duplicate provider permissions with speculative write probes, broad risk
  gates, configuration fingerprints, or per-stage conversational approval.
  Keep local protections only for a concrete high-consequence provider gap under
  the repository's policy-design rules.
- Preserve trusted agent/account/workspace binding, signing, and resource ownership.
  Verify actual repository, branch, issue, chat, and publication destination.
- Keep resource retirement and exact native cancellation receipts with their owners.
  They do not become a second conversational lifecycle. Verify actual resources and
  current direction when an operation needs them; ordinary replies do not require an
  implementation transition.
- Prefer the issue worktree; permit the bound workspace, approved local repositories,
  and attempt directories. Changed default roots do not invalidate a recorded
  checkout. Keep destination and checkout identity checks operation-specific.
- Retain exact source, draft, request, result, and native receipt bindings to prevent
  wrong-target actions and duplicate effects. Preserve uncertain submissions for
  reconciliation using the original receipt; a policy hold never permits a retry.
- Report bounded, redacted provider messages and supplied HTTP status. Distinguish
  authentication, permission, throttling, transport, and unknown failures. An
  issue-specific failure must not stop unrelated eligible work.

## Conditional Provider Reads

- Route eligible product-owned GitHub REST reads through the shared conditional
  transport in `provider/work-event-api-client.ts`. Preserve ETags and revalidate
  with `If-None-Match`; reuse the saved body only after a provider-confirmed 304.
  Endpoints without validators continue with ordinary fresh reads.
- Keep observations credential-scoped and preserve mutation invalidation. Never
  substitute cached success for a denied, malformed, or interrupted response.
  Writes and GraphQL requests must not inherit conditional REST validators.
- Preserve the behavioral coverage in `test/github-conditional-reads.spec.ts`
  when changing provider reads; temporary profiling is not the enforcement mechanism.

## Optimization Audit

For each gate, identify the effect, owner, scope, and recovery. Ask whether it:

1. Duplicates a permission the provider already enforces.
2. Uses a historical manifest or policy hash instead of current policy.
3. Couples discovery or installed scheduling to runtime eligibility settings.
4. Turns a reversible live-policy hold into a permanent blocker or reauthorization.
5. Protects a concrete identity, lifecycle, execution-input, or replay invariant.

Remove obsolete gates and tests that merely freeze them. Preserve behavioral
coverage for live policy changes, actual denials, exact custody, and duplicate
prevention. Do not replace one permission layer with a more intricate copy.
