# Optimization Guidance

Read [Documentation Design](../DOCUMENTATION.md) before assessing documentation.
Apply these audit constraints and accepted decisions before recommending changes.
Reopen a decision only when its stated conditions are met, requirements change,
or current repository evidence contradicts it; name that evidence in the finding.

## Audit Requirements

- Audit every session-facing inbound and outbound path against `channels/github/DESIGN.md` for target lifecycle and message boundaries and `channels/github/PRESENTATION.md` for visual component grammar. Keep current-behavior claims in `channels/github/README.md` and `channels/github/ADVANCED.md` aligned with the implementation.
- Audit every machine-readable CLI path and its automation consumers. A successful `--json` command must write exactly one parseable result to standard output; lifecycle, diagnostic, warning, failure, and debug records belong in the appropriate OpenClaw file log, host logger, or standard-error path and must not corrupt the result at any log level.
- Treat logger selection and propagation as an output contract. Long-lived lifecycle services used by both Gateway and CLI paths must not acquire a console logger merely because a machine-readable command invokes them.
- Require focused unit coverage for logger routing and JSON writers plus an executable GitHub Actions example when output purity depends on the assembled plugin, OpenClaw logging level, or another installed-runtime boundary.
- Preserve aligned surfaces and recommend changes only for evidenced presentation drift, context leakage, publication-boundary violations, ambiguous compatibility behavior, or machine-output contamination.

## Accepted Decisions

### Public Tool API proposal

Keep `API.md` as the public planning surface for the future cross-plugin Tool API, include it in the published package, and keep current-behavior docs explicit that the API is not yet available. Do not recommend removing or internalizing it unless the user changes that product decision or the document contradicts implemented behavior.

### Separate release archives

Keep release package inspection, npm publication, and ClawHub publication as separate pack operations. Exact tarball byte reuse across those paths is not an owned requirement. Each path must still originate from the same prepared release version and keep package contents, plugin metadata, compatibility, tags, source repository, and source commit aligned. Do not recommend unifying the archives unless repository evidence shows those contracts have diverged.

### ClawHub installation contexts

Keep ClawHub in both the `Brewfile` npm packages and pinned `devDependencies`. The Brewfile provides the command in the developer-machine toolchain, while the pinned dependency keeps repository scripts and GitHub Actions reproducible. Do not recommend deduplicating them unless one of those installation contracts is removed.

### Unsupported monitor-state schema 2

Treat GitHub notification monitor-state schema 2 as unsupported legacy state. The only known installation was manually upgraded before schema 3 became the active contract, so keep the decoder rejection test and do not recommend a schema 2 migration or retroactive activation unless the support policy changes or repository evidence shows additional persisted users.

### Monitor-state schema projections

Project monitor-state schema 3 into current schema 5 by retaining assignment,
lifecycle, worktree, failure, and retirement facts while dropping its removed
session, publication, mode, and comment-tracking fields. Project schema 4 into
schema 5 without inventing provider-retirement proof or cleanup outcomes. Do
not restore removed fields to the active intake schema for compatibility.

### Lifecycle-neutral provider primitives

Keep bounded item/comment reads, comment admission, public-candidate parsing,
and idempotent comment publication as lifecycle-neutral provider primitives.
Do not wire them into intake state or restore legacy comment tracking; a
lifecycle session must own scheduling, continuation, and publication authority.

### Leia workflow and model boundaries

Keep general Leia examples in `pr-examples-tests.yml` and manually dispatched GitHub notification acceptance scenarios in `notification-tests.yml`. Scope shared test credentials to each workflow's final Leia execution step even though every matrix entry receives that step environment. Use strict AIMock for the `agent` and `github` examples and the `credentials` cache checks; only `approval`, `containment`, `models`, and `path` select a live OpenAI model. The `codex` example uses direct assertions without a model. The assignment mock must match the created issue title and body so a passing fixture proves bounded provider context reached the installed model turn.

### Shared synthetic SSH preparation

Keep synthetic Leia SSH-key preparation in the shared `openclaw-setup` path used by both matrices. It creates an isolated per-job fixture rather than exposing a shared credential. Do not narrow that setup unless repository evidence shows material cost, exposure, or cross-scenario consumption.
