# Codex

The standalone Codex plugin provides workspace context, setup, and model routing
from `agent.yaml`. OpenClaw remains the [primary integration](./README.md);
OpenClaw-hosted Codex uses that integration and its managed tools.

## Plugin Installation

Install through [Codex Tools](https://github.com/tanaabased/codex-tools) without a global CLI installation:

```sh
# preview registration and installation.
npx --yes @tanaab/codex-tools install npm:@tanaab/openclaw-agent-system --dry-run --json

# install the plugin.
npx --yes @tanaab/codex-tools install npm:@tanaab/openclaw-agent-system
```

## Workspace Setup

Clone the agent workspace you want to use; this example uses [Me](https://github.com/pirog/me).

```sh
# use your existing checkout if you already have one.
mkdir -p ~/tanaab
git clone https://github.com/pirog/me.git ~/tanaab/me
cd ~/tanaab/me

# copy the absolute path for the binding prompt.
pwd -P
```

Open the checkout as a local project in the Codex app, or run `codex` there.
In Codex CLI with the same profile, use `/hooks` to [review and trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)
the Agent System SessionStart hook, then start a fresh task.

```text
Use $agent-system-codex-binding to bind this plugin to /absolute/path/to/tanaab/me.
```

Confirm the binding, then start a fresh task and run:

```text
If the workspace declares setup, use $agent-system-install to install it.
Then use $agent-system-doctor to check readiness.
```

## Skills

Standalone Codex supports workspace context and [applicable setup steps](./MANIFEST.md#setup).
Git and GitHub use native host commands and authorization.

- [Codex binding](./skills/codex-binding/SKILL.md) — Bind the standalone plugin to one workspace.
- [Doctor](./skills/doctor/SKILL.md) — Inspect readiness without applying repairs.
- [Git CLI](./skills/git-cli/SKILL.md) — Guide native host Git operations.
- [GitHub CLI](./skills/github-cli/SKILL.md) — Guide native host GitHub operations.
- [Install](./skills/install/SKILL.md) — Apply the workspace's Codex setup steps.
- [Model routing](./skills/model-routing/SKILL.md) — Select model and effort candidates for new tasks.

## Model Routing

Configure models and efforts in [`agent.yaml`](./MANIFEST.md#models), then use the
[model routing skill](./skills/model-routing/SKILL.md) for new work. See the
[helper contract](./tools/model-routing/README.md) for runtime mappings, overrides,
and unresolved results.

## Automation Research

Repository-owned automations are not implemented. The proposed shared
[manifest contract](./MANIFEST.md#automation-contract-proposed) is gated by native
support; standalone setup execution does not establish scheduling support.

Evidence as of 2026-09-29:

| Surface                               | Verified evidence                                                                                                                                                                         | Boundary                                                                                                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pinned CLI `0.154.0`                  | Generated App Server JSON Schema, including experimental methods: 159 distinct client request methods; none named automation, cron, or schedule.                                          | No native scheduler reconciliation protocol established for the installer. This is bounded evidence, not a claim about every private desktop API.                                                  |
| App Server `command/exec`             | Schema describes argv execution in the server sandbox without a thread or turn; write, resize, and terminate methods also exist.                                                          | Immediate zero-model execution is available as a protocol primitive. It does not register a native scheduled command.                                                                              |
| Desktop `26.623.141536`, build `4753` | Session-exposed `automation_update` tool describes create, update, view, and delete, active/paused state, project jobs and existing-chat heartbeats. Its create schema requires a prompt. | An agent-facing app tool is not a callable API for `setup install`. List discovery, run-now, stable ownership, conditional updates, and command payloads are not established installer interfaces. |
| Official scheduled-task documentation | Local projects require the app running and the project available; standalone runs and existing-chat targets differ. Default sandbox and unattended approval policy apply.                 | Current documentation is not a version pin or proof of all timeout, overlap, missed-run, DST, or retry semantics.                                                                                  |

To reproduce the protocol inspection with already installed pinned dependencies,
generate into a disposable directory; do not start or connect to an App Server:

```sh
node node_modules/@openai/codex/bin/codex.js app-server generate-json-schema \
  --experimental --out /absolute/path/to/disposable-schema-directory
```

Inspect `ClientRequest.json` method discriminants and `CommandExecParams`. The
research run generated schemas without starting a server, scheduling a job, or
running a command payload. The CLI warned that PATH-alias creation was denied;
schema generation nevertheless exited successfully. No private automation stores
were read or modified. The desktop version was read from application metadata;
the repository does not pin it, and CLI compatibility must not stand in for it.

Official references: [Scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app)
and [App Server](https://learn.chatgpt.com/docs/app-server). Scheduled tasks normally
use `approval_policy = "never"` where organization policy permits; otherwise they
use the selected permission mode's approval behavior. The future adapter must
surface missing unattended authorization without weakening the ambient profile.
It must not introduce managed Codex credentials or convert command jobs into prompts.

#196 remains blocked on a supported installer-to-native-scheduler interface and
proof of the shared semantics. Keep any unsupported-capability result explicit;
do not implement TOML/SQLite editing, UI automation, or an external scheduler as
an adapter substitute.

## Development

From a checkout with [locked dependencies installed](./DEVELOPMENT.md#requirements),
build and install through the pinned development dependency:

```sh
# build the runtime, then preview and install the local plugin.
bun run build
./node_modules/.bin/codex-tools install . --dry-run --json
./node_modules/.bin/codex-tools install .
```

Rebuild after changing the Codex runtime or its imports. For changes to
`.codex-plugin/`, `assets/`, `hooks/`, `package.json`, or `skills/`, sync the
installed cache directly:

```sh
bun run codex:sync
bun run codex:check
```

Start a fresh task to verify skill discovery. `package.json#codexTools.managedPaths`
selects the paths owned by cache synchronization and checks; it does not control
what native Codex copies during installation.

For packaged installation and discovery checks, run `bun run test:codex-plugin`
with `AGENT_SYSTEM_PACKAGE` set to a prepared npm tarball. The release-test
workflow runs this with an isolated Codex home. Other repository checks remain
in [Development](./DEVELOPMENT.md#testing).
