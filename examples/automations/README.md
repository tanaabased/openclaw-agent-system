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
mkdir -p "$TMPDIR/automation-agent" "$TMPDIR/automation-other" "$TMPDIR/automation-host-bin"
printf 'schema-version: 1\nagent:\n  id: automation-other\n' > "$TMPDIR/automation-other/agent.yaml"
openclaw agents add automation-other --workspace "$TMPDIR/automation-other" --non-interactive --json
cp "$GITHUB_WORKSPACE/examples/automations/ssh" "$TMPDIR/automation-host-bin/ssh"
chmod 700 "$TMPDIR/automation-host-bin/ssh"
cp "$GITHUB_WORKSPACE/examples/automations/agent.yaml" "$TMPDIR/automation-agent/agent.yaml"
cp "$GITHUB_WORKSPACE/examples/automations/IDENTITY.md" "$TMPDIR/automation-agent/IDENTITY.md"
cp "$GITHUB_WORKSPACE/examples/automations/probe.sh" "$TMPDIR/automation-agent/probe.sh"
cp "$GITHUB_WORKSPACE/examples/automations/prompt.md" "$TMPDIR/automation-agent/prompt.md"
printf '[]\n' > "$TMPDIR/automation-agent/automations.yaml"
OPENCLAW_PATH_BOOTSTRAPPED=1 PATH="$TMPDIR/automation-host-bin:$PATH" openclaw-gateway start --debug
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

# should refuse an explicit replay of a consumed one-shot
cd "$TMPDIR/automation-agent"
if openclaw agent-system automations run identity --json > consumed.json; then exit 1; fi
jq -e '.code == "automation-run-disabled"' consumed.json

# should expose help through both public aliases
openclaw agent-system automations --help | grep -F 'sync'
openclaw as automations run --help | grep -F '<id>'

# should reconcile list and run exact manifest ids with native history
cd "$TMPDIR/automation-agent"
cp "$GITHUB_WORKSPACE/examples/automations/operators.yaml" automations.yaml
openclaw agent-system automations sync --json | jq -e '.status == "synchronized"'
openclaw as automations sync --json | jq -e 'all(.outcomes[]; .status == "unchanged")'
openclaw agent-system automations list --json | jq -e '.jobs | any(.id == "paused-review" and .nativeEnabled == false)'
openclaw as automations list | grep -F 'paused-review' | grep -F 'automation-disabled'
run_id=$(openclaw as automations run identity --json | jq -er 'select(.status == "queued" and .execution == "unavailable") | .runId')
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" wait-run identity "$run_id"
openclaw agent-system automations runs identity --run-id "$run_id" --limit 1 --offset 0 --json | jq -e '.entries[0].execution == "ok" and .entries[0].delivery != "not-delivered"'
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" cleanup identity

# should report markdown drift and preserve unmanaged disabled jobs during sync
cd "$TMPDIR/automation-agent"
unmanaged_id=$(openclaw gateway call cron.add --params '{"name":"unmanaged-197","enabled":false,"schedule":{"kind":"every","everyMs":3600000},"sessionTarget":"isolated","wakeMode":"now","payload":{"kind":"agentTurn","message":"never run this unmanaged fixture"},"delivery":{"mode":"none"}}' --json | jq -er '.job.id // .id')
openclaw gateway call cron.get --params "{\"id\":\"$unmanaged_id\"}" --json > unmanaged-before.json
printf 'Review the latest repository changes.\n' >> prompt.md
if openclaw agent-system automations list --json > drift.json; then exit 1; fi
jq -e '.findings | any(.stepId == "paused-review" and .code == "automation-drift")' drift.json
openclaw agent-system automations sync --json | jq -e '.outcomes | any(.stepId == "paused-review" and .status == "updated")'
openclaw gateway call cron.get --params "{\"id\":\"$unmanaged_id\"}" --json | diff - unmanaged-before.json
openclaw gateway call cron.remove --params "{\"id\":\"$unmanaged_id\"}" --json | jq -e '.ok == true'

# should synchronize equivalent inline declarations without rewriting native jobs
cd "$TMPDIR/automation-agent"
sed '/^automations:/,$d' "$GITHUB_WORKSPACE/examples/automations/agent.yaml" > agent.yaml
printf 'automations:\n' >> agent.yaml
sed 's/^/  /' automations.yaml >> agent.yaml
openclaw agent-system automations sync --json | jq -e 'all(.outcomes[]; .status == "unchanged")'
cp "$GITHUB_WORKSPACE/examples/automations/agent.yaml" agent.yaml

# should reject paused and missing manifest ids with structured failures
cd "$TMPDIR/automation-agent"
if openclaw agent-system automations run paused-review --json > paused.json; then exit 1; fi
jq -e '.code == "automation-run-disabled"' paused.json
if openclaw as automations run missing --json > missing-id.json; then exit 1; fi
jq -e '.code == "automation-id-missing"' missing-id.json

# should reject explicit agent selection and another registered workspace
cd "$TMPDIR/automation-agent"
cp "$GITHUB_WORKSPACE/examples/automations/containment.yaml" automations.yaml
PATH="$TMPDIR/automation-host-bin:$PATH" openclaw agent-system install --yes --json
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" wait containment
test ! -s cross-agent.stdout
test ! -s cross-workspace.stdout
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" cleanup containment

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

# should report a native timeout for a long-running command
cd "$TMPDIR/automation-agent"
cp "$GITHUB_WORKSPACE/examples/automations/agent.yaml" agent.yaml
cp "$GITHUB_WORKSPACE/examples/automations/timeout.yaml" automations.yaml
PATH="$TMPDIR/automation-host-bin:$PATH" openclaw agent-system install --yes --json
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" wait timeout

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
test -S "$(cat "$TMPDIR/automation-ssh.socket")"
kill -0 "$(cat "$TMPDIR/automation-ssh.pid")"
kill -TERM "$(cat cancel.runner)"
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" wait cancel
bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" cleanup cancel

# should retain the owning agent context for a native scheduled prompt
cd "$TMPDIR/automation-agent"
cp "$GITHUB_WORKSPACE/examples/automations/prompt.md" prompt.md
cp "$GITHUB_WORKSPACE/examples/automations/prompt.yaml" automations.yaml
PATH="$TMPDIR/automation-host-bin:$PATH" openclaw agent-system install --yes --json
if ! bun "$GITHUB_WORKSPACE/scripts/automation-example-task.ts" wait prompt; then
  grep '^automation-fixture-match: ' "$TMPDIR/openclaw-aimock.log" >&2 || true
  exit 1
fi
openclaw-aimock evidence --scenario automations --expected-evidence "$GITHUB_WORKSPACE/examples/automations/expected-evidence.json"
```

## Cleanup

```bash
# should stop the scenario gateway and mock provider
openclaw-gateway stop
openclaw-aimock stop
```
