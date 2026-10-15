# Optimization Guidance

Read [Documentation Design](../DOCUMENTATION.md) before assessing documentation.
Apply these audit constraints and accepted decisions before recommending changes.
Reopen a decision only when its stated conditions are met, requirements change,
or current repository evidence contradicts it; name that evidence in the finding.

## Audit Requirements

- Audit every session-facing inbound and outbound path against the lifecycle and publication constraints in `AGENTS.md` and `channels/github/PRESENTATION.md` for visual component grammar. Keep current-behavior claims in `channels/github/README.md` and `channels/github/ADVANCED.md` aligned with the implementation.
- Audit every machine-readable CLI path and its automation consumers. A successful `--json` command must write exactly one parseable result to standard output; lifecycle, diagnostic, warning, failure, and debug records belong in the appropriate OpenClaw file log, host logger, or standard-error path and must not corrupt the result at any log level.
- Treat logger selection and propagation as an output contract. Long-lived lifecycle services used by both Gateway and CLI paths must not acquire a console logger merely because a machine-readable command invokes them.
- Require focused unit coverage for logger routing and JSON writers plus an executable GitHub Actions example when output purity depends on the assembled plugin, OpenClaw logging level, or another installed-runtime boundary.
- Preserve aligned surfaces and recommend changes only for evidenced presentation drift, context leakage, publication-boundary violations, ambiguous compatibility behavior, or machine-output contamination.

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

Separate native OS coverage from runtime coverage. Keep installation/Doctor, execution, and credential/filesystem contracts on macOS and Ubuntu in `pr-examples-os.yml`. While staging changes, select the new example alone and restore proven examples after its checkpoint passes; retain other examples unscheduled until their owning runtime coverage is migrated. Select contracts before choosing runner counts. Scope credentials to the scenarios that need them; the OS examples require no hosted secrets. Native credential enrollment belongs in `os-install`; file fallback and private SSH key protections belong in `os-credentials`. The installed agent, real exec, and filesystem receipt in `os-execution` provide the basic host smoke; notification admission and completion still require runtime coverage. Use strict AIMock for `os-execution`, `agent`, `github`, and the `credentials` cache checks; only `approval`, `containment`, `models`, and `path` select a live OpenAI model. The `codex-install` and `codex-workflows` examples use direct assertions without a model. Start `pr-examples-runtime.yml` with `codex-install` on Ubuntu only; keep `codex-workflows` unscheduled until its own checkpoint. Do not make OS and runtime axes an automatic cross-product.

### Shared synthetic SSH preparation

Keep synthetic Leia SSH-key preparation in the shared `openclaw-setup` path. It creates an isolated per-job fixture rather than exposing a shared credential. Do not narrow that setup unless repository evidence shows material cost, exposure, or cross-scenario consumption.
