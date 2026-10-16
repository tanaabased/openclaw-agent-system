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

### V1 notification retirement

V1 notification runtime and configuration support are retired by operator decision.
Keep its historical on-disk records untouched; do not restore a decoder, scanner,
channel, or compatibility engine to manufacture parity. Preserve shared provider,
publication, presentation, and native V2 authority/receipt contracts. Missing V2
features remain explicit limitations and separate implementation work.

### Lifecycle-neutral provider primitives

Keep bounded item/comment reads, comment admission, public-candidate parsing,
and idempotent comment publication as lifecycle-neutral provider primitives.
Do not wire them into intake state or restore legacy comment tracking; a
lifecycle session must own scheduling, continuation, and publication authority.

### Leia workflow and model boundaries

Separate native OS coverage from runtime coverage. Keep installation/Doctor, execution, and credential/filesystem contracts on macOS and Ubuntu in `pr-examples-os.yml`. While staging changes, select the new example alone and restore proven examples after its checkpoint passes; retain other examples unscheduled until their owning runtime coverage is migrated. Select contracts before choosing runner counts. Scope credentials to the scenarios that need them; the OS examples require no hosted secrets. Native credential enrollment belongs in `os-install`; file fallback and private SSH key protections belong in `os-credentials`. The installed agent, real exec, and filesystem receipt in `os-execution` provide the basic host smoke; notification admission and completion still require runtime coverage. Use strict AIMock for `os-execution`, `openclaw-agent`, `openclaw-automations`, `github`, and the `credentials` cache checks; the native OpenClaw turns in `openclaw-runtimes` also use strict AIMock. Only its hosted Codex turns and the deferred `containment` and `models` examples select a live OpenAI model. The `codex-install`, `codex-automations`, and `codex-notifications` examples use direct assertions without a model. Select `codex-install`, `codex-automations`, `codex-notifications`, `openclaw-agent`, `openclaw-workspace`, `openclaw-automations`, and `openclaw-runtimes` in `pr-examples-runtime.yml` on Ubuntu only. The `openclaw-workspace` example uses direct assertions for validation, environment-backed identity, ordered setup, the shared Codex prerequisite, model configuration, idempotency, and read-only Doctor inspection. The notification example covers packaged activation and authority contracts; real notification admission and completion still require separate runtime proof. Scope the existing live-model credential and model selection to the `openclaw-runtimes` execution step; the other selected runtime examples require neither. Do not make OS and runtime axes an automatic cross-product.

### Shared synthetic SSH preparation

Keep synthetic Leia SSH-key preparation in the shared `openclaw-setup` path. It creates an isolated per-job fixture rather than exposing a shared credential. Do not narrow that setup unless repository evidence shows material cost, exposure, or cross-scenario consumption.

### Source test boundaries

Keep source specs flat under `test/`. Select deterministic and read-only contract checks with `test:unit` on Ubuntu, portable `*.component.spec.ts` with `test:component` on Ubuntu, and native `*.os.component.spec.ts` with `test:os` on both supported OSes. Keep mixed specs in the component selection until their unit-shaped cases are extracted. The built memory helper belongs to portable component coverage. Keep the 100,000-entry backup fixture opt-in under `test:stress`; preserve normal PR coverage with bounded filesystem pruning and pure payload/parent-limit checks. `bun run test` remains the fast unit alias; `bun run test:all` covers all ordinary selections and excludes stress. Never remove a component from CI merely by excluding it from the unit glob.
