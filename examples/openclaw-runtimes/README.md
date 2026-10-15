# OpenClaw Runtime Boundaries Example

Verify the installed Agent System boundary through native OpenClaw and OpenClaw-hosted Codex. Each runtime executes one manifest-PATH command under its own Git identity, rejects a change into the peer agent's workspace, and rejects unattended operator installation. The installed Control UI approval route then proves denied install, approved install, and read-only Doctor behavior. Assertions use filesystem receipts and native approval events rather than model wording.

One Ubuntu job installs the prepared package and one agent per runtime. Strict AIMock selects all three native OpenClaw turns while the real Gateway executes their tools and approval decisions. Only the three hosted Codex turns use a live model, because its native shell and dynamic tool discovery are under test. The workflow scopes the existing CI model credential to this example. Workspaces are copied because the Codex model is runtime-derived and the probes write receipts. A conflicting host executable makes incorrect PATH precedence fail immediately. All six turns run once with no retries. A denied tool can end its chat before another model request; the approval driver verifies the exact denial and absent effects independently. Other chat channels and the ordinary worktree/session lifecycle remain outside this example.

## Setup

```bash
# should prepare the packed plugin with the live codex and strict native models
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE" \
  --model "openai/$OPENAI_MODEL" \
  --yolo
openclaw-aimock prepare --scenario openclaw-runtimes
openclaw config set models.mode merge

# should install one owned workspace per runtime without applying setup
cp -R "$GITHUB_WORKSPACE/examples/openclaw-runtimes" "$TMPDIR/runtime-boundaries"
mkdir -p "$TMPDIR/runtime-boundaries/codex/tools/bin" "$TMPDIR/runtime-boundaries/openclaw/tools/bin"
sed "s/__OPENAI_MODEL__/$OPENAI_MODEL/g" "$GITHUB_WORKSPACE/examples/openclaw-runtimes/codex/agent.yaml" > "$TMPDIR/runtime-boundaries/codex/agent.yaml"
cp "$GITHUB_WORKSPACE/examples/openclaw-runtimes/probe.sh" "$TMPDIR/runtime-boundaries/codex/tools/bin/agent-system-runtime-probe"
cp "$GITHUB_WORKSPACE/examples/openclaw-runtimes/probe.sh" "$TMPDIR/runtime-boundaries/openclaw/tools/bin/agent-system-runtime-probe"
cd "$TMPDIR/runtime-boundaries/codex"
openclaw agent-system install --skip-setup --yes
cd "$TMPDIR/runtime-boundaries/openclaw"
openclaw agent-system install --skip-setup --yes

# should start the gateway with a conflicting host executable on path
PATH="$TMPDIR/runtime-boundaries/host-bin:$PATH" openclaw-gateway start
```

## Testing

```bash
# should retain codex native execution identity path and operator boundaries
openclaw agent \
  --agent runtime-codex \
  --session-key agent:runtime-codex:runtime-boundary-exec \
  --message-file "$GITHUB_WORKSPACE/examples/openclaw-runtimes/exec-codex.md" \
  --timeout 600
grep -F 'Runtime Codex <runtime-codex@example.invalid>' "$TMPDIR/runtime-boundaries/codex/identity.txt"
grep -Fx verified "$TMPDIR/runtime-boundaries/codex/receipt.txt"

# should retain openclaw native execution identity path and operator boundaries
openclaw agent \
  --agent runtime-openclaw \
  --session-key agent:runtime-openclaw:runtime-boundary-exec \
  --message-file "$GITHUB_WORKSPACE/examples/openclaw-runtimes/exec-openclaw.md" \
  --timeout 600
grep -F 'Runtime OpenClaw <runtime-openclaw@example.invalid>' "$TMPDIR/runtime-boundaries/openclaw/identity.txt"
grep -Fx verified "$TMPDIR/runtime-boundaries/openclaw/receipt.txt"

# should deny native openclaw installation before any setup effects
node --import tsx "$GITHUB_WORKSPACE/scripts/lifecycle-approval-scenario.ts" runtime-openclaw

# should allow exactly one installation through the hosted codex approval route
node --import tsx "$GITHUB_WORKSPACE/scripts/lifecycle-approval-scenario.ts" runtime-codex

# should approve native openclaw doctor checks without applying setup
node --import tsx "$GITHUB_WORKSPACE/scripts/lifecycle-approval-scenario.ts" runtime-openclaw doctor

# should discover and approve the hosted codex doctor tool without applying setup
node --import tsx "$GITHUB_WORKSPACE/scripts/lifecycle-approval-scenario.ts" runtime-codex doctor

# should complete only the three authored native turns through strict aimock
curl --fail --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.scenario == "openclaw-runtimes" and .strictMissCount == 0 and .finalResponseCount >= 2 and .finalResponseCount <= 3 and any(.tools[]; .name == "exec" and .callResponseCount == 1 and .resultRequestCount == 1) and any(.tools[]; .name == "agent_system_doctor" and .callResponseCount == 1 and .resultRequestCount == 1) and any(.tools[]; .name == "agent_system_install" and .resultRequestCount <= 1)'
```

## Cleanup

```bash
# should stop the scenario gateway and mock provider
openclaw-gateway stop
openclaw-aimock stop
```
