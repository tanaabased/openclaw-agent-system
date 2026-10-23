# OpenClaw Runtime Boundaries Example

Execute one declared-PATH command through native OpenClaw and OpenClaw-hosted Codex, preserving each agent's identity and context while rejecting peer-workspace access and unattended operator installation.

## What Belongs Here

- Real native execution through each runtime's trusted agent binding, PATH, and managed Git identity.
- Cross-agent containment and rejection of operator-only effects through ordinary execution.
- Filesystem receipts and actual tool results establishing completed effects without relying on model wording.

## What Does Not Belong Here

- Interactive Control UI approval journeys for denied/approved Install and read-only Doctor; these need a focused native-approval contract.
- Standalone Codex lifecycle: [Codex install](../codex-install/README.md). Cross-platform shell/PTY behavior: [OS execution](../os-execution/README.md).
- Model judgment, deferred tool discovery, embedding behavior, or a cross-product of every OS and runtime.

## Notes

- One Ubuntu job installs one agent per runtime. Native exec uses an issued command capability; hosted Codex uses its configured per-agent home and native thread context.
- Strict AIMock supplies all six authored turns with synthetic credentials and no live fallback. Hosted Codex uses direct tool loading; the Gateway and Codex app server are real.
- A shared workspace probe and conflicting host executable make wrong PATH precedence fail. Turns run once; an active Codex command is polled through its session ID at most three times within the turn timeout.
- Pending relocation: four approval-driver checks verify denied native Install, approved hosted-Codex Install, and Doctor through both runtimes. Denial events and absent effects are observed even if denial ends the chat before another model request.
- Bounded tool results and HTTP error bodies support diagnostics without exposing prompts or transport credentials. Memory search is disabled.

## Setup

```bash
# should prepare the packed plugin with strict mock models for both harnesses
export OPENAI_API_KEY=agent-system-aimock-test
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE" \
  --model openai/gpt-5.4-nano \
  --yolo
openclaw-aimock prepare --scenario openclaw-runtimes
openclaw config set models.mode merge
openclaw config set memory.search.enabled false --strict-json
openclaw config set plugins.entries.codex.config.codexDynamicToolsLoading direct
openclaw config set plugins.entries.codex.config.appServer.args '["-c","openai_base_url=\"http://127.0.0.1:4010/v1\"","app-server","--listen","stdio://"]' --strict-json

# should install one owned workspace per runtime without applying setup
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-runtimes/codex/tools/bin" "$GITHUB_WORKSPACE/examples/openclaw-runtimes/openclaw/tools/bin"
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

# should resolve and approve the hosted codex doctor tool without applying setup
node --import tsx "$GITHUB_WORKSPACE/scripts/lifecycle-approval-scenario.ts" runtime-codex doctor

# should complete all authored turns through strict aimock
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | tee "$TMPDIR/runtime-boundaries-evidence.json"
jq -e '.scenario == "openclaw-runtimes" and .strictMissCount == 0 and .finalResponseCount >= 5 and .finalResponseCount <= 6 and any(.tools[]; .name == "exec_command" and .callResponseCount == 1 and .resultRequestCount >= 1 and .resultRequestCount <= 4) and any(.tools[]; .name == "exec" and .callResponseCount == 1 and .resultRequestCount == 1) and any(.tools[]; .name == "agent_system_doctor" and .callResponseCount == 2 and .resultRequestCount == 2) and any(.tools[]; .name == "agent_system_install" and .callResponseCount >= 1 and .callResponseCount <= 2 and .resultRequestCount >= 1 and .resultRequestCount <= 2)' "$TMPDIR/runtime-boundaries-evidence.json"
```

## Cleanup

```bash
# should stop the scenario gateway and mock provider
openclaw-gateway stop
openclaw-aimock stop
```
