# OpenClaw Workspace Example

Validate a workspace without changing it, then install its ordered setup and
configuration. Repeat installation without changes and use Doctor to inspect both
healthy state and setup drift.

## What Belongs Here

- Validation without host-value resolution, setup execution, or reconciliation.
- Ordered host/agent setup and dotenv resolution producing the installed identity, Codex prerequisite, and model routing.
- Repeat convergence and Doctor inspection without repair or secret-value disclosure.
- Explicit operator reconciliation of an older shared Codex plugin, without replacement by workspace Install.

## What Does Not Belong Here

- Failing setup-child termination, timeout, and detailed diagnostic permutations.
- Gateway agent turns: [agent](../openclaw-agent/README.md). Native OS installation/enrollment: [OS install](../os-install/README.md).
- Standalone Codex binding: [Codex install](../codex-install/README.md).

## Notes

- Host and agent setup checks use argv and command-object forms alongside shell apply scripts; successful setup and convergence exercise all three forms.

- Direct Ubuntu checks need no Gateway, model, or provider credential. The installed name proves environment resolution; direct configuration reads prove routing and the Codex prerequisite.
- Setup writes receipts beside the checked-in manifest on the disposable runner. Independent configuration snapshots prove validation, repeat install, and Doctor leave the relevant state unchanged.
- The upgrade check deliberately installs Codex `2026.10.6` after the missing-plugin path, then explicitly restores the release-owned version. These two extra plugin installs prove the installed conflict/reconciliation boundary without another Gateway or model turn.
- Pending relocation: the final setup-failure fixture verifies safe child termination and diagnostic redaction through the installed CLI.

## Setup

```bash
# should prepare the packed plugin and a disposable declared workspace
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
```

## Testing

```bash
# should validate without resolving host values or running setup or reconciliation
cd "$GITHUB_WORKSPACE/examples/openclaw-workspace"
cp "$OPENCLAW_CONFIG_PATH" "$TMPDIR/workspace-before-validate.json"
env -u AGENT_SYSTEM_WORKSPACE_HOST_NAME openclaw agent-system validate --json | jq -e '.status == "valid" and .agentId == "workspace-tanaabot" and (.checks | any(.component == "setup" and .status == "valid"))'
cmp "$OPENCLAW_CONFIG_PATH" "$TMPDIR/workspace-before-validate.json"
test ! -e host-ready
test ! -e agent-ready
test ! -e setup-runs

# should install ordered setup and resolve environment-backed identity with codex model routing
cd "$GITHUB_WORKSPACE/examples/openclaw-workspace"
export AGENT_SYSTEM_WORKSPACE_HOST_NAME=Workspace
openclaw agent-system install --yes --json | jq -e '(.outcomes | any(.code == "codex-plugin-installed" and .status == "created") and any(.stepId == "host-ready" and .status == "updated") and any(.stepId == "agent-ready" and .status == "updated") and any(.code == "set-agent-models" and .status == "updated"))'
printf 'host\nagent\n' | diff - setup-runs
openclaw config get agents.entries.workspace-tanaabot --json | jq -e '.identity.name == "Workspace Agent" and .model.primary == "openai/gpt-5.4-nano" and .thinkingDefault == "medium" and .models["openai/gpt-5.4-nano"].agentRuntime.id == "codex"'
codex_version=$(node -p 'require(process.argv[1]).openclaw.agentSystem.codexPlugin.split("@").pop()' "$GITHUB_WORKSPACE/package.json")
openclaw plugins inspect codex --json | jq -e --arg version "$codex_version" '.plugin.enabled == true and .plugin.version == $version and .install.version == $version'
openclaw agent-system env --json > "$TMPDIR/workspace-environment.json"
jq -e '.agentId == "workspace-tanaabot" and (.variables | any(.name == "WORKSPACE_NAME" and .source == "environment.set" and .required == true) and any(.name == "WORKSPACE_SUFFIX" and .source == "environment.dotenv[1]" and (.overriddenSources | length) == 1)) and ([.. | objects | has("values")] | all(. == false))' "$TMPDIR/workspace-environment.json"
if grep -Fq 'workspace-private-value' "$TMPDIR/workspace-environment.json"; then exit 1; fi

# should leave converged setup model routing and shared prerequisite unchanged on repeat install
cd "$GITHUB_WORKSPACE/examples/openclaw-workspace"
export AGENT_SYSTEM_WORKSPACE_HOST_NAME=Workspace
cp "$OPENCLAW_CONFIG_PATH" "$TMPDIR/workspace-before-repeat.json"
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.code == "codex-plugin-unchanged" and .status == "unchanged") and any(.stepId == "host-ready" and .status == "unchanged") and any(.stepId == "agent-ready" and .status == "unchanged") and any(.code == "agent-models-unchanged" and .status == "unchanged")'
cmp "$OPENCLAW_CONFIG_PATH" "$TMPDIR/workspace-before-repeat.json"
printf 'host\nagent\n' | diff - setup-runs

# should refuse an older shared codex plugin without replacing it
cd "$GITHUB_WORKSPACE/examples/openclaw-workspace"
export AGENT_SYSTEM_WORKSPACE_HOST_NAME=Workspace
openclaw plugins install npm:@openclaw/codex@2026.10.6 --force --pin --accept-capabilities
cp "$OPENCLAW_CONFIG_PATH" "$TMPDIR/workspace-before-conflict.json"
if output=$(openclaw agent-system install --yes --json); then exit 1; fi
printf '%s\n' "$output" | jq -e '.blocked.code == "codex-plugin-conflict" and (.blocked.message | contains("2026.10.6") and contains("explicitly reconcile"))'
cmp "$OPENCLAW_CONFIG_PATH" "$TMPDIR/workspace-before-conflict.json"
openclaw plugins inspect codex --json | jq -e '.plugin.version == "2026.10.6" and .install.version == "2026.10.6"'

# should converge after explicit operator reconciliation of the shared codex plugin
cd "$GITHUB_WORKSPACE/examples/openclaw-workspace"
export AGENT_SYSTEM_WORKSPACE_HOST_NAME=Workspace
codex_spec=$(node -p 'require(process.argv[1]).openclaw.agentSystem.codexPlugin' "$GITHUB_WORKSPACE/package.json")
openclaw plugins install "npm:$codex_spec" --force --pin --accept-capabilities
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.code == "codex-plugin-unchanged" and .status == "unchanged")'

# should inspect healthy state and setup drift without applying repairs
cd "$GITHUB_WORKSPACE/examples/openclaw-workspace"
export AGENT_SYSTEM_WORKSPACE_HOST_NAME=Workspace
cp "$OPENCLAW_CONFIG_PATH" "$TMPDIR/workspace-before-doctor.json"
openclaw agent-system doctor --json | tee "$TMPDIR/workspace-doctor.json"
jq -e '.status == "healthy" and (.findings | any(.code == "codex-plugin-ready" and .status == "healthy") and any(.component == "models") and all(.[] | select(.component == "models"); (.code == "agent-models-ready" and .status == "healthy") or (.code == "agent-model-unavailable" and .status == "warning")) and any(.stepId == "host-ready" and .status == "healthy") and any(.stepId == "agent-ready" and .status == "healthy"))' "$TMPDIR/workspace-doctor.json"
rm agent-ready
if output=$(openclaw agent-system doctor --json); then exit 1; fi
printf '%s\n' "$output" | tee "$TMPDIR/workspace-doctor-drift.json"
printf '%s\n' "$output" | jq -e '.findings | any(.stepId == "agent-ready" and .code == "setup-drift" and .status == "drift")'
test ! -e agent-ready
printf 'host\nagent\n' | diff - setup-runs
cmp "$OPENCLAW_CONFIG_PATH" "$TMPDIR/workspace-before-doctor.json"

# should report safe setup termination through the installed cli without leaking child output
cd "$GITHUB_WORKSPACE/examples/openclaw-workspace"
export AGENT_SYSTEM_WORKSPACE_HOST_NAME=Workspace
cp setup.yaml "$TMPDIR/workspace-setup-before-failure.yaml"
trap 'cp "$TMPDIR/workspace-setup-before-failure.yaml" setup.yaml' EXIT
cp setup-failure.yaml setup.yaml
if output=$(openclaw agent-system install --yes --json 2> "$TMPDIR/workspace-install-failure.stderr"); then exit 1; fi
printf '%s\n' "$output" | jq -e '.blocked.code == "setup-apply-failed" and .blocked.stepId == "diagnostic-failure" and (.blocked.message | contains("setup-agent") and contains("apply") and contains("exit code 23"))'
if printf '%s\n' "$output" | grep -Fq 'workspace-private-value'; then exit 1; fi
if grep -Fq 'workspace-private-value' "$TMPDIR/workspace-install-failure.stderr"; then exit 1; fi
```
