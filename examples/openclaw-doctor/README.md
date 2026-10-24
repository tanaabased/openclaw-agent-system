# OpenClaw Doctor Example

Inspect a healthy installed agent, introduce one identity drift, detect it through read-only Doctor with a failing status, repair it through Install, and verify healthy state again.

## What Belongs Here

- Meaningful healthy inspection through public commands and structured output.
- Drift detection without implicit repair, followed by explicit reconciliation and a healthy result.
- The installed CLI boundary; one representative path is enough to prove diagnosis and repair.

## What Does Not Belong Here

- Native installation/enrollment differences: [OS install](../os-install/README.md). Workspace setup and convergence: [workspace](../openclaw-workspace/README.md).
- Identity rename/rotation, exhaustive help/alias/presentation variants, and native tool-grant reconciliation. Tool grants belong to [tool access](../openclaw-tool-access/README.md); ordinary tool execution belongs to [tools](../openclaw-tools/README.md).

## Notes

- Direct checks install the prepared package without a model, Gateway, or provider credential. Workspaces run in place.
- Pending relocation: command-tree/alias and warning-layout checks and installation identity administration remain below.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE"

# should install the disposable doctor workspace through agent system
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
openclaw agent-system install
```

## Testing

```bash
# should expose the canonical command tree and its alias
openclaw agent-system --help | grep -F 'validate'
openclaw as --help | grep -F 'validate'

# should preserve installation identity through install and allow explicit rename and rotation
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
openclaw agent-system instance inspect --json > "$TMPDIR/doctor-instance.json"
original=$(jq -er .instanceId "$TMPDIR/doctor-instance.json")
openclaw agent-system install --json | jq -e 'any(.outcomes[]; .component == "instance-identity" and .status == "unchanged")'
openclaw agent-system instance rename 'Doctor Laptop' --json | jq -e --arg id "$original" '.instanceId == $id and .displayName == "doctor-laptop"'
openclaw agent-system instance rotate --expected-id "$original" --json | jq -e --arg id "$original" '.instanceId != $id and .displayName == "doctor-laptop"'
openclaw agent-system doctor --json | jq -e 'any(.findings[]; .component == "instance-identity" and .status == "healthy")'

```

```bash
# should place install manifest warnings after the result table in one message section
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/warning-data"
output="$(NO_COLOR=1 openclaw agent-system install --skip-setup --yes 2>&1)"
printf '%s\n' "$output" | grep -F 'manifest-setup-deprecated'
printf '%s\n' "$output" | awk '/^[[:space:]]*workspace[[:space:]]/ {footer=NR} /^messages$/ {section=NR; count++} END {exit !(footer && section > footer && count == 1)}'

# should place doctor manifest warnings after the workspace footer
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/warning-data"
output="$(NO_COLOR=1 openclaw agent-system doctor 2>&1)"
printf '%s\n' "$output" | grep -F 'manifest-setup-deprecated'
printf '%s\n' "$output" | awk '/^[[:space:]]*workspace[[:space:]]/ {footer=NR} /^messages$/ {section=NR; count++} END {exit !(footer && section > footer && count == 1)}'

# should report component-first healthy agent and path state without color
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
NO_COLOR=1 openclaw agent-system doctor | grep -E '^agent[[:space:]]+healthy[[:space:]]'
NO_COLOR=1 openclaw agent-system doctor | grep -E '^path[[:space:]]+healthy[[:space:]]'

# should report the same healthy aggregate state as structured json
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
openclaw agent-system doctor --json | jq -e '.status == "healthy" and (.findings | any(.component == "agent"))'

# should report the same healthy aggregate state through both status aliases
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
openclaw agent-system status --json | jq -e '.status == "healthy" and (.findings | any(.component == "agent"))'
openclaw as status --json | jq -e '.status == "healthy" and (.findings | any(.component == "agent"))'

# should detect public identity drift with a failing exit code
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
openclaw agents set-identity \
  --agent doctor-data \
  --workspace "$GITHUB_WORKSPACE/examples/openclaw-doctor/data" \
  --name Drifted \
  --json
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'agent'

# should repair identity drift through install and return doctor to healthy state
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
openclaw agent-system install --json | jq -e '.outcomes | any(.status == "updated")'
openclaw agent-system doctor --json | jq -e '.status == "healthy"'
```
