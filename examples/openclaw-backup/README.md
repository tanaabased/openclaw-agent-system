# OpenClaw Backup Example

Verify the installed backup critical path through public Agent System commands: capture explicitly included private memory despite Git ignore rules, verify the archive, and restore its contents into a fresh staging directory without changing the source workspace. A populated target must be rejected rather than overwritten.

Runtime tests run this example on Ubuntu without a model, Gateway, or provider credentials. The fixture is copied because installation, Git initialization, and backup creation mutate its workspace. Database snapshots, retention, and adversarial archives remain in source tests and the older unscheduled backup example.

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
openclaw agent-system backup create --json | tee "$TMPDIR/backup-created.json" | jq -e '.status == "created" and .coverage.openclawState == "off"'
archive=$(jq -er .archive "$TMPDIR/backup-created.json")
openclaw agent-system backup verify "$archive" --json | jq -e '.status == "verified" and .agentId == "backup-tanaabot" and .coverage.openclawState == "off"'
git check-ignore "$archive"

# should restore the captured memory into fresh staging while preserving the source
cd "$TMPDIR/backup-tanaabot"
archive=$(jq -er .archive "$TMPDIR/backup-created.json")
openclaw agent-system backup restore "$archive" --target "$TMPDIR/backup-recovered" --json | jq -e '.status == "restored" and .agentId == "backup-tanaabot" and .coverage.openclawState == "off"'
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
