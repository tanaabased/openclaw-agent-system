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
- Feedback observed while disabled remains history and never becomes an automatic
  backlog. When the runtime observes reenabling, use its previous policy-check time as
  the cutoff shared by the issue and its PR. Admit subsequent approved comments
  or revisions, including the interval between checks; do not replay older history. Preserve work
  admitted before the pause. Do not send a retrospective assessment automatically.
- Use reversible policy holds for disabled effects and ineligible actors. Turning
  the setting back on resumes eligible pending work automatically. A hold is not
  cancellation, lost identity, native denial, or a request for renewed consent.
- Live Plan permits assessment; live Work permits actionable implementation and
  PR delivery without another routine stage approval; live Auto additionally
  requires a verified proceed decision. Mode selects the planning-to-implementation transition for existing active
  issues. Once implementation is recorded, a later mode edit does not send the
  issue back to planning or demand another Auto decision. Never infer policy or authorization from provider prose.
- Recover older implementation stages from native continuation attempts or retained
  implementation handoffs, preserving the issue, assessment, and execution receipts.
  A plan, default mode, or publication-only request is not evidence of implementation.
- Preserve actual execution facts: selected native model/effort, consumed stage
  inputs, assessment results, source revisions, cancellations, and submission
  receipts. Live policy does not undo completed work or automatically terminate
  a running native turn. Choose current skills/guidance for the next unsubmitted
  stage; never silently rewrite an already-submitted request.
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
