# Automations Example

Exercises native scheduled commands through the packed plugin: owning identity,
policy before missing credentials, workspace containment, stale-job rejection,
one-shot retention, and command/SSH authority cleanup. Remote SSH is held by a
fixture executable; Git and GitHub use the installed managed launchers. A strict
AIMock prompt proves owning-agent context separately from model-free commands.
This scenario runs only in GitHub Actions.

## Setup

```bash
# should prepare the packed plugin and isolated scheduler fixtures
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-ssh-key
openclaw-aimock prepare --scenario automations
mkdir -p "$TMPDIR/automation-agent" "$TMPDIR/automation-host-bin"
cp "$GITHUB_WORKSPACE/examples/automations/ssh" "$TMPDIR/automation-host-bin/ssh"
chmod 700 "$TMPDIR/automation-host-bin/ssh"
cp "$GITHUB_WORKSPACE/examples/automations/agent.yaml" "$TMPDIR/automation-agent/agent.yaml"
cp "$GITHUB_WORKSPACE/examples/automations/IDENTITY.md" "$TMPDIR/automation-agent/IDENTITY.md"
cp "$GITHUB_WORKSPACE/examples/automations/probe.sh" "$TMPDIR/automation-agent/probe.sh"
printf '[]\n' > "$TMPDIR/automation-agent/automations.yaml"
PATH="$TMPDIR/automation-host-bin:$PATH" openclaw-gateway start --debug
cd "$TMPDIR/automation-agent"
PATH="$TMPDIR/automation-host-bin:$PATH" openclaw agent-system install --yes
```

## Testing

```bash
# should run plain git and gh under the scheduled agent without a model
cd "$TMPDIR/automation-agent"
cp "$GITHUB_WORKSPACE/examples/automations/identity.yaml" automations.yaml
PATH="$TMPDIR/automation-host-bin:$PATH" openclaw agent-system install --yes --json
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" wait identity
grep -F 'Tanaabot <tanaabot@tanaab.dev>' identity.git
grep -Fx tanaabot identity.github
test ! -s cross-agent.stdout
test ! -s cross-workspace.stdout
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" cleanup identity
curl -fsS "$(cat "$TMPDIR/openclaw-aimock.url")/proof/evidence" | jq -e '.requestCount == 0'

# should retain consumed one-shots across unchanged install removal and reintroduction
cd "$TMPDIR/automation-agent"
openclaw gateway call cron.list --params '{"includeDisabled":true}' --json | jq -r '.jobs[] | select(.name == "Agent System: identity") | .id' > identity.native-id
PATH="$TMPDIR/automation-host-bin:$PATH" openclaw agent-system install --yes --json | jq -e '.outcomes | any(.component == "automations" and .status == "unchanged")'
printf '[]\n' > automations.yaml
PATH="$TMPDIR/automation-host-bin:$PATH" openclaw agent-system install --yes --json
cp "$GITHUB_WORKSPACE/examples/automations/identity.yaml" automations.yaml
PATH="$TMPDIR/automation-host-bin:$PATH" openclaw agent-system install --yes --json
openclaw gateway call cron.list --params '{"includeDisabled":true}' --json | jq -r '.jobs[] | select(.name == "Agent System: identity" and .enabled == false) | .id' | diff - identity.native-id

# should reject changed command content before creating authority
cd "$TMPDIR/automation-agent"
cp "$GITHUB_WORKSPACE/examples/automations/stale.yaml" automations.yaml
PATH="$TMPDIR/automation-host-bin:$PATH" openclaw agent-system install --yes --json
sed 's/stale-ran/stale-changed-ran/' "$GITHUB_WORKSPACE/examples/automations/stale.yaml" > automations.yaml
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" wait stale
test ! -e stale-ran
test ! -e stale-changed-ran

# should reject a disabled declaration even before the next explicit synchronization
cd "$TMPDIR/automation-agent"
cp "$GITHUB_WORKSPACE/examples/automations/disabled.yaml" automations.yaml
PATH="$TMPDIR/automation-host-bin:$PATH" openclaw agent-system install --yes --json
printf '  enabled: false\n' >> automations.yaml
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" wait disabled
test ! -e disabled-ran

# should deny protected release creation before resolving a now-missing credential
cd "$TMPDIR/automation-agent"
cp "$GITHUB_WORKSPACE/examples/automations/policy.yaml" automations.yaml
PATH="$TMPDIR/automation-host-bin:$PATH" openclaw agent-system install --yes --json
sed 's/GH_TOKEN_TANAABOT/AUTOMATION_INTENTIONALLY_MISSING/g' "$GITHUB_WORKSPACE/examples/automations/agent.yaml" > agent.yaml
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" wait policy
grep -F approval_denied policy.stderr
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" cleanup policy

# should fail missing credentials without borrowing the operator token
cd "$TMPDIR/automation-agent"
cp "$GITHUB_WORKSPACE/examples/automations/agent.yaml" agent.yaml
cp "$GITHUB_WORKSPACE/examples/automations/missing.yaml" automations.yaml
PATH="$TMPDIR/automation-host-bin:$PATH" openclaw agent-system install --yes --json
sed 's/GH_TOKEN_TANAABOT/AUTOMATION_INTENTIONALLY_MISSING/g' "$GITHUB_WORKSPACE/examples/automations/agent.yaml" > agent.yaml
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" wait missing
grep -F credential_unavailable missing.stderr
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" cleanup missing

# should clean managed ssh resources and authority after the native timeout kills the process tree
cd "$TMPDIR/automation-agent"
cp "$GITHUB_WORKSPACE/examples/automations/agent.yaml" agent.yaml
cp "$GITHUB_WORKSPACE/examples/automations/timeout.yaml" automations.yaml
PATH="$TMPDIR/automation-host-bin:$PATH" openclaw agent-system install --yes --json
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" wait timeout
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" cleanup timeout

# should cancel a live runner and clean its managed ssh resources
cd "$TMPDIR/automation-agent"
rm -f "$TMPDIR/automation-ssh.pid" "$TMPDIR/automation-ssh.socket"
cp "$GITHUB_WORKSPACE/examples/automations/cancel.yaml" automations.yaml
PATH="$TMPDIR/automation-host-bin:$PATH" openclaw agent-system install --yes --json
for attempt in $(seq 1 90); do
  if test -f "$TMPDIR/automation-ssh.socket"; then break; fi
  sleep 2
done
test -f "$TMPDIR/automation-ssh.socket"
kill -TERM "$(cat cancel.runner)"
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" wait cancel
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" cleanup cancel

# should retain the owning agent context for a native scheduled prompt
cd "$TMPDIR/automation-agent"
cp "$GITHUB_WORKSPACE/examples/automations/prompt.yaml" automations.yaml
PATH="$TMPDIR/automation-host-bin:$PATH" openclaw agent-system install --yes --json
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" wait prompt
openclaw-aimock evidence --scenario automations --expected-evidence "$GITHUB_WORKSPACE/examples/automations/expected-evidence.json"
```

## Cleanup

```bash
# should stop the scenario gateway and mock provider
openclaw-gateway stop
openclaw-aimock stop
```
