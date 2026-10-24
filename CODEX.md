# Codex

The standalone Codex plugin provides workspace context, setup, repository automations, and model routing
from `agent.yaml`. OpenClaw remains the [primary integration](./README.md);
OpenClaw-hosted Codex uses that integration and its managed tools.

## Plugin Installation

Install through [Codex Tools](https://github.com/tanaabased/codex-tools) without a global CLI installation:

```sh
# preview registration and installation.
npx --yes @tanaab/codex-tools install npm:@tanaab/openclaw-agent-system --dry-run --json

# install the plugin.
npx --yes @tanaab/codex-tools install npm:@tanaab/openclaw-agent-system
```

## Workspace Setup

Clone the agent workspace you want to use; this example uses [Me](https://github.com/pirog/me).

```sh
# use your existing checkout if you already have one.
mkdir -p ~/tanaab
git clone https://github.com/pirog/me.git ~/tanaab/me
cd ~/tanaab/me

# copy the absolute path for the binding prompt.
pwd -P
```

Open the checkout as a local project in the Codex app, or run `codex` there.
In Codex CLI with the same profile, use `/hooks` to [review and trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)
the Agent System SessionStart and PermissionRequest hooks, then start a fresh task.

```text
Use $agent-system-codex-binding to bind this plugin to /absolute/path/to/tanaab/me.
```

Confirm the binding, then start a fresh task and run:

```text
Use $agent-system-install to initialize this installation and apply declared setup.
Then use $agent-system-doctor to check readiness.
```

Install creates a persistent installation UUID and generated readable name. Reinstalling
or rebinding a workspace preserves them; Doctor only inspects them. Ask Codex to
“rename this instance to office-laptop” to customize the readable name. Even a
request to “change the instance ID” means renaming unless you explicitly ask to
**rotate the UUID**. Rotation detaches old claim receipts without transferring work;
use it for a copied installation. The trusted `instanceRuntime` exposes these
operator actions without reading OpenClaw state.

### Runtime Execution Approval

Trusting the optional PermissionRequest hook delegates native execution approval to
this installed Agent System runtime, including current and future commands and their
stdin request data. There is no separate consent store or operation whitelist. The
runtime continues to own task authorization, operator-only requirements, validation,
and provider interactions; this hook does not independently assess those decisions.

The hook recognizes direct calls using the absolute Node and runtime paths supplied
in trusted context, with this installation's `--plugin-data` when supplied. Native
stdin and one final quoted heredoc are supported. Different executables, compound
shell commands, expansions, and unrecognized syntax retain normal Codex approval.
The hook only allows or abstains; it never denies or writes workflow state. Commands
continue to work normally when the hook is disabled, unavailable, or does not match.
Native Git, GitHub CLI, and app-tool calls outside this runtime keep their existing
approval behavior. Future routes in the same runtime need no permission-hook entry.

With `debug: true` in the bound workspace's `agent.yaml`, the hook appends diagnostic
records to `permission-request.jsonl` in its plugin data directory. Records contain
invocation and session IDs, a command hash, timing, and the `allow` or `abstain`
decision, without command text or stdin. Logging is off by default; changing `debug`
applies on the next invocation and does not change approval behavior. At 1 MiB, the next logged
invocation clears the file before appending new records; concurrent invocations may
briefly exceed that threshold. Disabling debug preserves existing records. Logging
failures never block approval. A logged `allow`
is not proof that the corresponding command succeeded.

Review and enable the hook through native `/hooks`; disabling it restores ordinary
approval without any Agent System cleanup. Native hook trust is the opt-in, including
trust in the installed runtime's implementation and its subsequent updates. Existing
workflow denials and provider protections remain in their owning paths. See the
[native hook contract](https://learn.chatgpt.com/docs/hooks#permissionrequest) and the
[installed example](./examples/codex-install/README.md).

## Skills

Standalone Codex supports workspace context, [applicable setup steps](./MANIFEST.md#setup), and [repository automations](#repository-automations).
Git and GitHub use native host commands and authorization. The managed GitHub
[self-unassignment guard](./tools/github/README.md#assignment-protection) does not
intercept standalone Codex's host `gh`, absolute binaries, HTTP/SDKs, or unrelated
integrations; it is not a universal GitHub restriction.

- [Codex binding](./skills/codex-binding/SKILL.md) — Bind the standalone plugin to one workspace.
- [Doctor](./skills/doctor/SKILL.md) — Inspect readiness without applying repairs.
- [Git CLI](./skills/git-cli/SKILL.md) — Guide native host Git operations.
- [GitHub CLI](./skills/github-cli/SKILL.md) — Guide native host GitHub operations.
- [Install](./skills/install/SKILL.md) — Apply Codex setup and synchronize declared automations through the native app.
- [Issue launch](./skills/issue-launch/SKILL.md) — Start or reuse the managed issue workflow without assignment or scheduled intake.
- [Issue assessment](./skills/issue-assessment/SKILL.md) — Assess an admitted issue in its native worktree and retain a plan, questions, or a setup blocker.
- [Model routing](./skills/model-routing/SKILL.md) — Select model and effort candidates for new tasks.

## Model Routing

Declare model profiles in `agent.yaml`, then use
[the model routing skill](./skills/model-routing/SKILL.md) when starting new work:

```yaml
models:
  default: { model: openai/gpt-6-astra, effort: high }
  low: { model: openai/gpt-5.6-terra, effort: medium }
  medium: { model: openai/gpt-5.6-sol, effort: high }
  high: { model: openai/gpt-6-astra, effort: xhigh }
```

See [profile configuration](./MANIFEST.md#models) for field rules and
[model routing](./tools/model-routing/README.md) for selection and overrides.
Standalone Codex reads these profiles without changing OpenClaw configuration.
A mapped selection still needs native Codex support and application; it is not
proof that the model is available or that a task is using it.

## GitHub Notification Policy

V3 [notification policy](./MANIFEST.md#githubnotifications) supports issue-assignment
intake through one managed `github-issue-assignment` schedule and one retained chat,
`ISSUE ASSIGNMENTS`, displayed under `AGENT SYSTEM`. The automation is named
`📥 ISSUE ASSIGNMENTS` and uses the workspace’s `models.low` profile. Cadence follows
`interval-minutes`; the automation ID is reserved. Intake records eligible
assignments durably. After explicit reconciliation of the assessment-enabled
schedule, `plan`, `work`, and `auto` assignments can prepare repositories and create native issue chats
and worktrees in saved local Git-backed projects. Work mode continues actionable assessments through implementation and managed PR delivery; Auto requires a retained `decision.mode: work` decision.
Issue feedback can resume its owning chat for explanation and a bounded public reply.
Independent review requests remain unavailable through this Codex path.
Unavailable reviews warn without blocking independent setup or issue-assignment scheduling.

Use `$agent-system-install` to authorize and reconcile the chat and schedule in one
workflow. Install verifies a new chat's saved native approval settings and the saved
schedule; no global scanner allow rule or restart acknowledgment is required. Commands that need
approval still pass through native review, which can deny them.
Doctor verifies saved automation definitions; current chat permissions are not
exposed by the read-only native interface. Verify unattended execution separately
with a real scheduled poll. Intake uses
native host GitHub access; the authenticated account must match `github.username`
and applicable identity pins. Repository read access is sufficient. The first
successful activation establishes a historical baseline; reinstall and restart
retain it and deduplicate assignments by event identity.

To pause future issue-intake occurrences on this machine, set `paused: true` under
`github.issue-assignment`, then authorize Install to pause and verify
the owned schedule. Native UI pause stops the same future work. An accepted
occurrence and already-running issue turns may finish; authorization, feedback,
checkpoints, and completed receipts remain unchanged. Set `paused: false` and run
Install to resume the same schedule and chat. Eligible assignments and comments
that arrived during the pause can then be discovered without repeating completed
effects. Install can reverse a UI-only pause if the manifest still requests active
intake. V3 uses `paused`; `enabled` is rejected.
You choose which machine runs each workflow; two active machines do not coordinate
or deduplicate work between them.

Use `$agent-system-doctor` to inspect admitted issues, assigning actors, event IDs,
baseline, checkpoint, and blockers without contacting GitHub. Scheduled scans use
the trusted `intakeRuntime` from Agent System context. The assessment-enabled
schedule also revisits retained dispatch work through `dispatchRuntime`, even when
intake is unchanged. Unchanged combined results stay quiet. Records require fresh
authorization before execution; previous intake-only consent does not enable dispatch.

### Issue Assessment

Dispatch verifies the repository's full GitHub identity before selecting a saved
local project. An explicit
`git.worktrees.repositories.local.github-<repository-database-id>` mapping wins;
otherwise, optional `git.worktrees.repositories.working-directory` selects
`<directory>/<repository-name>`. A matching normal checkout is reused without
resetting user work; a missing checkout is cloned with native host Git authorization.
See [Git repository locations](./tools/git/README.md#gitworktrees) for path rules.

Without either location, dispatch first reuses a matching saved project. If none
exists, it prepares the managed bare repository and one stable detached base
checkout beneath the configured worktree root. That base is the project folder;
native Codex still creates the separate issue worktree. A configured path or clone
failure blocks preparation rather than choosing a different storage location.

The native interface currently has no supported saved-project registration action.
When registration is needed, dispatch reports the exact prepared checkout to add as
the primary folder of one saved local Codex project. The next scheduled occurrence
verifies it and resumes the retained assignment. Until that manual step, new-repository
dispatch is not unattended. Ambiguous projects, identity conflicts, and interrupted
clones retain actionable blockers rather than creating replacements.

Use Install to authorize and reconcile the repository-preparation schedule before
using this behavior; an older assessment schedule is insufficient. Changing repository
locations requires reconciliation again. Repository and checkout records survive
retries and restarts. New assignments use the reconciled location without moving
or deleting earlier checkouts. An assignment already preparing a repository remains
pinned to its retained path: restore its explicit local mapping or previous directory
and roots, then reconcile through Install. Interrupted clones also require recovery
at their original location before selecting another destination. Once the saved project is verified, dispatch refreshes the
default branch and pins the exact starting commit for the native issue worktree.

Assessment leaves that checkout detached. Verified implementation selects and retains
an issue branch for the current assignment attempt, starting at the pinned commit.
Retries keep that branch, including after an issue title change. After retirement
completes, a new assignment uses a distinct branch; earlier branches, commits and
pull requests remain preserved. Reassignment before retirement completes follows
the existing reactivation rules and may continue the same attempt.

For assessment without assignment, invoke `$agent-system-issue-assessment` with an
explicit GitHub issue URL and an existing local checkout root in the current chat.
It uses the bound agent's [assessment selection](./MANIFEST.md#assessment-selection)
and returns a saved plan, questions or a setup blocker. No intake activation, new
chat, checkout preparation, implementation or GitHub posting occurs, even with Work
or Auto defaults. Matching managed work reuses its verified context and results;
invalid managed ownership must recover through its owner, never a manual fallback.
Ask for a revision after answering questions, or for the full assessment to inspect
its retained source. An unavailable checkout or invalid explicit skill/guidance must
be corrected before retrying in the same chat.

Bounded issue evidence and structured metadata inform the shared model router.
The saved model and effort are passed explicitly to native creation. After verified
creation, operators may tune either through native controls in the same issue chat;
continuation inherits current settings without resetting them. Original routing,
current native readback, and historical execution evidence remain distinct. Missing
readback stays unverified; this does not authorize agents to change settings.
The issue chat performs read-only assessment and records one of three outcomes:
`plan-ready`, `clarification-needed`, or `operator-setup-blocker`, with evidence and
completed/remaining investigation. A user follow-up may revise the assessment in
the same chat. A result never authorizes implementation or publication.
New submissions require the complete source in `fullAssessment`; incomplete results
are rejected before recording. Older saved assessments remain readable. If an older
assessment lacks summary source or its revision, recovery reports the summary as
blocked until the missing evidence is restored through the authorized assessment flow.

Use [assessment selection](./MANIFEST.md#assessment-selection) under
`github.issue-assignment` to select an active skill and optional inline
or file guidance. Dispatch resolves the ID through native skill discovery and retains
the selected name, source path, instruction digest, and guidance snapshot. The child
verifies that same skill in its actual worktree before beginning. A missing or changed
skill blocks assessment; restore it and resume the retained chat rather than launching
another. The dispatch `context` response exposes the retained selection and guidance.
The default skill's structured result and direct submission remain recommended.
Replacement skills may follow that approach or return an ordinary assessment in
their own format, without Agent System commands, result fields, or required headings.
The surrounding workflow supplies verified context and retains ordinary output
unchanged, deriving its summary, outcome, evidence, and progress for the same result
contract. It checks those fields against the complete assessment before submission;
this is model judgment, not deterministic proof of fidelity. Unusable output receives
an actionable limitation rather than a ready label. Already recorded integrated
results are not adapted or submitted again.

The complete assessment is shown inline and returned on same-chat revisions; it
remains the source of truth rather than its summaries. Guidance cannot widen the
assessment's authority.
For implementation without another assessment or chat, invoke
`$agent-system-issue-implementation` with the issue URL, existing checkout and an
authorized actionable plan, or reuse matching retained work. The thin direct collector
supplies the same implementation payload as managed execution and uses your current
[implementation selection](./MANIFEST.md#implementation-and-review-selection).
Missing plan details produce a focused question. Manual entry is local-only unless
you explicitly request PR delivery; supplying a plan does not authorize publication.
Resume through the returned context and result handoff, not a replacement attempt.
Stale managed work must recover through its original owner, never manual fallback.

[Implementation and review selections](./MANIFEST.md#implementation-and-review-selection)
use the same trusted selection contract. Work uses the bundled
[issue implementation skill](./skills/issue-implementation/SKILL.md) by default;
review execution remains unavailable.
[Feedback permissions](./MANIFEST.md#feedback-permissions) are now separate for issue
assignment and review requests; the removed global setting requires an explicit choice.

### Issue Feedback

An active issue workflow derives feedback authors from its allowed assignment
actors and configured reviewers. Both lists empty approves nobody. `feedback`
accepts only skill and guidance customization. Author and reply-policy changes apply live; the parent workflow
needs its installed intake schedule, with no separate feedback activation.
Approved comments must address the configured GitHub account outside quoted text.
The initial read establishes a baseline without replaying historical comments.
Subsequent issue comments, submitted PR reviews and inline replies route to the
original issue chat with their exact source and review context retained.
You can also invoke `agent-system-feedback-reply` directly in the current chat
with a selected GitHub comment/review URL, or a response and exact issue/PR
destination. It uses your bound `agent.yaml` reply skill/guidance and voice without
activating intake. It returns a draft; posting requires an explicit request and
native approval. Matching managed work reuses its existing owner and receipts;
invalid managed context never becomes a manual bypass. See the
[reply skill](./skills/feedback-reply/SKILL.md) for selection and recovery.

For an explicitly requested issue progress update, use [GitHub Update](./skills/github-update/SKILL.md). It compares public facts with verified progress in this chat, uses the configured shared reply composer, and returns the full private answer plus the exact confirmed public quote. Already-current issues get no comment; unfinished original publications recover first. This does not start implementation or change mode.

Public replies to inline feedback stay in the original review thread. Replies to
submitted reviews and ordinary PR comments appear in the PR conversation.

Assignments and feedback share `max-concurrent-items`, which defaults to **3**.
A busy owner queues feedback without taking another slot. An idle owner needs a
free slot; the oldest eligible work proceeds, and each completed response puts
that owner's remaining backlog behind work already waiting. Questions, blockers
and completed turns release capacity. Uncertain native sends retain their slot
until reconciled and are never blindly repeated.

The intake card reports feedback delivered to chats, queued items across issues, and
occupied slots. Answers and publication outcomes stay in the owning chat;
unchanged checks remain quiet. Feedback follows the issue's stage: Plan permits
investigation and planning; Work permits appropriate implementation; Auto may choose
Plan or Work with a reasoned decision. An issue already in implementation keeps that
stage after default mode changes. Questions can still receive a direct answer.
Feedback work retains its own result and commit, preserving the original assessment
and implementation. Delivery updates the same PR and reuses its announcement.
Publication rechecks the exact source and active assignment, and reconciles uncertain
writes before another action.
The chat displays the complete retained private response. The configured
`feedback.skill` (default `agent-system:agent-system-feedback-reply`) then composes
a separate public candidate, applying optional `feedback.guidance` and applicable
voice skills. It summarizes for the audience rather than truncating the private
answer. Runtime `result` saves the private response, `compose` returns the verified
skill and context, and `candidate` records its output against the composition
digest. Missing or changed skills withhold the reply and preserve the private answer.
The final chat response includes the private explanation, the exact public quote,
and the verified publication link or an explicit obstacle.

Routine public replies use a two-step publication: `publish` without a digest
returns the exact destination and attributed draft without a GitHub write;
`publish` with that digest rechecks authority and executes through native approval.
Operator activation covers the configured routine reply scope, but never overrides
a native approval denial.
Feedback authored by the publishing GitHub account receives a private response
only. Confirmed runtime replies are excluded from intake, preventing reply loops.
An unfinished publication stops instead of automatically resuming another model
turn. After explicit human approval, an operator chat may preview
`feedbackRuntime` with `{"action":"publish-approved","id":"...","eventId":"..."}`
and apply its returned `digest`. This retries only the exact retained reply,
rechecks its source and permissions, and reconciles any uncertain provider write.
Later follow-ups do not invalidate the retained reply; recovery verifies its original
completed feedback turn and waits if the owning chat is active.
Independent reviewer feedback still requires the reviewer intake adapter. Discovery
and retained queues are bounded: incomplete provider reads or a full journal stop
new feedback admission with a diagnostic; they do not silently discard comments.

### Auto Mode

Set `github.issue-assignment.mode: auto`, then authorize Install to
reconcile the saved workflow. Auto uses your existing assessment skill and guidance
to choose `decision.mode: work` or `decision.mode: plan`, with reasons shown in the issue chat. Clear, bounded
work can continue through the configured implementation and managed PR delivery;
incomplete requirements, broad scope, or consequential uncertainty should wait.
A ready plan alone does not authorize implementation.

A Plan decision retains the complete plan and releases its implementation slot.
Polling alone does not change the decision. Newly admitted feedback may support a
new Auto decision; Plan mode still needs operator direction to enter implementation.
Missing or invalid decisions, lost task identity, and native denials affecting implementation stop continuation.
A denial limited to the public assessment summary holds that publication while independently authorized work
can request fresh implementation context in the same permitted turn. Broader or unknown denial scope remains a stop.
Preserve the issue chat and its retained work when resolving an obstacle. Live mode changes govern
entry into implementation for existing planning issues. Once implementation has
started, later mode changes preserve that stage. Auto requires
a verified Work decision before implementation. OpenClaw uses the same Plan/Work decision and continues eligible work in its existing issue chat.

### Work Mode

Set `github.issue-assignment.mode: work`, optionally override its
implementation skill or guidance. Initial setup uses Install to create the native
schedule; later mode and guidance edits apply without Install. Work mode permits
assessment, implementation, and PR publication without routine
stage approvals. Changing the live mode to Work also makes existing actionable Plan issues eligible
for automatic continuation; an explicit operator request can still use the retained handoff. An actionable assessment hands directly to the implementation skill in the same
native turn, with the complete plan, current guidance, and selected model and effort.
The coordinator resumes interrupted or older issues; a second wake-up is not
required between assessment and implementation.

If the stored reader reports the assessment turn as interrupted without a verified
end, continuation returns `observation-required` with `continuation-turn-state-unresolved`.
Call the native `read_thread` tool with the returned arguments, then repeat continuation
context. The runtime verifies the actual desktop tool receipt after its retained history
boundary; caller-supplied status JSON cannot authorize the handoff. A stale, inactive,
unavailable or denied observation never counts as an active turn. Preserve the existing
chat and work when resolving it; do not force another coordinator message.

The runtime reads live workflow policy and checks the owning chat, active assignment,
and native receipts without renewed stage approval. Policy-only edits take effect
without Install. Disabled effects and currently ineligible authors are held and
reconsidered automatically. Preserve completed work, explicit cancellations, native
denials, and uncertain submissions. Choose current implementation instructions
before preparing a new send; never rewrite a submitted request. Current issues retain
their explicit implementation stage and exact execution receipts across interruption
without recreating the chat, repeating the handoff, or requiring Install.
Implementation and delivery count against workflow capacity;
intake reports stay limited to admission and capacity.

Automatic PR publication requires an explicit public description of the change,
verified checks, and limitations. Private reports are not copied into GitHub.

Work and Auto activation already authorize the workflow's branch push, PR creation
and updates, and its originating-issue announcement. Configured assessment summaries
and feedback replies use their own activated authority. These effects do not require
a second conversational permission request. Native execution review and provider
permissions still apply; syncing the plugin does not grant host permissions or
override an earlier denial.

Workflow commands expose their action before `--plugin-data`: for example,
`delivery prepare`, `delivery publish`, `dispatch summary compose`, or
`continuation delivery publish`. Keep request data on stdin; an action repeated
there must match argv. Preparation validates and returns the exact draft and digest
without publication. Only the explicit publication operation may perform its
authorized external write. Saved action-on-stdin commands remain compatible.

A saved assessment summary can resume in a newer verified turn, including after
implementation has begun. Its source assessment remains unchanged; recovery finishes
only the missing response. Summary-only native continuations use the existing issue
chat and exact send receipts. A native summary denial remains a publication hold across turns,
not ordinary pending-response recovery. It is not retried or published through another route;
supported verified recovery or renewed authorization is required. An
uncertain GitHub post is observed rather than reposted. Private recovery notices name
the affected response and preserve the complete private result and draft.

Native continuation intent is retained before sending. An uncertain send is
reconciled, never repeated blindly. A recorded implementation can resume delivery
without reimplementing or creating another PR. A stopped implementation remains
in the same chat with its files and evidence: inspect the blocker and explicitly
continue through the existing manual handoff if human intervention is needed.
For missing consequential requirements, an implementation result can be
`clarification-needed`, with questions and the complete partial-work report. The
issue keeps its implementation stage. A new answer in the same chat resumes
through continuation context without another approval; scheduled scans leave it
waiting instead of resending the request.

Use `continuationRuntime` action `cancel` in the issue chat to stop further automatic
work; it does not undo files or an already-started external operation. Disable the
workflow in the live manifest to hold pending automatic work; Install reconciles
the saved automation.

For `continuation-turn-ended` before an implementation result or delivery attempt,
an operator may request `continuationRuntime` action `retry` with the retained `id`,
then repeat it with the returned `digest`. This verifies the old turn has ended,
retains its evidence, and queues one handoff in the same chat on the next scheduled
turn. It cannot retry native denials, substantive results, or cancelled work.

An altered continuation prompt stops with `continuation-send-mismatch`. The same
operator retry can recover a verified, completed malformed send only before any
recorded implementation or delivery, with the original assessment checkout unchanged.
The preview binds the native send evidence and latest diagnostic turn; recovery
retains both before queuing one new handoff. Unknown or duplicate sends, changed
native settings, and approval denials remain blocked. Never edit tracking files or
manually resend the old request.

For an explicitly reapproved native send rejection before implementation, use
`continuationRuntime` action `retry-denied` from the operator chat with the retained
`id`. Inspect its rejection evidence, then apply its `digest` and the exact
`approvedCallId`. Recovery requires the original idle chat and unchanged assessment
checkout, retains the rejected attempt and reason, and queues one fresh handoff for
scheduled intake. Native approval still applies. Unknown send failures, later chat
turns, and denials during implementation or publication remain blocked.

Deterministic fixtures and packaged checks alone do not establish unattended native
execution or visible card delivery.

### Pull Request Delivery

Once an issue enters implementation, its ordinary PR delivery needs no separate
publication grant. Honor explicit restrictions in the conversation. The trusted `deliveryRuntime` accepts JSON actions with the retained
dispatch `id`: `prepare` previews the current branch, head, identity, and recipient
policy; `publish` requires that preview's `digest` and the same optional `title`
and `body`. Preparation grants no publication authority. Codex uses native host
Git and GitHub authorization, preserves authored commits and PR metadata, and
adds the original issue's closing reference. The PR must be open, authored by the
active account, and target the same repository's default branch.

Delivery requires the branch retained for this assignment attempt. If the checkout
uses another branch, preserve any local changes and return to the retained branch
before resuming. A same-issue branch name or historical comment does not establish
ownership. Older active work can retain an exact delivery binding with a saved PR receipt; authored
work without that evidence stops for recovery rather than adopting a branch or
resetting commits. Resume incomplete branch creation through implementation context
in the existing chat. A closed PR on the selected branch still blocks publication.

Publication retains the PR before recipient reconciliation. If a later step
fails, prepare and resume that operation. An uncertain creation is reconciled
against the managed branch; it is never blindly repeated. Attach the returned
URL with native `attach_artifact`, read `list_artifacts`, then call `reconcile`
and `compose` to load the configured reply skill for the verified delivery event.
Submit its short description with `candidate`, inspect the returned preview, and
execute `announce` with that preview's digest. Managed publication authority covers
this one announcement on the originating issue, including when the feedback author
list is empty; native denial still stops it. The host adds the verified PR URL and its
current draft/ready status. Call `present` and reproduce its complete private PR card,
public quote, and announcement outcome in the final reply. The runtime
generates the cards; successful generation alone does not prove they were displayed.
Attachment verification is nonblocking: the verified PR card remains
available with an attachment warning. Delivery notices use the shared info, warning,
and error cards; publication errors retain the existing PR for retry. Attachment and
presentation failures do not create another PR. Announcement failure also preserves
the PR. Retry an uncertain announcement with `announce` to reconcile the saved text
and provider receipt; it never blindly repeats a comment POST. `present` only shows
the saved card and outcome and makes no public write.
See [recipient configuration](./MANIFEST.md#pull-request-recipients) for defaults.
Work-mode publication uses the same delivery operation through the trusted
continuation runtime. Configured issue feedback also covers its verified delivery PR.

Native creation receipts, chat identity, worktree, and results survive interrupted
polls. An uncertain creation is reconciled against native creation history; it is
never blindly repeated. Preserve the retained evidence when repairing access,
project setup, or host failures. Unresolved creations continue to consume capacity
until reconciled, preventing a succession of potentially live duplicate chats.
After verifying creation provenance, worktree,
and model settings, the runtime corrects a changed native title and verifies the rename
before assessment; the display title does not establish chat identity.

When you explicitly ask the issue chat to continue with implementation, its agent
records a `handoff` before changing the checkout. This records the transition out of assessment;
it does not mark the issue complete. Implementation includes ordinary PR delivery. The existing
chat, worktree, and recorded outcome are retained. If an unsaved assessment still
occupies a slot after you approved further work, recover from the issue or operator
chat with `dispatchRuntime` input `{"action":"handoff","id":"<assessment-receipt>"}`,
then repeat with the returned `digest`. The runtime verifies the existing native
chat and repository, then verifies the transition against live Work/Auto policy or
native human direction for Plan. Keep the existing work rather than
resetting and reassigning it.

Each scheduled check produces one intake report: newly started **Issue** links,
**Active**, **Retirement pending**, and **Pending** counts, occupied **Slots**, and intake warnings or errors.
Active means retained issue destinations eligible for intake, not currently running work. Pending means
accepted assignments waiting to start. Slots count conversations with unfinished
assessments, automatic continuation or delivery, or dispatched feedback awaiting its
outcome. A saved assessment alone does not occupy a slot; unresolved native attempts
can retain their reservation until inactivity is verified.

After verified creation, intake does not inspect or announce assessment progress.
Plans, questions, assessment failures, and implementation updates stay in the issue.
Unchanged healthy reports use the existing quiet-message rotation without notifying;
new starts and changed intake health can notify. Reports record attempts, not proven
message delivery: wording or link differences never block admission or create retries.
Existing creation receipts still prevent duplicate work after interruption. Legacy
notification backlogs are discarded without removing issue records or saved results.
A quiet report requires a current scan and a completed dispatch check.

An `EPERM` or `EACCES` failure can mean the sandbox cannot write private tracking
files under the plugin data directory. The agent retries the same command once
through native host approval. A verified issue-specific preparation or chat-creation
denial is held across runs and reassignment without retrying that action. Unrelated
eligible assignments continue when native host authority and capacity permit; if the
host ends the turn, the next permitted run reconciles the refusal before selecting work.
Shared refusals, ambiguous scope, and unavailable native evidence still stop intake.
The report identifies the blocked issue, denied action, redacted native reason (or
its unavailability), and recovery identifiers. From an operator chat, request
`dispatch retry-denied` for the retained `id`; approve the exact `approvedCallId`
when required, preview recovery, then apply its fresh `digest`. Recovery rechecks
native non-execution and current assignment authority; it does not guarantee approval
of the new attempt. It never deletes locks or loosens directory permissions. Native
approval requests retain their native UI.

For a workspace-wide notification reset, invoke `$agent-system-notifications-reset`, which uses `notificationResetRuntime` from an
operator chat. Send `{"agent":["<bound-agent-id>"]}` on stdin to inspect the scope,
then add `"yes":true` and the returned `confirmation` token after approval. `"all":true` selects only the current
binding; it never discovers or changes other Codex installations. Add `"purge":true`
to include the retained resource inventory.

Reset clears management and feedback state, establishes a fresh assignment
baseline, archives the old intake chat, and binds a fresh coordinator. Existing issue chats and checkouts remain unless purge was selected. It prepares native
`automation_update` requests to pause and restore intake. Execute each request once
and repeat the same reset to verify saved state. It waits for managed turns without
aborting them. An unverified native mutation is not issued again automatically.
Native denial remains a stop.

Reset and purge never change GitHub issues, assignments, comments, or pull requests. Purge additionally prepares managed issue chat archival and checkout cleanup. Supply
the current native `list_threads` result as `nativeInventory` when requested so
pinned and shared resources remain protected. Codex owns managed worktree removal.
After archival, purge waits up to 30 seconds per checkout for native cleanup.
If a checkout remains, the operation reports incomplete and retains its recovery
record until native worktree controls remove it. It never edits app databases or
deletes a managed checkout behind the desktop's back. Repeat the same reset to
reconcile completion; do not discard its recovery file. There are no separate
workspace-reset status, retry, or resume actions.

To repeat one assessment through assignment intake, use `dispatchRuntime` with
`{"action":"reset","id":"<assessment-receipt>"}` from an operator chat, then repeat
with the returned `digest`. Reset requires a completed assessment and native confirmation
that its recorded result turn completed, with no later turn. It freezes the previous
result while preserving its chat and worktree; only a
new assignment event after reset permits a fresh dispatch. Reassignment alone does
not create another chat, and reset never authorizes implementation.

Closed issues, work unassigned by a live approved actor, and manually archived chats
leave Active on the next intake check. Unapproved or unverifiable removal reports
the missing assignment while preserving the existing chat, checkout and work stage;
admitted work remains eligible within its existing permissions, without reassignment. See the [assignment lifecycle](channels/github/ADVANCED.md#assignment-lifecycle)
for grace periods, reactivation, and cleanup protections. Intake prepares eligible
Codex chats for native archival; the desktop owns worktree snapshots and reclamation.
Retirement completes after archival and checkout removal are observed. Use `$agent-system-task-retirement` for an explicit operator request, or call
`dispatchRuntime` with `{"action":"retire","id":"<task-id>"}` and apply its preview
digest. The issue can remain open and assigned. The request enters the same safe
cleanup immediately, skipping eligibility wait and grace, without waiting for an
intake occurrence. A running task remains pending, including a request from its own
active turn. Repeated requests reconcile the same disposition and resource receipts;
ordinary intake cannot recreate the unchanged assignment. Native archival and
checkout reclamation may remain asynchronous or protected.

Both scheduled cleanup and `retire` read the
[shared installation setting](./CONFIG.md#shared-cleanup), not OpenClaw configuration
or a per-agent copy. Retirement does not
change the issue or branch and never marks resources reclaimed before native
verification.

After an operator-confirmed denial, pause the schedule and use `dispatchRuntime`
with `{"action":"retry-denied","id":"<assessment-receipt>"}` from the operator chat.
The preview requires the exact native rejected call and no child or pending receipt.
Repeat with its returned `digest` to retain the denied attempt and permit fresh
preparation after resuming the schedule. Timeouts and unknown outcomes cannot use
this recovery path.
An automatic-review rejection additionally requires renewed operator approval for
the exact failed call. Supply its `approvedCallId` in both preview and apply, and
communicate that authorization to the intake chat before resuming. This field
records an approval already given; it does not grant one.
Packed/headless checks do not prove native desktop rendering or scheduled delivery;
those require a separately authorized installed-plugin occurrence.

Removing or revoking policy stops admission. Run authorized Install to pause the
owned job, including when the manifest is missing or invalid. Ownership and intake
evidence are retained for recovery; do not delete them to clear a blocker.
See [automation recovery](#ownership-and-recovery) for native write failures.

## Repository Automations

Installer-created automation chats use native `auto_review` with the
`workspace-write` sandbox and `on-request` approvals. Setup verifies the returned
permissions and their persistence through a fresh native process before marking
the chat ready. Native policy remains authoritative; auto-review may deny an
action. Existing ready chats retain their selected permissions. Neither setup nor
the plugin writes global approval rules to enable auto-review.

Declare recurring work in `agent.yaml`:

```yaml
automations:
  - id: daily-review
    schedule: every 24 hours
    prompt: Review the repository for actionable maintenance work and report the highest-priority finding.
```

Use `$agent-system-install` in the desktop app to apply authorized native actions
and verify each saved definition. Doctor compares desired and saved settings
without changing or running jobs. Headless Install returns
`requires-native-app-sync` when native app work remains.

The shared [`thread` declaration](./MANIFEST.md#persistent-conversations) creates
stable **per-automation** conversations, even when jobs declare the same ID;
these chats do not share context. A compatible `codex` executable must be on
`PATH`; unsupported protocol methods fail closed. The desktop app owns every
schedule.

The [manifest reference](./MANIFEST.md#automations) owns shared syntax and
schedules. Codex supports this subset:

| Manifest field                                    | Codex behavior                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overrides.codex.effort`, `overrides.codex.model` | Independent jobs inherit omitted values from the ambient Codex home's top-level configuration at sync time. Named configuration profiles require explicit overrides. Later default changes appear as drift; native Codex decides model/effort availability.                                                 |
| `overrides.codex.target`                          | Defaults to an independent job in the one saved local project matching the bound workspace. `{ thread: existing-id }` selects an existing local chat there; model and effort overrides are rejected for these explicit chat targets.                                                                        |
| `prompt`, `payload`                               | Recurring prompts, including prompts asking a model to run a script.                                                                                                                                                                                                                                        |
| `run`                                             | Zero-model commands are unsupported, including `payload.kind: command`.                                                                                                                                                                                                                                     |
| `schedule`                                        | Whole-minute intervals from 1 to 1440 or whole-hour intervals from 1 to 999. Cron supports one minute every hour, or one daily time with daily, weekday, or month-day selection across all months. Multiple-job expressions and unsupported day-field combinations are rejected; one-shots are unsupported. |
| `schedule.timezone`                               | Omit or use `null` for native local time. Named IANA zones map directly to native `DTSTART;TZID=…` recurrence rules; UTC uses a UTC start. Available for every supported cron shape, including hourly. `native` is not accepted.                                                                            |
| `thread`                                          | Creates a persistent conversation per automation. Explicit model and effort overrides set initial native chat settings; later drift requires the native chat controls.                                                                                                                                      |
| `timeout-seconds`                                 | Unsupported. Native timeout, concurrency, retry, and catch-up rules apply.                                                                                                                                                                                                                                  |

Zoned creation and schedule edits require saving the native review card; a proposal
alone is not a synced automation. Unrelated edits preserve the saved recurrence.
Codex owns timezone evaluation, DST, and missed-run behavior. The adapter does not
expand calendars or translate named-zone clock times into UTC.

**Native timezone limitation:** in desktop version 26.1021.22027 (21747), the
inspected named-zone recurrence calculation depends on the scheduler host’s
timezone and can produce the wrong wall-clock time. Saving and retaining a zone
does not establish correct execution timing. This adapter preserves the requested
zone without compensating for that native defect or promising OpenClaw-identical
DST behavior.

Missing or ambiguous projects block planning; worktree bindings do not select the
parent checkout. Chat targets require a fresh native exact-chat read with active,
idle, running, or completed status. Explicit chat targets are not replaced or
rebound to the installer's conversation.

Codex uses ambient host credentials and permissions; it does not resolve OpenClaw
credentials or change Codex permission settings. Unavailable models, accounts,
app operations, or unattended permissions block completion. Saved definitions
prove persistence, not successful execution. Run-now, native occurrence history,
and execution/delivery telemetry are unavailable; a separately requested manual
task has its own history and does not prove native scheduling.

### Ownership and Recovery

Agent System owns jobs through markers and a private non-secret ledger. Native
edits to managed fields are drift; notification preferences remain native-owned.
Unchanged jobs receive no writes. Removed declarations pause jobs and retain
history; reintroduced IDs reuse them. Personal and Me jobs are not adopted by name.
Unknown saved schemas stop inspection.

For `automation-thread-model-drift`, use the existing chat’s native controls to
apply the requested model and effort, then rerun Install. Settings-only app-server
updates do not persist across connections; Agent System does not claim success
from a transient update or replace the chat.

Interrupted writes require saved-state readback before retry; the install skill
guides recovery. Missing owned jobs or divergent state require investigation.
Earlier verified actions are not rolled back, and concurrent native UI edits are
not protected by atomic compare-and-swap. For `automation-journal-busy`, confirm
no reconciliation is running before removing only the stale Agent System `.lock`
directory. Never repair native scheduler files or delete the ownership ledger.

See the [Codex automations example](https://github.com/tanaabased/openclaw-agent-system/blob/main/examples/codex-automations/README.md#automation-checks)
for conversation setup, headless planning, and recovery checks.

## Development

From a checkout with [locked dependencies installed](./DEVELOPMENT.md#requirements),
build and install through the pinned development dependency:

```sh
# build the runtime, then preview and install the local plugin.
bun run build
./node_modules/.bin/codex-tools install . --dry-run --json
./node_modules/.bin/codex-tools install .
```

Rebuild after changing the Codex runtime or its imports. For changes to
`.codex-plugin/`, `assets/`, `hooks/`, `package.json`, or `skills/`, sync the
installed cache directly:

```sh
bun run codex:sync
bun run codex:check
```

If a development build writes a changed persistent format, verify that any runtime
restored during cleanup can read the retained state. Cache equality alone does not
verify dispatch recovery.

Start a fresh task to verify skill discovery. `package.json#codexTools.managedPaths`
selects the paths owned by cache synchronization and checks; it does not control
what native Codex copies during installation.

For packaged installation and discovery checks, run `bun run test:codex-plugin`
with `AGENT_SYSTEM_PACKAGE` set to a prepared npm tarball. The release-test
workflow runs this with an isolated Codex home. Other repository checks remain
in [Development](./DEVELOPMENT.md#testing).
