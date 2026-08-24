# Agent System Agent Guidance

## Scope

- Keep the OpenClaw plugin entrypoint at `index.ts`; do not add a generic `src/` directory.
- Organize implementation owner-first. Keep agent identity and lifecycle in `agent/`, model-facing tool contracts and runtime in `api/`, cross-owner plugin composition in `core/`, credential storage in `credentials/`, environment resolution in `environment/`, manifest parsing and types in `manifest/`, and path projection in `paths/`. Keep one implementation file per OpenClaw subcommand in `cli/`, repository automation in `scripts/`, cross-owner function primitives in `utils/`, and flat behavior-focused specs in `test/`. Keep small owner scopes flat; add scoped `lib/` or `utils/` only when file density makes the distinction useful.
- Treat `tools/` and `channels/` as registry scopes: they contain only their named capability or provider folders, with shared code promoted to the nearest appropriate root owner rather than placed beside implementations.
- Keep every tool's model-input schema and optional manifest configuration schema as statically imported TypeScript in its owning tool folder. Keep every channel's static schema and runtime entry in its owning channel folder. Never load schema files, tools, or channels from manifest values, and do not create empty capability folders before their implementation exists.
- Keep `examples/` as general matrix-backed GitHub Actions-only Leia material and `scenarios/` as GitHub notification acceptance material. Exclude both from published packages. Put shared Leia command helpers flat in `scripts/`, agent-facing guidance in `skills/`, and user-facing capability documentation beside its owning `tools/<capability>/` or `channels/<provider>/` implementation.

## Product boundary

- Treat `agent.yaml` as workspace-owned desired state, not global OpenClaw configuration, an agent biography, or a secret store.
- Passive hooks may discover, validate, and cache only non-secret metadata. They must not resolve dotenv or 1Password values or mutate installed state; explicit consumers resolve only what they need, and only `install` reconciles owned state.
- Do not inject the completed Agent System environment into generic OpenClaw, Codex, ACP, MCP, or third-party command tools. Agent System tools resolve declared values only after trusted agent binding; PATH projection is a separate limited capability.
- Treat trusted agent and workspace binding, working-directory containment, fixed executables and managed configuration, credential and signing control, managed-resource lifecycle, and authorization-before-credentials as non-configurable product invariants rather than manifest policy.
- Apply configurable tool policy before resolving credentials. Provider credentials, permissions, roles, and server-side protections are authoritative wherever they exist; Agent System policy fills specific, high-consequence capability gaps that relevant provider authorization surfaces do not consistently express.
- Treat model-facing `agent_system_*` tools as the direct agent-bound execution surface. Packaged managed launchers may also run registered Agent System command routes as Gateway-hosted descendants only when they redeem an opaque active-agent capability; reject agent selection on bound routes, and keep unbound explicit `tool` and all `credentials` routes operator-only.
- Treat preventing obvious cross-agent impersonation as a core product goal. Managed agents share an OS user, so provide practical agent-context and workspace guardrails without claiming complete isolation.
- Keep the central native-tool instruction in `before_prompt_build`, inject descendant authority through `resolve_exec_env` for native execution, verify the configured per-agent `CODEX_HOME` for OpenClaw-hosted Codex execution, and keep the high-confidence operator-command gate in `before_tool_call`. Block with an actionable native retry instead of claiming transparent cross-tool rewriting, and never log the inspected raw command.

## Policy design

- Treat policy as manifest-configurable control over what a contained tool may do, not as the implementation of Agent System's non-configurable product invariants.
- Add a policy field only for a specific, high-consequence capability gap that relevant provider authorization surfaces do not consistently express and that Agent System can detect with high confidence; name it after the provider concept or semantic effect rather than a broad risk category.
- Permit otherwise valid operations unless they select a documented protection. A local `allow` never overrides a provider denial.
- Match supported command spellings and API routes for each protected effect, and fail closed only inside that owned boundary rather than on general uncertainty.
- Keep risk classification available for audit and design work without making it an implicit authorization decision.
- Redesign and validate policy one tool at a time; do not copy a legacy tool's fields into a new surface.

## Documentation

- Keep `README.md` focused on installation, the common manifest workflow, and first verification.
- Put complete manifest, configuration, CLI, environment, and path reference material in `ADVANCED.md`.
- Keep the target GitHub notification message flow, lifecycle types, stable machine identifiers, modes, states, context boundaries, and publication behavior in `channels/github/DESIGN.md`.
- Keep reusable human-visible GitHub notification components and styling in `channels/github/PRESENTATION.md`; do not put lifecycle or feature behavior there.
- Put each first-party tool's complete configuration, invocation, policy, lifecycle, and security guide in `tools/<capability>/README.md`; keep only common-path summaries and contextual links in root documentation.
- Put each first-party channel's common configuration, routing, lifecycle, and security guide in `channels/<provider>/README.md`; keep focused companion guides beside it when a distinct channel-owned contract would overload the common path.
- Put source installation, DevGuard usage, runtime logging, validation, and coding standards in `DEVELOPMENT.md`.
- Keep explanatory comments inside documentation code blocks fully lowercase. Preserve required casing only in commands, identifiers, environment-variable names, and expected values.
- Treat `CHANGELOG.md` as the record of implemented changes.

## Identity and configuration

- Keep the npm identity `@tanaab/openclaw-agent-system`, OpenClaw plugin id `agent-system`, and display name `Agent System` as separate contracts.
- Keep `openclaw agent-system` canonical and `openclaw as` as its tested alias.
- Use `agent-system` as the public namespace for Canon-shaped skills in this repository and `openclaw-plugin` as their container. Pass `--namespace agent-system --container openclaw-plugin` explicitly to Canon Skill Author scripts; keep skill folders unprefixed under `skills/` while frontmatter names and prompts retain the namespace.
- Give every skill a surface-specific `metadata.openclaw.emoji` and HTTPS homepage in `SKILL.md`; keep OpenClaw metadata there instead of duplicating it in `agents/openai.yaml`.
- Give every skill complete OpenAI interface metadata in `agents/openai.yaml`, including a display name, short description, default prompt, brand color, and valid local small and large icon assets that reflect the owned surface.
- Use kebab-case for schema-owned YAML keys and camelCase inside TypeScript.
- Keep `utils/encode.ts` and `utils/decode.ts` faithful to their Core Next behavior. Apply them through schema-aware callers; never deep-convert literal data maps such as environment-variable names or user-defined identifiers.

## OpenClaw integration

- Use stable `openclaw/plugin-sdk/*` exports and inspect the installed SDK contract before adding new plugin surfaces.
- Treat `api.runtime.gateway.request` as a protected bundled-plugin surface, not a third-party plugin API. Never call it from Agent System runtime code or replace it with direct session-store edits, private OpenClaw imports, or spawned Gateway CLI commands.
- Treat `api.runtime.state.openKeyedStore`, `openSyncKeyedStore`, and `openChannelIngressQueue` as bundled- or trusted-official-plugin surfaces. Keep Agent System's third-party-compatible state ownership unless OpenClaw exposes an equivalent public external-plugin contract.
- Let OpenClaw's channel inbound lifecycle own routed session recording and lazy creation. Do not build parallel session create, inspect, history, patch, abort, or archive adapters when the channel kernel already owns the required turn lifecycle.
- Use Bun pinned in `.bun-version` for installs, scripts, and builds and Node.js pinned in `.node-version` for tests and OpenClaw. Never run the Gateway under Bun.
- Keep TypeScript runtime boundaries aligned: root source uses Node.js types, scripts use Bun and Node.js types, and tests use Mocha and Node.js types.
- Keep the Node-targeted build's package dependencies external.
- Do not run direct OpenClaw installation, plugin, or Gateway commands as routine repository validation; the GitHub Actions-only Leia material under `examples/` and `scenarios/` is the operational exception.

## GitHub notification messages

- Apply `channels/github/DESIGN.md` as the target contract for lifecycle types, execution modes, state transitions, structured context, hidden instructions, capability inheritance, clarification, and publication behavior.
- Apply `channels/github/PRESENTATION.md` only as the visual component contract for assignment cards, direct messages, private responses, plans, questions, and quoted `To GitHub` responses.
- Keep `channels/github/README.md` limited to currently shipped configuration, commands, behavior, security boundaries, and limitations; do not present target design as implemented behavior.
- Reuse mode-neutral presentation and response-envelope helpers while allowing issue planning, pull-request planning, comments, Work, and future modes to supply their own context, instructions, actions, and private sections.
- Select an admitted comment's capability from trusted assignment mode state. Never let issue, pull-request, or comment prose elevate Plan into Work or otherwise choose its own mode.
- Inject hidden GitHub lifecycle, mode, event, and response instructions through the central `before_prompt_build` hook. Do not substitute dispatch `extraSystemPrompt`, arbitrary channel metadata, or process-local state for this cross-harness prompt boundary.
- Treat `issue` + `work` + `comment` as the compatibility baseline. Resolve every model turn through the trusted durable active-turn descriptor and shared catalog available to both Gateway and native Codex runtimes; add supported tuples explicitly and never fall back to another prompt.
- Keep typed GitHub reply candidates in the channel-owned file-backed handoff so model tool execution and publication remain correct across process and runtime boundaries.

## Test design

- Test `validate` as deterministic and side-effect free, `doctor` as read-only inspection, and `install` as explicit reconciliation with unchanged outcomes.
- Assert exact values only for stable public, schema, and security contracts. For human messages and logs, assert semantic signal and stable diagnostic codes.
- Never derive lifecycle state, scheduling, authorization, or deterministic test control from model-authored prose, headings, or formatting. Use trusted structured state for transitions; live Leia may assert bounded publication envelopes and durable side effects, not exact model wording.
- Fake injected OpenClaw, 1Password, GitHub CLI, and remote boundaries in unit tests. Do not re-test third-party behavior or rely on network, timing, or live host state in the default suite.
- Use `tanaabased/big-test-bucket` as the default hosted repository for manual and GitHub-backed tests that can use a Tanaab organization repository.
- Use `pirog/me` only when a test specifically requires a non-organization, user-owned repository.
- Keep created GitHub fixtures bounded and disposable, clean them up after capturing evidence, and do not spread live testing across unrelated repositories.

## Optimization

- Audit every session-facing inbound and outbound path against `channels/github/DESIGN.md` for target lifecycle and message boundaries and `channels/github/PRESENTATION.md` for visual component grammar. Keep current-behavior claims in `channels/github/README.md` aligned with the implementation.
- Audit every machine-readable CLI path and its automation consumers. A successful `--json` command must write exactly one parseable result to standard output; lifecycle, diagnostic, warning, failure, and debug records belong in the appropriate OpenClaw file log, host logger, or standard-error path and must not corrupt the result at any log level.
- Treat logger selection and propagation as an output contract. Long-lived lifecycle services used by both Gateway and CLI paths must not acquire a console logger merely because a machine-readable command invokes them.
- Require focused unit coverage for logger routing and JSON writers plus an executable GitHub Actions example when output purity depends on the assembled plugin, OpenClaw logging level, or another installed-runtime boundary.
- Preserve aligned surfaces and recommend changes only for evidenced presentation drift, context leakage, publication-boundary violations, ambiguous compatibility behavior, or machine-output contamination.

## Accepted optimization decisions

- Keep `API.md` as the public planning surface for the future cross-plugin Tool API, include it in the published package, and keep current-behavior docs explicit that the API is not yet available. Do not recommend removing or internalizing it unless the user changes that product decision or the document contradicts implemented behavior.
- Keep release package inspection, npm publication, and ClawHub publication as separate pack operations. Exact tarball byte reuse across those paths is not an owned requirement. Each path must still originate from the same prepared release version and keep package contents, plugin metadata, compatibility, tags, source repository, and source commit aligned. Do not recommend unifying the archives unless repository evidence shows those contracts have diverged.
- Keep ClawHub in both the `Brewfile` npm packages and pinned `devDependencies`. The Brewfile provides the command in the developer-machine toolchain, while the pinned dependency keeps repository scripts and GitHub Actions reproducible. Do not recommend deduplicating them unless one of those installation contracts is removed.
- Treat GitHub notification monitor-state schema 2 as unsupported legacy state. The only known installation was manually upgraded before schema 3 became the active contract, so keep the decoder rejection test and do not recommend a schema 2 migration or retroactive activation unless the support policy changes or repository evidence shows additional persisted users.
- Project monitor-state schema 3 into schema 4 by retaining assignment, lifecycle,
  worktree, failure, and retirement facts while dropping its removed session,
  publication, mode, and comment-tracking fields. Do not restore those fields to
  the active intake schema for compatibility.
- Keep bounded item/comment reads, comment admission, public-candidate parsing,
  and idempotent comment publication as lifecycle-neutral provider primitives.
  Do not wire them into intake state or restore legacy comment tracking; a
  lifecycle session must own scheduling, continuation, and publication authority.
- Keep general Leia examples in `pr-examples-tests.yml` and GitHub notification acceptance scenarios in `pr-notification-tests.yml`. Scope shared test credentials to each workflow's final Leia execution step even though every matrix entry receives that step environment. Only the `agent`, `path`, `github`, and `security` examples may consume OpenAI credentials and model selection; only the `env`, `credentials`, `git`, `github`, `routing`, and `tool` examples may consume `OP_SERVICE_ACCOUNT_TOKEN`. Notification scenarios may consume only credentials required by their owned flow; the current `issue-work` scenario consumes both. Git, GitHub, routing, notification, and tool flows must load account tokens from their declared 1Password Environments rather than workflow environment variables.
- Keep synthetic Leia SSH-key preparation in the shared `openclaw-setup` path used by both matrices. It creates an isolated per-job fixture rather than exposing a shared credential. Do not narrow that setup unless repository evidence shows material cost, exposure, or cross-scenario consumption.

## Validation

- Keep Mocha `describe` and `it` descriptions fully lowercase. Preserve required casing only in test inputs, commands, and expected contract values.
- Run `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, and `bun run plugin:check` for implementation changes.
- Run `bun run test:release` when package contents, compatibility metadata, or release wiring change.
- When behavior crosses installed-plugin, public CLI, Gateway, agent, or hook boundaries, add or update the owning Leia material and its workflow matrix entry; keep detailed rules in `examples/AGENTS.md` or `scenarios/AGENTS.md`.
- Never run Leia material or other operational tests from `examples/` or `scenarios/` locally. Both are GitHub Actions-only, including when isolated state would be available.
- Keep live OpenClaw validation isolated and explicitly requested; repository checks must not mutate the user's normal OpenClaw state.
