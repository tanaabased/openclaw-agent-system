# Native Execution Example

Verify Agent System's native execution boundary on macOS and Linux: manifest PATH projection, workspace paths containing spaces, shell arguments and stdin, exit status, PTYs, and managed identity after a directory change. Strict AIMock selects two fixed OpenClaw exec calls; the Gateway, shell, terminal, and managed Git launcher run normally. No provider credentials or live model are needed. Codex-specific execution remains with runtime coverage.

The workspace is copied because the test requires a path containing spaces and writes its own receipts. The probe emits success only after checking the actual child process and the rejected cross-agent invocation.

## Setup

```bash
# should prepare the packed plugin and strict native execution fixture
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE" \
  --yolo
openclaw-aimock prepare --scenario os-execution

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
  --timeout 120
grep -Fx verified "$TMPDIR/os execution/source/pipe.result"

# should preserve the same agent execution boundary through a native pty
openclaw agent \
  --agent os-execution \
  --session-key agent:os-execution:os-execution-pty \
  --message-file "$GITHUB_WORKSPACE/examples/os-execution/pty.md" \
  --timeout 120
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

# should stop the strict mock model cleanly
openclaw-aimock stop
```
