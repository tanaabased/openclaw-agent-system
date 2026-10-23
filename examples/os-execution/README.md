# Native Execution Example

Run real shell and PTY commands on macOS and Linux, preserving manifest PATH, arguments, stdin, exit status, and managed identity after a directory change while rejecting cross-agent execution.

## What Belongs Here

- Actual native process/terminal behavior through the installed execution boundary.
- Workspace paths containing spaces and identity/containment after changing directory.
- One shell exchange and one PTY exchange, each requiring its probe's completed receipt.

## What Does Not Belong Here

- Runtime-specific hosted Codex execution: [runtimes](../openclaw-runtimes/README.md). Interactive approval journeys also remain there pending separation.
- Provider transport, model interpretation, scheduler behavior, and exhaustive command-form permutations.

## Notes

- Strict AIMock selects two fixed OpenClaw exec calls; the Gateway, shell, terminal, and managed Git launcher run normally without a live model or provider credentials.
- Workspaces are copied because paths containing spaces are part of the contract. The probe emits success only after checking the actual child process and rejected cross-agent invocation.
- Each command has a 120-second limit within a 180-second turn. Cron is disabled so unrelated maintenance cannot consume mock exchanges.
- Cleanup stops the provider and fails on strict mock misses, retaining bounded probe results for diagnosis.

## Setup

```bash
# should prepare the packed plugin and strict native execution fixture
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE" \
  --yolo
openclaw-aimock prepare --scenario os-execution
openclaw config set cron.enabled false --strict-json

# should install two isolated workspaces beneath a path containing spaces
mkdir -p "$TMPDIR/os execution"
cp -R "$GITHUB_WORKSPACE/examples/os-execution/source" "$TMPDIR/os execution/source"
cp -R "$GITHUB_WORKSPACE/examples/os-execution/peer" "$TMPDIR/os execution/peer"
cd "$TMPDIR/os execution/source"
openclaw agent-system install
cd "$TMPDIR/os execution/peer"
openclaw agent-system install

# should start the gateway with the installed native execution agents
openclaw-gateway start
```

## Testing

```bash
# should preserve path arguments stdin exit status and identity through a native shell
openclaw agent \
  --agent os-execution \
  --session-key agent:os-execution:os-execution-pipe \
  --message-file "$GITHUB_WORKSPACE/examples/os-execution/pipe.md" \
  --timeout 180
grep -Fx verified "$TMPDIR/os execution/source/pipe.result"

# should preserve the same agent execution boundary through a native pty
openclaw agent \
  --agent os-execution \
  --session-key agent:os-execution:os-execution-pty \
  --message-file "$GITHUB_WORKSPACE/examples/os-execution/pty.md" \
  --timeout 180
grep -Fx verified "$TMPDIR/os execution/source/pty.result"

# should complete only the two authored exec exchanges without mock misses
openclaw-aimock evidence \
  --scenario os-execution \
  --expected-evidence "$GITHUB_WORKSPACE/examples/os-execution/expected-evidence.json"
```

## Cleanup

```bash
# should stop the background gateway cleanly
openclaw-gateway stop

# should report mock failures and stop the strict model cleanly
cleanup_status=0
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics > "$TMPDIR/os-execution-diagnostics.json" || cleanup_status=$?
openclaw-aimock stop || cleanup_status=$?
cat "$TMPDIR/os-execution-diagnostics.json"
jq -e '.failed == false' "$TMPDIR/os-execution-diagnostics.json" || cleanup_status=$?
test "$cleanup_status" -eq 0
```
