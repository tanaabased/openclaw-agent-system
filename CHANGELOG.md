## {{ UNRELEASED_VERSION }} - [{{ UNRELEASED_DATE }}]({{ UNRELEASED_LINK }})

- Added agent-scoped OP credential prompting, environment and stdin input, automatic or exact file-store selection, validation, idempotent removal, and stored-credential install preflight.
- Added ordered, lazy 1Password Environment resolution through canonical `environment.op`, the official JavaScript SDK, value-free diagnostics, and a permanent `OP_SERVICE_ACCOUNT_TOKEN` fallback.
- Added explicit per-agent environment resolution with literal values, restricted host references, required-value checks, and value-free `env` inspection. [#2](https://github.com/tanaabased/openclaw-agent-system/pull/2)
- Added `openclaw agent-system install` to reconcile OpenClaw agent registration and manifest-owned identity. [#2](https://github.com/tanaabased/openclaw-agent-system/pull/2)
- Added `session_start` manifest loading with redacted lifecycle diagnostics. [#2](https://github.com/tanaabased/openclaw-agent-system/pull/2)
- Added strict ordered dotenv loading with workspace containment, deterministic precedence, provenance, and value-free override diagnostics. [#2](https://github.com/tanaabased/openclaw-agent-system/pull/2)
- Added strict workspace manifest discovery, validation, and OpenClaw agent binding. [#2](https://github.com/tanaabased/openclaw-agent-system/pull/2)
- Added the initial Agent System plugin and delivery scaffold. [#1](https://github.com/tanaabased/openclaw-agent-system/pull/1)
