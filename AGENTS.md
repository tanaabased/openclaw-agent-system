# Agent System Agent Guidance

## Scope

- Keep the OpenClaw plugin entrypoint at `index.ts`; do not add a generic `src/` directory.
- Keep one implementation file per OpenClaw subcommand in `cli/`, CLI registration and shared product orchestration in `lib/`, independently testable functions in `utils/`, first-party OpenClaw tool capabilities in `tools/<capability>/`, first-party channel capabilities in `channels/<provider>/`, repository automation in `scripts/`, and flat behavior-focused specs in `test/`.
- Keep every tool's model-input schema and optional manifest configuration schema as statically imported TypeScript in its owning tool folder. Keep every channel's static schema and runtime entry in its owning channel folder. Never load schema files, tools, or channels from manifest values, and do not create empty capability folders before their implementation exists.
- Keep `examples/` as matrix-backed GitHub Actions-only Leia material and exclude it from published packages. Put agent-facing guidance in `skills/` and user-facing capability documentation beside its owning `tools/<capability>/` or `channels/<provider>/` implementation.

## Product boundary

- Treat `agent.yaml` as workspace-owned desired state, not global OpenClaw configuration, an agent biography, or a secret store.
- Passive hooks may discover, validate, and cache only non-secret metadata. They must not resolve dotenv or 1Password values or mutate installed state; explicit consumers resolve only what they need, and only `install` reconciles owned state.
- Do not inject the completed Agent System environment into generic OpenClaw, Codex, ACP, MCP, or third-party command tools. Agent System tools resolve declared values only after trusted agent binding; PATH projection is a separate limited capability.
- Treat trusted agent and workspace binding, working-directory containment, fixed executables and managed configuration, credential and signing control, managed-resource lifecycle, and authorization-before-credentials as non-configurable product invariants rather than manifest policy.
- Apply configurable tool policy before resolving credentials. Provider credentials, permissions, roles, and server-side protections are authoritative wherever they exist; Agent System policy fills specific, high-consequence capability gaps that relevant provider authorization surfaces do not consistently express.
- Treat model-facing `agent_system_*` tools as the agent-bound execution surface. Treat `tool`, `credentials`, and packaged shims as trusted operator interfaces; never claim their agent selection or PATH routing enforces cross-agent isolation.
- Treat preventing obvious cross-agent impersonation as a core product goal. Managed agents share an OS user, so provide practical agent-context and workspace guardrails without claiming complete isolation.
- Keep the central native-tool instruction in `before_prompt_build` and the high-confidence operator-command gate in `before_tool_call`. Block with an actionable native retry instead of claiming transparent cross-tool rewriting, and never log the inspected raw command.

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
- Put each first-party tool's complete configuration, invocation, policy, lifecycle, and security guide in `tools/<capability>/README.md`; keep only common-path summaries and contextual links in root documentation.
- Put each first-party channel's complete configuration, routing, lifecycle, and security guide in `channels/<provider>/README.md`.
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
- Do not run direct OpenClaw installation, plugin, or Gateway commands as routine repository validation; the GitHub Actions-only Leia scenarios under `examples/` are the operational exception.

## Test design

- Test `validate` as deterministic and side-effect free, `doctor` as read-only inspection, and `install` as explicit reconciliation with unchanged outcomes.
- Assert exact values only for stable public, schema, and security contracts. For human messages and logs, assert semantic signal and stable diagnostic codes.
- Fake injected OpenClaw, 1Password, GitHub CLI, and remote boundaries in unit tests. Do not re-test third-party behavior or rely on network, timing, or live host state in the default suite.

## Accepted optimization decisions

- Keep `API.md` as the public planning surface for the future cross-plugin Tool API, include it in the published package, and keep current-behavior docs explicit that the API is not yet available. Do not recommend removing or internalizing it unless the user changes that product decision or the document contradicts implemented behavior.
- Keep release package inspection, npm publication, and ClawHub publication as separate pack operations. Exact tarball byte reuse across those paths is not an owned requirement. Each path must still originate from the same prepared release version and keep package contents, plugin metadata, compatibility, tags, source repository, and source commit aligned. Do not recommend unifying the archives unless repository evidence shows those contracts have diverged.
- Keep ClawHub in both the `Brewfile` npm packages and pinned `devDependencies`. The Brewfile provides the command in the developer-machine toolchain, while the pinned dependency keeps repository scripts and GitHub Actions reproducible. Do not recommend deduplicating them unless one of those installation contracts is removed.
- Keep one `pr-examples-tests.yml` matrix and scope shared test credentials to the final Leia execution step even though every matrix entry receives that step environment. Only the `agent`, `path`, `github`, `notifications`, and `security` scenarios may consume OpenAI credentials and model selection; only the `env`, `credentials`, `git`, `github`, `routing`, `notifications`, and `tool` scenarios may consume `OP_SERVICE_ACCOUNT_TOKEN`. The Git, GitHub, routing, notifications, and tool scenarios must load account tokens from their declared 1Password Environments rather than workflow environment variables. Do not recommend separate jobs or per-entry environment injection solely to narrow those credentials; still report workflow- or job-level exposure, logged or tracked credentials, or consumption by a non-owning scenario.
- Keep the synthetic Leia SSH-key preparation shared across the `pr-examples-tests.yml` matrix. It creates an isolated per-job fixture rather than exposing a shared credential, and preserving one uniform workflow path is preferred over conditionally gating it to the Git scenario. Do not recommend narrowing this setup unless repository evidence shows material cost, exposure, or cross-scenario consumption.

## Validation

- Keep Mocha `describe` and `it` descriptions fully lowercase. Preserve required casing only in test inputs, commands, and expected contract values.
- Run `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, and `bun run plugin:check` for implementation changes.
- Run `bun run test:release` when package contents, compatibility metadata, or release wiring change.
- When behavior crosses installed-plugin, public CLI, Gateway, agent, or hook boundaries, add or update the owning Leia scenario and its example matrix entry; keep detailed scenario rules in `examples/AGENTS.md`.
- Never run Leia scenarios or other operational tests from `examples/` locally. They are GitHub Actions-only, including when isolated state would be available.
- Keep live OpenClaw validation isolated and explicitly requested; repository checks must not mutate the user's normal OpenClaw state.
