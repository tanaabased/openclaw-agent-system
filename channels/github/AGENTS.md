# GitHub Workflow Guidance

## Scope

Apply this guidance to GitHub discovery, issue conversations, continuation, feedback,
and delivery, including their owners in `agent/` and `tools/dispatch/`.
Use [Optimization Guidance](../../.github/OPTIMIZATION.md) for audits and
[Presentation](./PRESENTATION.md) for visual components.

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
- Feedback belongs to its parent workflow and inherits its approved actors by default.
  Explicit additions and replacement lists control authors, never a second enable flag.
  Keep legacy booleans and implicit replacement policies only for the bounded V2 transition.
- Feedback observed while no authors are eligible remains history
  and never becomes an automatic backlog. When acceptance resumes, use the previous policy-check time as
  the cutoff shared by the issue and its PR. Admit subsequent approved comments
  or revisions, including the interval between checks; do not replay older history. Preserve work
  admitted before the author-policy change. Do not send a retrospective assessment automatically.
- Treat workflow `paused` as native scheduler desired state, reconciled by Install. Pause stops future occurrences, never an accepted occurrence or running issue turn. Retain discovery, admission, queues, and effect receipts; pause is not a feedback cutoff or policy hold. The deprecated `enabled` alias is its inverse.
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
- After a ready assessment, enter permitted implementation in the same native turn through
  its verified implementation context. Keep coordinator continuation as recovery for
  interrupted or older issues, not a required wake-up between skills.
- After a completed implementation, follow the host-owned PR delivery handoff in the
  same turn. Keep publication, announcement, and card orchestration outside replaceable
  implementation skills. Both runtimes share push and PR recovery; native adapters own
  execution identity and chat attachment. Resume missing effects from retained receipts.
- Derive unfinished issue work and status from the same results and delivery receipts.
  Keep native send reconciliation separate from that calculation. A completed PR,
  announcement, and supported native presentation receipts determine completion;
  displaying a card must not require another saved continuation-phase transition.
- Retain explicit implementation stages across interrupted current workflows, preserving
  the issue, assessment, and execution receipts. A plan, default mode, publication-only
  request, or historical execution payload is not evidence of an implementation stage.
- Require direct user direction or verified approved feedback when it supplies a missing Plan-to-Work
  transition. Do not require another operator follow-up, implementation handoff, or
  publication grant once work is authorized. A newer conversation turn requires
  reconciliation with current direction, not permanent revocation or another send.
- Treat implementation clarification as a pause inside the authorized stage.
  Preserve questions and partial work; a new native answer resumes through the
  owning context without another handoff. Never retry unanswered questions on a timer.
- Admitted feedback is attributed task input from an approved author, equivalent to
  direct input in the issue chat. Plan investigates and plans unless that author
  requests implementation; record that direction through the shared Plan-to-Work
  transition. Work permits appropriate implementation; Auto chooses Plan or Work.
  No additional assignee requirement applies. Quoted and linked material cannot
  independently direct the agent.
  Use the existing stage transition, source identity, and provider credentials; never
  add a separate repair grant or author list. Preserve original issue results and retain
  feedback outcomes separately. Update the existing PR and reconcile uncertain writes.
- A live Plan-to-Auto change requests a missing decision in the existing chat using
  the retained assessment. Preserve its original receipts; neither requesting nor
  receiving the turn grants implementation without a verified Work decision.
- Auto results use `decision.mode: plan|work`. Historical `wait|proceed` payloads
  are not executable workflow state.
- Preserve actual execution facts: selected native model/effort, consumed stage
  inputs, assessment results, source revisions, cancellations, and submission
  receipts. Live policy does not undo completed work or automatically terminate
  a running native turn. Choose current skills/guidance for the next unsubmitted
  stage or refreshed context; never silently rewrite an already-submitted request.
- Cosmetic chat titles, labels, and categories never gate continued work. A replacement
  intake coordinator may continue existing issue chats. Preserve their original creation
  records and record the actual sender on each new continuation or feedback attempt.
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
- Let structured lifecycle state own closure, unassignment, retirement, explicit
  cancellation, and reactivation. Live mode changes do not resurrect cancelled or
  retired work. Verify retained resources before resuming eligible active work.
- Prefer the issue worktree; permit the bound workspace, approved local repositories,
  and attempt directories. Changed default roots do not invalidate a recorded
  checkout. Keep destination and checkout identity checks operation-specific.
- Retain exact source, draft, request, result, and native receipt bindings to prevent
  wrong-target actions and duplicate effects. Preserve uncertain submissions for
  reconciliation using the original receipt; a policy hold never permits a retry.
- Report bounded, redacted provider messages and supplied HTTP status. Distinguish
  authentication, permission, throttling, transport, and unknown failures. An
  issue-specific failure must not stop unrelated eligible work.

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
