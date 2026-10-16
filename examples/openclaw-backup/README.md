# OpenClaw Backup Example

Verify the installed backup critical path through public Agent System commands: capture explicitly included private memory despite Git ignore rules, verify the archive, and restore its contents into a fresh staging directory without changing the source workspace. A populated target must be rejected rather than overwritten.

Runtime tests run this example on Ubuntu without a model, Gateway, or provider credentials. The fixture is copied because installation, Git initialization, and backup creation mutate its workspace. The archive also captures a real agent database with committed WAL content. Retention and adversarial archive variants remain in source tests.

## Setup

```bash
# should install a disposable workspace with explicitly included ignored memory
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
cp -R "$GITHUB_WORKSPACE/examples/openclaw-backup/data" "$TMPDIR/backup-tanaabot"
cd "$TMPDIR/backup-tanaabot"
mv gitignore .gitignore
git init --initial-branch=main
openclaw agent-system install --yes --json | jq -e '.agentId == "backup-tanaabot"'
```

## Testing

```bash
# should create and verify a managed archive containing the private memory
cd "$TMPDIR/backup-tanaabot"
node "$GITHUB_WORKSPACE/examples/openclaw-backup/agent-state-fixture.mjs" seed "$TMPDIR/backup-agent-ready" &
fixture_pid=$!
trap 'kill "$fixture_pid" 2>/dev/null || true' EXIT
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if test -f "$TMPDIR/backup-agent-ready"; then break; fi
  sleep 1
done
test -f "$TMPDIR/backup-agent-ready"
database=$(cat "$TMPDIR/backup-agent-ready")
test -s "$database-wal"
openclaw agent-system backup create --json | tee "$TMPDIR/backup-created.json" | jq -e '.status == "created" and .coverage.openclawState == "captured"'
archive=$(jq -er .archive "$TMPDIR/backup-created.json")
openclaw agent-system backup verify "$archive" --json | jq -e '.status == "verified" and .agentId == "backup-tanaabot" and .coverage.openclawState == "captured"'
git check-ignore "$archive"
kill "$fixture_pid"
wait "$fixture_pid" || true
trap - EXIT

# should restore the captured memory into fresh staging while preserving the source
cd "$TMPDIR/backup-tanaabot"
archive=$(jq -er .archive "$TMPDIR/backup-created.json")
openclaw agent-system backup restore "$archive" --target "$TMPDIR/backup-recovered" --json | jq -e '.status == "restored" and .agentId == "backup-tanaabot" and .coverage.openclawState == "captured"'
node "$GITHUB_WORKSPACE/examples/openclaw-backup/agent-state-fixture.mjs" verify "$TMPDIR/backup-recovered/openclaw-state/openclaw-agent.sqlite"
cmp "$GITHUB_WORKSPACE/examples/openclaw-backup/data/MEMORY.md" "$TMPDIR/backup-recovered/workspace/MEMORY.md"
cmp "$GITHUB_WORKSPACE/examples/openclaw-backup/data/memory/day.md" "$TMPDIR/backup-recovered/workspace/memory/day.md"
cmp "$GITHUB_WORKSPACE/examples/openclaw-backup/data/MEMORY.md" MEMORY.md
cmp "$GITHUB_WORKSPACE/examples/openclaw-backup/data/memory/day.md" memory/day.md

# should refuse to overwrite the populated recovery directory
cd "$TMPDIR/backup-tanaabot"
archive=$(jq -er .archive "$TMPDIR/backup-created.json")
if openclaw agent-system backup restore "$archive" --target "$TMPDIR/backup-recovered" --json > "$TMPDIR/backup-refused.json"; then exit 1; fi
jq -e '.status == "failed" and any(.diagnostics[]; .code == "backup-target-nonempty")' "$TMPDIR/backup-refused.json"
cmp "$GITHUB_WORKSPACE/examples/openclaw-backup/data/MEMORY.md" "$TMPDIR/backup-recovered/workspace/MEMORY.md"
cmp "$GITHUB_WORKSPACE/examples/openclaw-backup/data/memory/day.md" "$TMPDIR/backup-recovered/workspace/memory/day.md"
```
