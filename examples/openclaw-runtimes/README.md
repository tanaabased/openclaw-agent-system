# OpenClaw Runtime Boundaries Example

Verify the installed Agent System boundary through native OpenClaw and OpenClaw-hosted Codex. Each runtime executes one manifest-PATH command under its own Git identity, rejects a change into the peer agent's workspace, and rejects unattended operator installation. The installed Control UI approval route then proves denied install, approved install, and read-only Doctor behavior. Assertions use filesystem receipts and native approval events rather than model wording.

Native exec uses an issued command capability; hosted Codex uses its per-agent home and native thread context. The probe checks the appropriate context before exercising the same managed operations. The evidence assertion prints bounded scenario-owned tool results and preserves HTTP error bodies so Leia retains the diagnostics when that assertion fails. System/user prompts and transport credentials are excluded.

Two temporary Ubuntu jobs each install the prepared package and one agent per runtime: direct Codex tool loading (the existing setup default for this model) and searchable loading. This temporary feasibility pass sends both harnesses to strict AIMock, with synthetic model credentials and no live-model fallback. Native OpenClaw remains the control. Hosted Codex first proves a text response can traverse the real app-server, then attempts the existing execution, Install, and Doctor contracts. The searchable variant retains deferred discovery; both retain native approvals. Unsupported mock protocol shapes fail explicitly; wire diagnostics retain only tool names, types, parameter keys, and input item types, never prompts, arguments, results, or credentials. Restore the full runtime matrix after this experiment and require a complete CI run before merging.

The shared probe is installed into each workspace's declared command directory; a conflicting host executable makes incorrect PATH precedence fail immediately. All turns run once with no retries. A denied tool can end its chat before another model request; the approval driver verifies the exact denial and absent effects independently.

## Setup

```bash
# should prepare the packed plugin with strict mock models for both harnesses
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE" \
  --model "openai/$OPENAI_MODEL" \
  --yolo
openclaw-aimock prepare --scenario openclaw-runtimes
openclaw config set models.mode merge
openclaw config set plugins.entries.codex.config.codexDynamicToolsLoading "$CODEX_MOCK_TOOL_LOADING"
openclaw config set plugins.entries.codex.config.appServer.args '["-c","openai_base_url=\"http://127.0.0.1:4010/v1\"","app-server","--listen","stdio://"]' --strict-json

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
# should receive a strict mock response through the real hosted codex harness
openclaw agent \
  --agent runtime-codex \
  --session-key agent:runtime-codex:mock-transport \
  --message 'runtime-codex-mock-transport: return runtime-codex-mock-ready without calling tools' \
  --timeout 120
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.finalResponseCount == 1 and .strictMissCount == 0'

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
jq -e '.scenario == "openclaw-runtimes" and .strictMissCount == 0 and .finalResponseCount >= 6 and .finalResponseCount <= 7 and any(.tools[]; .name == "exec_command" and .callResponseCount == 1 and .resultRequestCount == 1) and any(.tools[]; .name == "exec" and .callResponseCount == 1 and .resultRequestCount == 1) and any(.tools[]; .name == "agent_system_doctor" and .callResponseCount == 2 and .resultRequestCount == 2) and any(.tools[]; .name == "agent_system_install" and .callResponseCount >= 1 and .callResponseCount <= 2 and .resultRequestCount >= 1 and .resultRequestCount <= 2)' "$TMPDIR/runtime-boundaries-evidence.json"
```

## Cleanup

```bash
# should retain mock wire diagnostics and stop the scenario gateway and mock provider
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/wire || true
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics || true
openclaw-gateway stop
openclaw-aimock stop
```
