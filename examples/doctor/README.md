# Doctor Example

This scenario installs the prepared Agent System package and verifies foundational lifecycle state through the public doctor and install commands.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE"

# should install the scenario-owned workspace through agent system
cd "$GITHUB_WORKSPACE/examples/doctor/data"
openclaw agent-system install
```

## Testing

```bash
# should place install manifest warnings after the result table in one message section
mkdir -p "$TMPDIR/warning-doctor-data"
cp "$GITHUB_WORKSPACE/examples/doctor/warning-data/agent.yaml" "$TMPDIR/warning-doctor-data/agent.yaml"
cd "$TMPDIR/warning-doctor-data"
output="$(NO_COLOR=1 openclaw agent-system install --skip-setup --yes 2>&1)"
printf '%s\n' "$output" | grep -F 'manifest-setup-deprecated'
printf '%s\n' "$output" | awk '/^[[:space:]]*workspace[[:space:]]/ {footer=NR} /^messages$/ {section=NR; count++} END {exit !(footer && section > footer && count == 1)}'

# should place doctor manifest warnings after the workspace footer
cd "$TMPDIR/warning-doctor-data"
output="$(NO_COLOR=1 openclaw agent-system doctor 2>&1)"
printf '%s\n' "$output" | grep -F 'manifest-setup-deprecated'
printf '%s\n' "$output" | awk '/^[[:space:]]*workspace[[:space:]]/ {footer=NR} /^messages$/ {section=NR; count++} END {exit !(footer && section > footer && count == 1)}'

# should report component-first healthy agent and path state without color
cd "$GITHUB_WORKSPACE/examples/doctor/data"
NO_COLOR=1 openclaw agent-system doctor | grep -E '^agent[[:space:]]+healthy[[:space:]]'
NO_COLOR=1 openclaw agent-system doctor | grep -E '^path[[:space:]]+healthy[[:space:]]'

# should report the same healthy aggregate state as structured json
cd "$GITHUB_WORKSPACE/examples/doctor/data"
openclaw agent-system doctor --json | jq -e '.status == "healthy" and (.findings | any(.component == "agent"))'

# should report the same healthy aggregate state through both status aliases
cd "$GITHUB_WORKSPACE/examples/doctor/data"
openclaw agent-system status --json | jq -e '.status == "healthy" and (.findings | any(.component == "agent"))'
openclaw as status --json | jq -e '.status == "healthy" and (.findings | any(.component == "agent"))'

# should detect public identity drift with a failing exit code
cd "$GITHUB_WORKSPACE/examples/doctor/data"
openclaw agents set-identity \
  --agent doctor-data \
  --workspace "$GITHUB_WORKSPACE/examples/doctor/data" \
  --name Drifted \
  --json
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'agent'

# should repair identity drift through install and return doctor to healthy state
cd "$GITHUB_WORKSPACE/examples/doctor/data"
openclaw agent-system install --json | jq -e '.outcomes | any(.status == "updated")'
openclaw agent-system doctor --json | jq -e '.status == "healthy"'
```
