# OpenClaw Doctor Example

This scenario installs the prepared Agent System package and verifies foundational lifecycle state through the public doctor and install commands.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE"

# should install the disposable doctor workspace through agent system
mkdir -p "$TMPDIR/doctor-data"
cp "$GITHUB_WORKSPACE/examples/openclaw-doctor/base.yaml" "$TMPDIR/doctor-data/agent.yaml"
cd "$TMPDIR/doctor-data"
openclaw agent-system install
```

## Testing

```bash
# should expose the canonical command tree and its alias
openclaw agent-system --help | grep -F 'validate'
openclaw as --help | grep -F 'validate'

# should expose lowercase owned descriptions without changing host help headings
openclaw agent-system install --help | grep -F 'including required session dispatch'
openclaw as status --help | grep -F 'inspect agent system agent, path, and configured capability drift.'

```

```bash
# should place install manifest warnings after the result table in one message section
mkdir -p "$TMPDIR/warning-doctor-data"
cp "$GITHUB_WORKSPACE/examples/openclaw-doctor/warning-data/agent.yaml" "$TMPDIR/warning-doctor-data/agent.yaml"
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
cd "$TMPDIR/doctor-data"
NO_COLOR=1 openclaw agent-system doctor | grep -E '^agent[[:space:]]+healthy[[:space:]]'
NO_COLOR=1 openclaw agent-system doctor | grep -E '^path[[:space:]]+healthy[[:space:]]'

# should report the same healthy aggregate state as structured json
cd "$TMPDIR/doctor-data"
openclaw agent-system doctor --json | jq -e '.status == "healthy" and (.findings | any(.component == "agent"))'

# should report the same healthy aggregate state through both status aliases
cd "$TMPDIR/doctor-data"
openclaw agent-system status --json | jq -e '.status == "healthy" and (.findings | any(.component == "agent"))'
openclaw as status --json | jq -e '.status == "healthy" and (.findings | any(.component == "agent"))'

# should detect public identity drift with a failing exit code
cd "$TMPDIR/doctor-data"
openclaw agents set-identity \
  --agent doctor-data \
  --workspace "$TMPDIR/doctor-data" \
  --name Drifted \
  --json
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'agent'

# should repair identity drift through install and return doctor to healthy state
cd "$TMPDIR/doctor-data"
openclaw agent-system install --json | jq -e '.outcomes | any(.status == "updated")'
openclaw agent-system doctor --json | jq -e '.status == "healthy"'
```

```bash
# should reconcile additive native tool grants while preserving unrelated access
openclaw config set 'agents.entries.doctor-data.tools.alsoAllow' '["message"]' --strict-json
cp "$GITHUB_WORKSPACE/examples/openclaw-doctor/with-tools.yaml" "$TMPDIR/doctor-data/agent.yaml"
cd "$TMPDIR/doctor-data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "set-agent-tool-access")'
openclaw config get 'agents.entries.doctor-data.tools.alsoAllow' --json | jq -e 'index("message") != null'
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "agent-tool-access-ready")'
```

```bash
# should reconcile selected native tools through an exact allowlist
openclaw config unset 'agents.entries.doctor-data.tools.alsoAllow'
openclaw config set 'agents.entries.doctor-data.tools.allow' '["read"]' --strict-json
cd "$TMPDIR/doctor-data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "set-agent-tool-access")'
openclaw config get 'agents.entries.doctor-data.tools.allow' --json | jq -e 'index("read") != null'
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "agent-tool-access-ready")'
```

```bash
# should leave converged native tool access unchanged
cd "$TMPDIR/doctor-data"
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "agent-tool-access-unchanged")'
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "agent-tool-access-ready")'
```

```bash
# should block a selected native tool denied by operator policy
openclaw config set 'agents.entries.doctor-data.tools.deny' '["agent_system_github"]' --strict-json
cd "$TMPDIR/doctor-data"
if output=$(openclaw agent-system doctor --json); then exit 1; fi
printf '%s\n' "$output" | jq -e '.findings | any(.component == "tool-access" and .status == "blocked" and .code == "agent-tool-access-denied" and (.message | contains("agent_system_github")))'
if output=$(openclaw agent-system install --json 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'code=agent-tool-access-denied'
```

```bash
# should remove stale owned grants when capabilities disappear
openclaw config set 'agents.entries.doctor-data.tools.deny' '[]' --strict-json
cp "$GITHUB_WORKSPACE/examples/openclaw-doctor/base.yaml" "$TMPDIR/doctor-data/agent.yaml"
cd "$TMPDIR/doctor-data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "set-agent-tool-access")'
openclaw config get 'agents.entries.doctor-data.tools' --json | jq -e '(.allow | sort) == (["read", "agent_system_install", "agent_system_doctor"] | sort) and (has("alsoAllow") | not)'
```
