# Codex

Agent System's standalone Codex plugin provides workspace context, setup, and
model routing from the shared `agent.yaml`. OpenClaw remains the primary
integration; start with the [README](./README.md) for its full lifecycle.

This guide covers standalone Codex. Codex running as an OpenClaw agent harness
uses the OpenClaw integration and its managed tools instead.

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

- [Doctor](./skills/doctor/SKILL.md) — Inspect readiness without applying repairs.
- [Install](./skills/install/SKILL.md) — Apply the workspace's Codex setup steps.
- [Git CLI](./skills/git-cli/SKILL.md) — Guide native host Git operations.
- [GitHub CLI](./skills/github-cli/SKILL.md) — Guide native host GitHub operations.
- [Codex binding](./skills/codex-binding/SKILL.md) — Bind the standalone plugin to one workspace.
- [Model routing](./skills/model-routing/SKILL.md) — Select model and effort candidates for new tasks.

## Model Routing

Configure models and efforts in [`agent.yaml`](./MANIFEST.md#models), then use the
[model routing skill](./skills/model-routing/SKILL.md) for new work. See the
[helper contract](./tools/model-routing/README.md) for runtime mappings, overrides,
and unresolved results.

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
