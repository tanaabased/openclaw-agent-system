# GitHub Workflow Guidance

## Scope

Apply this guidance to GitHub intake, issue conversations, continuation, feedback,
and delivery, including their runtime owners in `agent/` and `tools/dispatch/`.
Use [Optimization Guidance](../../.github/OPTIMIZATION.md) for audits and
[Presentation](./PRESENTATION.md) for visual components.

These are maintainer requirements for changes and audits. Existing runtime checks
must be assessed against them; this file does not claim that all paths already
conform.

## Provider Permissions

- Let GitHub credentials, repository roles, organization policy, and server-side
  rules enforce repository access and operations. Apply the same boundary through
  native commands, managed tools, and workflow adapters.
- Do not duplicate provider authorization with workflow permission preflights,
  configuration fingerprints, or another per-stage approval. Execute the requested
  operation under its existing task scope and correct credentials; report the
  provider's actual result. Do not issue speculative write probes.
- Retain a local tool protection only for a concrete capability gap the provider
  cannot adequately express. Name that gap and the protected effect; a broad risk
  label is insufficient. Follow the repository's policy design requirements.
- Preserve bound agent identity, credential selection, workspace containment,
  signing, and managed-resource ownership. Possession of another agent's usable
  credential never makes that identity substitution valid.
- Keep repository-owner and assigner allowlists as automated admission rules.
  Changes to those defaults do not retroactively revoke an existing issue's task.
  An explicit restriction on existing work must identify the affected scope.

## Continued Work

- Separate new admission from the lifetime of an admitted issue conversation.
  Disabling notifications or pausing intake stops new intake; it does not cancel
  existing chats, their recorded task scope, or their permitted continuation.
- Changes to default Plan/Work/Auto mode, model profiles, skills, guidance,
  recipients, polling, capacity, debug, or cleanup settings do not invalidate
  existing task permission. Preserve the recorded scope and selected execution
  inputs. Apply changed defaults to future admissions unless the operator
  explicitly changes an existing task.
- A Plan task remains assessment-only until the operator requests more work.
  A recorded Work grant covers its implementation and PR delivery without another
  routine stage approval. Auto retains its recorded proceed/wait contract. A new
  default must neither expand nor shrink these existing grants implicitly.
- Keep existing continuation recoverable independently of new-intake enablement.
  If its execution mechanism is unavailable, explain that limitation and preserve
  the task; do not manufacture a permission revocation or require repeated consent.
- Pause affected work for an explicit cancellation, pause, or scope restriction;
  an inactive lifecycle state; an agent, destination, or checkout identity
  mismatch; an actual provider or native approval denial; or a concrete execution
  failure. Name the observed condition and distinguish a durable stop from
  retryable unavailability. Missing evidence does not establish revocation.
- Let structured lifecycle reconciliation own unassignment, closure, retirement,
  and reactivation. A pending or retired issue gets lifecycle-specific guidance.
  Resume through the supported eligible reassignment or explicit reactivation,
  verifying retained resources before use. Do not silently self-assign to undo a
  stop, infer active status from a chat's existence, or promise resources survived
  because retirement is still pending.
- Confine an issue-specific failure to that issue or operation. Stop a whole pass
  only when the observed condition actually applies to the whole pass.

## Fingerprints and Recovery

- Do not require whole-manifest equality, or equality with a retained notification
  policy/model fingerprint, as continuing permission to work on an existing issue.
  Retain configuration snapshots and hashes only for provenance, drift reporting,
  or the reconciliation of the configuration they actually describe.
- Keep exact request, source, destination, result, and native receipt bindings
  where they prevent wrong-target actions, changed publication content, duplicate
  creation, or replay. A fingerprint of a prepared operation serves a different
  purpose from a fingerprint of all current defaults.
- Reconcile uncertain submissions through their existing receipts before retrying.
  Preserve the original issue, chat, worktree, and PR; never create replacements to
  escape a diagnostic.
- Reuse bounded provider diagnostics for authentication, permission, rate limits,
  transport, and unknown failures. Surface safe upstream evidence and recovery
  guidance for the affected operation. Do not turn every failure into an
  authorization rejection or prescribe Install for unrelated provider failures.
- Keep the automation-update reconciliation gate specific to the saved intake
  automation. It must not become a cancellation of existing issue work.

## Optimization Audit

For every local gate, identify the exact effect, authorization owner, affected
scope, state transition, and recovery. Then ask:

1. Does GitHub, Git, or the credential provider already enforce this condition?
   Prefer removing the duplicate gate and retaining useful upstream diagnostics.
2. Is the setting an admission/default setting or an explicit instruction about
   this existing task? Flag hashes that conflate those roles.
3. Does the gate protect identity, containment, task scope, lifecycle, or replay?
   Name that invariant directly instead of calling every failure policy drift.
4. Can unrelated configuration changes block assessments, implementation, PRs,
   replies, or presentation? Can one issue's failure stop unrelated issues?
5. Do tests prove the required boundary, or merely require broad fingerprint
   invalidation and generic errors? Replace the latter with operation-specific
   cases for continued work, explicit stops, upstream denials, and safe recovery.

Report retained exceptions and their concrete provider gaps. Do not replace one
broad permission layer with a more intricate local copy of provider permissions.
