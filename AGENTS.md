# Agent System Agent Guidance

## Scope

- Keep the OpenClaw plugin entrypoint at `index.ts`; do not add a generic `src/` directory.
- Keep one implementation file per OpenClaw subcommand in `cli/`, CLI registration and shared product orchestration in `lib/`, independently testable functions in `utils/`, first-party OpenClaw tool capabilities in `tools/<capability>/`, repository automation in `scripts/`, and flat behavior-focused specs in `test/`.
- Keep every tool's model-input schema and optional manifest configuration schema as statically imported TypeScript in its owning tool folder. Never load schema files or tool modules from manifest values, and do not create empty tool folders before their implementation exists.
- Keep `examples/` as matrix-backed GitHub Actions-only Leia material and exclude it from published packages. Put agent-facing guidance in `skills/` and user-facing tool documentation beside `tools/<capability>/`.
- Treat `SPEC.md` as product intent, not evidence that a feature has been implemented.

## Product boundary

- Treat `agent.yaml` as workspace-owned desired state, not global OpenClaw configuration, an agent biography, or a secret store.
- Passive hooks may discover, validate, and cache only non-secret metadata. They must not resolve dotenv or 1Password values or mutate installed state; explicit consumers resolve only what they need, and only `install` reconciles owned state.
- Do not inject the completed Agent System environment into generic OpenClaw, Codex, ACP, MCP, or third-party command tools. Agent System tools resolve declared values only after trusted agent binding; PATH projection is a separate limited capability.
- Apply tool policy and approval before resolving credentials. Remote-service token permissions remain the final authorization boundary.
- Treat model-facing `agent_system_*` tools as the agent-bound execution surface. Treat `tool`, `credentials`, and packaged shims as trusted operator interfaces; never claim their agent selection or PATH routing enforces cross-agent isolation.

## Documentation

- Keep `README.md` focused on installation, the common manifest workflow, and first verification.
- Put complete manifest, configuration, CLI, environment, and path reference material in `ADVANCED.md`.
- Put each first-party tool's complete configuration, invocation, policy, lifecycle, and security guide in `tools/<capability>/README.md`; keep only common-path summaries and contextual links in root documentation.
- Put source installation, DevGuard usage, runtime logging, validation, and coding standards in `DEVELOPMENT.md`.
- Keep explanatory comments inside documentation code blocks fully lowercase. Preserve required casing only in commands, identifiers, environment-variable names, and expected values.
- Treat `SPEC.md` as product intent and `CHANGELOG.md` as the record of implemented changes.

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
- Use Bun pinned in `.bun-version` for installs, scripts, and builds and Node.js pinned in `.node-version` for tests and OpenClaw. Never run the Gateway under Bun.
- Keep TypeScript runtime boundaries aligned: root source uses Node.js types, scripts use Bun and Node.js types, and tests use Mocha and Node.js types.
- Keep the Node-targeted build's package dependencies external.
- Do not run direct OpenClaw installation, plugin, or Gateway commands as routine repository validation; the GitHub Actions-only Leia scenarios under `examples/` are the operational exception.

## Test design

- Test `validate` as deterministic and side-effect free, `doctor` as read-only inspection, and `install` as explicit reconciliation with unchanged outcomes.
- Assert exact values only for stable public, schema, and security contracts. For human messages and logs, assert semantic signal and stable diagnostic codes.
- Fake injected OpenClaw, 1Password, GitHub CLI, and remote boundaries in unit tests. Do not re-test third-party behavior or rely on network, timing, or live host state in the default suite.

## Accepted optimization decisions

- Keep release package inspection, npm publication, and ClawHub publication as separate pack operations. Exact tarball byte reuse across those paths is not an owned requirement. Each path must still originate from the same prepared release version and keep package contents, plugin metadata, compatibility, tags, source repository, and source commit aligned. Do not recommend unifying the archives unless repository evidence shows those contracts have diverged.
- Keep one `pr-examples-tests.yml` matrix and scope shared test credentials to the final Leia execution step even though every matrix entry receives that step environment. Only the `agent`, `path`, and `github` scenarios may consume OpenAI credentials and model selection; only the `env`, `credentials`, `git`, `github`, and `tool` scenarios may consume `OP_SERVICE_ACCOUNT_TOKEN`. The Git, GitHub, and tool scenarios must load account tokens from their declared 1Password Environments rather than workflow environment variables. Do not recommend separate jobs or per-entry environment injection solely to narrow those credentials; still report workflow- or job-level exposure, logged or tracked credentials, or consumption by a non-owning scenario.
- Keep the synthetic Leia SSH-key preparation shared across the `pr-examples-tests.yml` matrix. It creates an isolated per-job fixture rather than exposing a shared credential, and preserving one uniform workflow path is preferred over conditionally gating it to the Git scenario. Do not recommend narrowing this setup unless repository evidence shows material cost, exposure, or cross-scenario consumption.

## Validation

- Keep Mocha `describe` and `it` descriptions fully lowercase. Preserve required casing only in test inputs, commands, and expected contract values.
- Run `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, and `bun run plugin:check` for implementation changes.
- Run `bun run test:release` when package contents, compatibility metadata, or release wiring change.
- When behavior crosses installed-plugin, public CLI, Gateway, agent, or hook boundaries, add or update the owning Leia scenario and its example matrix entry; keep detailed scenario rules in `examples/AGENTS.md`.
- Never run Leia scenarios or other operational tests from `examples/` locally. They are GitHub Actions-only, including when isolated state would be available.
- Keep live OpenClaw validation isolated and explicitly requested; repository checks must not mutate the user's normal OpenClaw state.
