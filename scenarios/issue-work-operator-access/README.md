# Operator Access Gateway Scenario

This deterministic CI-only scenario uses the installed plugin, real Gateway
notification polling, native owner authorization, and native `sessions` calls.
The fake GitHub executable serves only disposable JSON fixtures; a declared local
repository prevents remote Git access. No GitHub credentials, live GitHub writes,
or paid model calls are required. Do not run this scenario on an operator host.

The first three assignments use Guided mode to stop after initial setup. The last
uses Work mode to exercise the system-attributed implementation turn; the fixture
deliberately makes no commit, so delivery stops without pushing. Strict AIMock
asserts that non-owner, tool-denied, and system-generated turns lack `sessions`.
The assertions read saved session fields; prompt instructions are not success evidence.

## Setup

```bash
# should prepare the disposable provider and installed gateway
node "$GITHUB_WORKSPACE/scenarios/issue-work-operator-access/control.mjs" prepare
export PATH="$TMPDIR/operator-access/bin:$PATH"
openclaw-notification-setup prepare \
  --model aimock/gpt-5.5 \
  --scenario operator-access \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE"
openclaw config set commands.ownerAllowFrom '[]' --strict-json
```

## Testing

```bash
# should diagnose missing requested access without mutating it
export PATH="$TMPDIR/operator-access/bin:$PATH"
cd "$TMPDIR/operator-access/agent"
openclaw agent-system doctor --json > "$TMPDIR/operator-doctor.json" || true
jq -e '.findings[] | select(.code == "github-operator-owner-missing" and .status == "warning")' "$TMPDIR/operator-doctor.json"
openclaw config get commands.ownerAllowFrom --json | jq -e 'length == 0'
```

```bash
# should reconcile only the flagged actor through normal authorized install
export PATH="$TMPDIR/operator-access/bin:$PATH"
cd "$TMPDIR/operator-access/agent"
openclaw agent-system install --json > "$TMPDIR/operator-install.json"
jq -e '.outcomes[] | select(.code == "github-operator-grants-reconciled")' "$TMPDIR/operator-install.json"
openclaw config get commands.ownerAllowFrom --json | jq -e '. == ["agent-system-github:U_flagged"]'
openclaw agent-system install --json | jq -e '.outcomes[] | select(.code == "github-operator-grants-reconciled" and .status == "unchanged")'
OPENCLAW_NO_RESPAWN=1 openclaw-gateway start
```

```bash
# should persist native owner color and group for a fresh flagged gateway assignment
export PATH="$TMPDIR/operator-access/bin:$PATH"
cd "$TMPDIR/operator-access/agent"
node "$GITHUB_WORKSPACE/scenarios/issue-work-operator-access/control.mjs" add flagged
node "$GITHUB_WORKSPACE/scenarios/issue-work-operator-access/control.mjs" wait 1 configured
```

```bash
# should complete an unflagged assignment without promoting its sender
export PATH="$TMPDIR/operator-access/bin:$PATH"
cd "$TMPDIR/operator-access/agent"
node "$GITHUB_WORKSPACE/scenarios/issue-work-operator-access/control.mjs" add unflagged
node "$GITHUB_WORKSPACE/scenarios/issue-work-operator-access/control.mjs" wait 2 unconfigured
```

```bash
# should retain independent tool denial for an opted-in actor
export PATH="$TMPDIR/operator-access/bin:$PATH"
cd "$TMPDIR/operator-access/agent"
openclaw config set agents.entries.notification-data.tools.deny '["sessions"]' --strict-json
openclaw-gateway stop
OPENCLAW_NO_RESPAWN=1 openclaw-gateway start
node "$GITHUB_WORKSPACE/scenarios/issue-work-operator-access/control.mjs" add denied
node "$GITHUB_WORKSPACE/scenarios/issue-work-operator-access/control.mjs" wait 3 unconfigured
```

```bash
# should withhold human owner authority from the system implementation turn
export PATH="$TMPDIR/operator-access/bin:$PATH"
cd "$TMPDIR/operator-access/agent"
openclaw config set agents.entries.notification-data.tools.deny '[]' --strict-json
node "$GITHUB_WORKSPACE/scenarios/issue-work-operator-access/control.mjs" work
openclaw-gateway stop
OPENCLAW_NO_RESPAWN=1 openclaw-gateway start
node "$GITHUB_WORKSPACE/scenarios/issue-work-operator-access/control.mjs" add work
node "$GITHUB_WORKSPACE/scenarios/issue-work-operator-access/control.mjs" wait 4 configured
node "$GITHUB_WORKSPACE/scenarios/issue-work-operator-access/control.mjs" evidence
```

```bash
# should revoke the feature-owned entry before plugin uninstall without changing saved sessions
export PATH="$TMPDIR/operator-access/bin:$PATH"
cd "$TMPDIR/operator-access/agent"
openclaw-gateway stop
node "$GITHUB_WORKSPACE/scenarios/issue-work-operator-access/control.mjs" opt-out
openclaw agent-system install --json | jq -e '.outcomes[] | select(.code == "github-operator-grants-reconciled")'
openclaw config get commands.ownerAllowFrom --json | jq -e 'length == 0'
```

## Cleanup

```bash
# should stop the disposable gateway and model provider even after an assertion fails
export PATH="$TMPDIR/operator-access/bin:$PATH"
openclaw-gateway stop
openclaw-notification-setup stop --model aimock/gpt-5.5 --scenario operator-access
```
