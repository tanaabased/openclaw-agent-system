# Optimization Guidance

Read [Documentation Design](../DOCUMENTATION.md) before assessing documentation.
Apply these audit constraints and accepted decisions before recommending changes.
Reopen a decision only when its stated conditions are met, requirements change,
or current repository evidence contradicts it; name that evidence in the finding.

## Audit Requirements

- Audit GitHub permission and workflow gates against [GitHub Workflow Guidance](../channels/github/AGENTS.md), including their runtime owners outside the channel folder. Identify duplicated provider authorization, whole-manifest or retained-policy equality used as permission, historical grants that override live policy, runtime policy edits that require Install, and reversible holds turned into permanent stops, and issue-local failures that stop unrelated work. Recommend removal unless the gate protects a named local invariant or a concrete provider capability gap.
- Audit every session-facing inbound and outbound path against the lifecycle and publication constraints in `AGENTS.md` and `channels/github/PRESENTATION.md` for visual component grammar. Keep current-behavior claims in `channels/github/README.md` and `channels/github/ADVANCED.md` aligned with the implementation.
- Audit every machine-readable CLI path and its automation consumers. A successful `--json` command must write exactly one parseable result to standard output; lifecycle, diagnostic, warning, failure, and debug records belong in the appropriate OpenClaw file log, host logger, or standard-error path and must not corrupt the result at any log level.
- Treat logger selection and propagation as an output contract. Long-lived lifecycle services used by both Gateway and CLI paths must not acquire a console logger merely because a machine-readable command invokes them.
- Require focused unit coverage for logger routing and JSON writers plus an executable GitHub Actions example when output purity depends on the assembled plugin, OpenClaw logging level, or another installed-runtime boundary.
- For presentation audits, preserve aligned surfaces and recommend changes only for evidenced presentation drift, context leakage, publication-boundary violations, ambiguous compatibility behavior, or machine-output contamination.
- When auditing tests, apply [Verification Categories](../DEVELOPMENT.md#verification-categories) per assertion, including mixed specs. Name the executed unit or static invariant, the failure it detects, and any existing owner coverage. Recommend keep, tighten, split/move, or remove based on that evidence; flag static assertions that only duplicate current file contents as maintenance burdens. Preserve distinct safety and compatibility checks, and do not require a new static runner merely to classify them.

## Accepted Decisions

### Publication file references

Keep harmless absolute file references admissible in GitHub replies. Prefer
repository-relative paths in model guidance, but do not treat every absolute path
as private data or add a blanket path filter. Preserve the existing credential,
secret, and hidden-context protections. Reconsider only for a concrete sensitive
data disclosure or an explicitly changed publication policy.

### Public Tool API proposal

Keep `API.md` as the public planning surface for the future cross-plugin Tool API, include it in the published package, and keep current-behavior docs explicit that the API is not yet available. Do not recommend removing or internalizing it unless the user changes that product decision or the document contradicts implemented behavior.

### Separate release archives

Keep release package inspection, npm publication, and ClawHub publication as separate pack operations. Exact tarball byte reuse across those paths is not an owned requirement. Each path must still originate from the same prepared release version and keep package contents, plugin metadata, compatibility, tags, source repository, and source commit aligned. Do not recommend unifying the archives unless repository evidence shows those contracts have diverged.

### ClawHub installation contexts

Keep ClawHub in both the `Brewfile` npm packages and pinned `devDependencies`. The Brewfile provides the command in the developer-machine toolchain, while the pinned dependency keeps repository scripts and GitHub Actions reproducible. Do not recommend deduplicating them unless one of those installation contracts is removed.

### V1 notification retirement

V1 notification runtime and configuration support are retired by operator decision.
Do not automatically revive, migrate, or delete its historical on-disk records;
explicit operator-authorized reset and purge use the existing lifecycle owners.
Do not restore legacy polling, session handling, or compatibility machinery to
manufacture parity. The current readiness/status channel is not a legacy intake
engine. Preserve shared provider, publication, presentation, and current native
authority/receipt contracts. Missing features remain explicit limitations and
separate implementation work.

### Lifecycle-neutral provider primitives

Keep bounded item/comment reads, comment admission, public-candidate parsing,
and idempotent comment publication as lifecycle-neutral provider primitives.
Do not wire them into intake state or restore legacy comment tracking; a
lifecycle session must own scheduling, continuation, and publication authority.

### Leia workflow and model boundaries

Separate native OS coverage from runtime coverage and select contracts before runner counts. Keep `os-install`, `os-dispatch-enrollment`, `os-execution`, and `os-credentials` on macOS and Ubuntu: native enrollment and restart/revocation, shell/PATH/PTY execution, private filesystem state, and trusted signing. Keep portable Doctor presentation and aliases in `openclaw-doctor` on Ubuntu. Keep native tool-grant reconciliation and operator-denial coverage in the separate `openclaw-tool-access` example on Ubuntu. Preserve one basic Doctor inspection in native installation; do not duplicate portable permutations across both OSes.

Keep the runtime examples on Ubuntu. Workspace coverage owns validation, environment-backed identity, setup ordering, shared Codex prerequisites, model configuration, convergence, and read-only inspection. Tools cover public commands and contextual shims, including stdin and uncontaminated machine output; `openclaw-tool-descendants` owns bound setup/automation descendants and credential isolation. GitHub coverage verifies two account identities and native profile consumption. Local worktree coverage owns reuse and dirty-removal refusal without hosted credentials. `openclaw-worktree-session` owns disposable remote SSH enrollment and a native session retaining canonical guidance, identity, exact input custody, and working directory across restart. Credentials cover both 1Password Environments and a direct vault-secret consumer. Memory covers keyword retrieval; `openclaw-memory-embeddings` owns installed embedding-secret resolution and retrieval across restart. Backup captures and restores workspace files and a real agent database with committed WAL content; `openclaw-backup-cleanup` owns preview/apply/repeat cleanup and preservation of complete, uncertain, and foreign artifacts. Ordinary automations own command/prompt completion; `openclaw-automation-recovery` owns offline diagnostics, drift repair, and restart routing. Runtime execution stays separate from `openclaw-lifecycle-approvals`, which owns native Install/Doctor decisions and effects. Preserve source tests for parser permutations, provider failures, collaboration selection variants, archive safety, retention, and lock-loss guards; retire duplicated legacy Leia material and orphaned fixtures/helpers.

Use strict AIMock where the real native agent/tool loop matters and fixed authenticated embedding fixtures for the memory handoff. Keep native execution and approval effects real while strict AIMock supplies the authored runtime turns. Standalone Codex install, automation, and notification examples verify packaged boundaries without a model. Keep the OpenClaw notification journeys separate and parallel: `openclaw-notifications-issue-journey` owns one assignment, a retained plan, and one ordinary issue-comment reply; `openclaw-notifications-conversation` owns later GitHub/direct questions, cosmetic chat edits, clarification, and retained-assessment readback; direct unassigned assessment and reply belong to `openclaw-issue-assessment` and `openclaw-github-reply` in runtime coverage; `openclaw-notifications-intake` owns notification installation compatibility, concurrent intake, retained initial results, and repeat-scan duplicate prevention; the focused `openclaw-notifications-assessment-recovery`, `openclaw-notifications-feedback-policy`, `openclaw-notifications-assignment-policy`, `openclaw-notifications-reactivation`, `openclaw-notifications-retirement`, and `openclaw-notifications-reset` examples own their named recovery and policy boundaries; `openclaw-notifications-pr-journey` owns approved implementation, linked PR delivery, and uninterrupted PR conversation feedback; focused `openclaw-notifications-pr-recipients`, `openclaw-notifications-pr-update`, `openclaw-notifications-pr-presentation`, `openclaw-notifications-pr-collaboration`, `openclaw-notifications-pr-discovery`, and `openclaw-notifications-pr-reply-recovery` examples own recipient preview, operator updates, dirty-checkout readback, collaborator reconciliation, stalled discovery, and reply-only resumption. Each refresh admits only its own issue, and repeat scans prove no duplication. Installed inline-review coverage belongs to the deferred review flow. Diagnose observed activation failures before introducing retries or additional restart coverage.

Use one Leia execution step after setup with one shared environment block per workflow; unused test credentials and model settings may be shared across entries. Keep credentials off setup steps. Follow Leia with the same generic `failure()` diagnostics block in each example workflow. The OS examples require no hosted secrets. Do not make OS and runtime axes an automatic cross-product. Keep runner batching and timing optimization separate from coverage selection.

### Shared synthetic SSH preparation

Keep synthetic Leia SSH-key preparation in the shared `openclaw-setup` path. It creates an isolated per-job fixture rather than exposing a shared credential. Do not narrow that setup unless repository evidence shows material cost, exposure, or cross-scenario consumption.

### Source test boundaries

Keep source specs flat under `test/`. Select deterministic units with `test:unit` and repository invariants in `*.static.spec.ts` with `test:static`; both run on Ubuntu in the existing unit workflow. Apply the verification categories above per assertion, rather than treating a read-only check as a unit test. Select portable `*.component.spec.ts` with `test:component` on Ubuntu, and native `*.os.component.spec.ts` with `test:os` on both supported OSes. Keep mixed unit/component specs in the component selection until their unit-shaped cases are extracted. The built memory helper belongs to portable component coverage. Keep the 100,000-entry backup fixture opt-in under `test:stress`; preserve normal PR coverage with bounded filesystem pruning and pure payload/parent-limit checks. `bun run test` remains the fast unit alias; `bun run test:all` covers all ordinary selections and excludes stress. Never remove a retained check from CI merely by excluding it from the unit glob.

### Notification baseline follow-up

Keep intake focused on concurrent admission and repeat-scan duplicate prevention.
Notification scheduler pause/resume belongs to `openclaw-notifications-scheduling`;
unavailable candidates belong to assignment policy, and the refreshed assessment
owns stage-specific debug presentation. Keep ordinary progression and clarification
in `openclaw-notifications-progression`, with interrupted Auto-decision recovery in
`openclaw-notifications-decision-recovery`. Keep initial-turn Work delivery in
`openclaw-notifications-work`, ordinary skills with retained custom guidance in
`openclaw-notifications-work-custom`, and structured Auto Work delivery in
`openclaw-notifications-auto-work`. Keep Auto Plan hold and authenticated operator
continuation in `openclaw-notifications-auto-plan`. Preserve independent cleanup and the
original assessment, native owner, execution settings, and one-time handoff evidence.

Keep all ordinary PR checks enabled for the full-suite validation. Start notification measurements
without a matrix concurrency cap. If GitHub throttles, try caps of 9, 5, 3, 2,
then 1 for the selected examples. Record actual overlap, duration, and provider
diagnostics; distinguish exhausted primary quota from burst throttling and honor
the provider's retry/reset timing between trials. A per-run cap does not limit
the combined load from multiple PRs using the same accounts.
