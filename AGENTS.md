# Agent System Agent Guidance

## Scope

- Keep the OpenClaw plugin entrypoint at `index.ts`; do not add a generic `src/` directory.
- Keep one implementation file per OpenClaw subcommand in `cli/`, CLI registration and product orchestration in `lib/`, independently testable functions in `utils/`, repository automation in `scripts/`, and flat behavior-focused specs in `test/`.
- Treat `SPEC.md` as product intent, not evidence that a feature has been implemented.

## Documentation

- Keep `README.md` focused on installation, the common manifest workflow, and first verification.
- Put complete manifest, logging, and CLI reference material in `ADVANCED.md`.
- Put source installation, DevGuard usage, validation, and coding standards in `DEVELOPMENT.md`.
- Treat `SPEC.md` as product intent and `CHANGELOG.md` as the record of implemented changes.

## Identity and configuration

- Keep the npm identity `@tanaab/openclaw-agent-system`, OpenClaw plugin id `agent-system`, and display name `Agent System` as separate contracts.
- Keep `openclaw agent-system` canonical and `openclaw as` as its tested alias.
- Use kebab-case for schema-owned YAML keys and camelCase inside TypeScript.
- Keep `utils/encode.ts` and `utils/decode.ts` faithful to their Core Next behavior. Apply them through schema-aware callers; never deep-convert literal data maps such as environment-variable names or user-defined identifiers.

## OpenClaw integration

- Use stable `openclaw/plugin-sdk/*` exports and inspect the installed SDK contract before adding new plugin surfaces.
- Keep the Node-targeted build's package dependencies external.
- Do not run direct OpenClaw installation, plugin, or Gateway commands as routine repository validation; the GitHub Actions-only Leia scenarios under `examples/` are the operational exception.

## Accepted optimization decisions

- Keep release package inspection, npm publication, and ClawHub publication as separate pack operations. Exact tarball byte reuse across those paths is not an owned requirement. Each path must still originate from the same prepared release version and keep package contents, plugin metadata, compatibility, tags, source repository, and source commit aligned. Do not recommend unifying the archives unless repository evidence shows those contracts have diverged.
- Keep one `pr-examples-tests.yml` matrix and scope shared test credentials to the final Leia execution step even though every matrix entry receives that step environment. Only the `agent` and `path` scenarios may consume OpenAI credentials and model selection, and only the `env` and `credentials` scenarios may consume `OP_SERVICE_ACCOUNT_TOKEN`. Do not recommend separate jobs or per-entry environment injection solely to narrow either credential; still report workflow- or job-level exposure, logged or tracked credentials, or consumption by a non-owning scenario.

## Validation

- Keep Mocha `describe` and `it` descriptions fully lowercase. Preserve required casing only in test inputs, commands, and expected contract values.
- Run `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, and `bun run plugin:check` for implementation changes.
- Run `bun run test:release` when package contents, compatibility metadata, or release wiring change.
- When behavior crosses installed-plugin, public CLI, Gateway, agent, or hook boundaries, add or update the owning Leia scenario and its example matrix entry; keep detailed scenario rules in `examples/AGENTS.md`.
- Never run Leia scenarios or other operational tests from `examples/` locally. They are GitHub Actions-only, including when isolated state would be available.
- Keep live OpenClaw validation isolated and explicitly requested; repository checks must not mutate the user's normal OpenClaw state.
