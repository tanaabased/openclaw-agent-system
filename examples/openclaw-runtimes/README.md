# OpenClaw Runtime Boundaries Example

Verify the installed Agent System boundary through native OpenClaw and OpenClaw-hosted Codex. Each runtime executes one manifest-PATH command under its own Git identity, rejects a change into the peer agent's workspace, and rejects unattended operator installation. The installed Control UI approval route then proves denied install, approved install, and read-only Doctor behavior. Assertions use filesystem receipts and native approval events rather than model wording.

Native exec uses an issued command capability; hosted Codex uses its per-agent home and native thread context. The probe checks the appropriate context before exercising the same managed operations. The evidence assertion prints bounded scenario-owned tool results and preserves HTTP error bodies so Leia retains the diagnostics when that assertion fails. System/user prompts and transport credentials are excluded.

One Ubuntu job installs the prepared package and one agent per runtime. Strict AIMock selects all three native OpenClaw turns while the real Gateway executes their tools and approval decisions. Only the three hosted Codex turns use a live model, because its native shell and dynamic tool discovery are under test. The workflow scopes the existing CI model credential to this example. The checked-in workspaces receive the runtime model selection and probe receipts on the disposable runner. The shared probe is installed into each workspace's declared command directory; this tests the resulting PATH projection. A conflicting host executable makes incorrect PATH precedence fail immediately. All six turns run once with no retries. A denied tool can end its chat before another model request; the approval driver verifies the exact denial and absent effects independently. Other chat channels and the ordinary worktree/session lifecycle remain outside this example.

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
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-runtimes/codex/tools/bin" "$GITHUB_WORKSPACE/examples/openclaw-runtimes/openclaw/tools/bin"
sed "s/__OPENAI_MODEL__/$OPENAI_MODEL/g" "$GITHUB_WORKSPACE/examples/openclaw-runtimes/codex/agent.yaml" > "$TMPDIR/runtime-codex-agent.yaml"
mv "$TMPDIR/runtime-codex-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-runtimes/codex/agent.yaml"
cp "$GITHUB_WORKSPACE/examples/openclaw-runtimes/probe.sh" "$GITHUB_WORKSPACE/examples/openclaw-runtimes/codex/tools/bin/agent-system-runtime-probe"
cp "$GITHUB_WORKSPACE/examples/openclaw-runtimes/probe.sh" "$GITHUB_WORKSPACE/examples/openclaw-runtimes/openclaw/tools/bin/agent-system-runtime-probe"
cd "$GITHUB_WORKSPACE/examples/openclaw-runtimes/codex"
openclaw agent-system install --skip-setup --yes
cd "$GITHUB_WORKSPACE/examples/openclaw-runtimes/openclaw"
openclaw agent-system install --skip-setup --yes

# should start the gateway with a conflicting host executable on path
PATH="$GITHUB_WORKSPACE/examples/openclaw-runtimes/host-bin:$PATH" openclaw-gateway start
```

## Testing

```bash
# should retain codex native execution identity path and operator boundaries
openclaw agent \
  --agent runtime-codex \
  --session-key agent:runtime-codex:runtime-boundary-exec \
  --message-file "$GITHUB_WORKSPACE/examples/openclaw-runtimes/exec-codex.md" \
  --timeout 600
grep -F 'Runtime Codex <runtime-codex@example.invalid>' "$GITHUB_WORKSPACE/examples/openclaw-runtimes/codex/identity.txt"
grep -Fx verified "$GITHUB_WORKSPACE/examples/openclaw-runtimes/codex/receipt.txt"

# should retain openclaw native execution identity path and operator boundaries
openclaw agent \
  --agent runtime-openclaw \
  --session-key agent:runtime-openclaw:runtime-boundary-exec \
  --message-file "$GITHUB_WORKSPACE/examples/openclaw-runtimes/exec-openclaw.md" \
  --timeout 600
grep -F 'Runtime OpenClaw <runtime-openclaw@example.invalid>' "$GITHUB_WORKSPACE/examples/openclaw-runtimes/openclaw/identity.txt"
grep -Fx verified "$GITHUB_WORKSPACE/examples/openclaw-runtimes/openclaw/receipt.txt"

# should deny native openclaw installation before any setup effects
node --import tsx "$GITHUB_WORKSPACE/scripts/lifecycle-approval-scenario.ts" runtime-openclaw

# should allow exactly one installation through the hosted codex approval route
node --import tsx "$GITHUB_WORKSPACE/scripts/lifecycle-approval-scenario.ts" runtime-codex

# should approve native openclaw doctor checks without applying setup
node --import tsx "$GITHUB_WORKSPACE/scripts/lifecycle-approval-scenario.ts" runtime-openclaw doctor

# should discover and approve the hosted codex doctor tool without applying setup
node --import tsx "$GITHUB_WORKSPACE/scripts/lifecycle-approval-scenario.ts" runtime-codex doctor

# should complete only the three authored native turns through strict aimock
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | tee "$TMPDIR/runtime-boundaries-evidence.json"
jq -e '.scenario == "openclaw-runtimes" and .strictMissCount == 0 and .finalResponseCount >= 2 and .finalResponseCount <= 3 and any(.tools[]; .name == "exec" and .callResponseCount == 1 and .resultRequestCount == 1) and any(.tools[]; .name == "agent_system_doctor" and .callResponseCount == 1 and .resultRequestCount == 1) and any(.tools[]; .name == "agent_system_install" and .resultRequestCount <= 1)' "$TMPDIR/runtime-boundaries-evidence.json"
```

## Cleanup

```bash
# should stop the scenario gateway and mock provider
openclaw-gateway stop
openclaw-aimock stop
```
