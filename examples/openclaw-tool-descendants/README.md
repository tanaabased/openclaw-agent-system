# OpenClaw Tool Descendants Example

Install agent-bound setup, run one native command automation, and verify that both child processes use managed identities without inheriting the declared GitHub credential.

## What Belongs Here

- Contextual Git/GitHub shims in setup and strict managed launchers in automation.
- Credential-free child environments, setup convergence, and one completed automation execution.

## What Does Not Belong Here

- Ordinary public commands, stdin, and command refusals: [tools](../openclaw-tools/README.md).
- General prompt/command scheduling: [automations](../openclaw-automation-command/README.md).

## Notes

- Direct Ubuntu checks use the Tanaabot identity without a model. The probe requires an active execution capability and rejects inherited GitHub token values before issuing its identity reads.
- Receipts live beside the disposable manifest. Setup and automation use different launcher forms deliberately.

## Setup

```bash
# should install agent-bound setup through the packed plugin
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
cd "$GITHUB_WORKSPACE/examples/openclaw-tool-descendants"
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.stepId == "tool-identity" and .status == "updated")'
```

## Testing

```bash
# should complete setup through bound shims without exposing credentials to its script
cd "$GITHUB_WORKSPACE/examples/openclaw-tool-descendants"
grep -F 'Descendants Tanaabot <tanaabot@tanaab.dev>' setup.git
grep -Fx tanaabot setup.github
test -f setup.complete
test "$(wc -l < setup.runs | tr -d ' ')" = 1
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.stepId == "tool-identity" and .status == "unchanged")'
test "$(wc -l < setup.runs | tr -d ' ')" = 1

# should complete a native automation through strict bound launchers exactly once
openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/openclaw-tool-descendants"
openclaw agent-system automations sync --json | jq -e '.status == "synchronized"'
run_id=$(openclaw agent-system automations run tool-identity --json | jq -er 'select(.status == "queued") | .runId | strings')
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" tool-identity "$run_id"
grep -F 'Descendants Tanaabot <tanaabot@tanaab.dev>' automation.git
grep -Fx tanaabot automation.github
test -f automation.complete
test "$(wc -l < automation.runs | tr -d ' ')" = 1
```
