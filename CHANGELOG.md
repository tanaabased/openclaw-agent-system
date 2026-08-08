## {{ UNRELEASED_VERSION }} - [{{ UNRELEASED_DATE }}]({{ UNRELEASED_LINK }})

- Added the internal Agent System tool registry and runtime with trusted agent binding, pre-credential classification and authorization, sanitized fixed-executable execution, bounded redaction, conditional prompt guidance, and metadata-only audit hooks.
- Added the initial read-only `agent_system_github` authenticated-user tool, strict `github` manifest projection, public `agent-system tool gh` route, packaged `gh` command launcher, and focused 1Password-backed GitHub Actions-only Leia coverage.
- Added schema-owned literal, environment-backed, and environment-binding value kinds, including environment-backed agent names and emails with lazy install-time name resolution.
- Added deterministic executable path projection for OpenClaw exec and local Codex native shell commands, including workspace and packaged bin directories, workspace-relative manifest entries, managed Codex configuration, visible `.gitignore` ownership, drift diagnostics, and installed-agent coverage.
- Added agent-scoped OP credential prompting, environment and stdin input, automatic or exact macOS Keychain, Linux Secret Service, and file-store selection, validation, idempotent removal, and stored-credential install preflight.
- Added ordered, lazy 1Password Environment resolution through canonical `environment.op`, the official JavaScript SDK, value-free diagnostics, and a permanent `OP_SERVICE_ACCOUNT_TOKEN` fallback.
- Added explicit per-agent environment resolution with literal values, restricted host references, required-value checks, and value-free `env` inspection. [#2](https://github.com/tanaabased/openclaw-agent-system/pull/2)
- Added `openclaw agent-system install` to reconcile OpenClaw agent registration and manifest-owned identity. [#2](https://github.com/tanaabased/openclaw-agent-system/pull/2)
- Added `session_start` manifest loading with redacted lifecycle diagnostics. [#2](https://github.com/tanaabased/openclaw-agent-system/pull/2)
- Added strict ordered dotenv loading with workspace containment, deterministic precedence, provenance, and value-free override diagnostics. [#2](https://github.com/tanaabased/openclaw-agent-system/pull/2)
- Added strict workspace manifest discovery, validation, and OpenClaw agent binding. [#2](https://github.com/tanaabased/openclaw-agent-system/pull/2)
- Added the initial Agent System plugin and delivery scaffold. [#1](https://github.com/tanaabased/openclaw-agent-system/pull/1)
