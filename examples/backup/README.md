# Workspace Backup Example

Exercises the packed plugin's workspace-only backup commands, ignored-memory
selection, setup check/apply authority, local destination ignore rules, and
verification with direct assertions. All writes stay in disposable runner state.

## Setup

```bash
# should configure an unauthenticated profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE"

# should prepare a disposable git workspace with ignored memory
cp -R "$GITHUB_WORKSPACE/examples/backup/data" "$TMPDIR/backup-workspace"
cd "$TMPDIR/backup-workspace"
mv gitignore .gitignore
git init
```

## Testing

```bash
# should preview ignored memory without creating any backup state
cd "$TMPDIR/backup-workspace/memory"
openclaw as backup create --dry-run --json | jq -e '.status == "preview" and .coverage.stage == "workspace-only" and (.files | index("MEMORY.md")) and (.files | index("memory/day.md"))'
test ! -e "$TMPDIR/backup-workspace/.agent-system"

# should prevent setup checks from creating archives and allow an explicit apply
cd "$TMPDIR/backup-workspace"
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.component == "setup" and .status == "updated")'
test -f backup-applied
test "$(find .agent-system/backups -name '*.tar.gz' | wc -l | tr -d ' ')" = 1

# should verify and extract selected memory without modifying the live workspace
cd "$TMPDIR/backup-workspace"
archive="$(find .agent-system/backups -name '*.tar.gz' | head -1)"
openclaw as backup verify "$archive" --json | jq -e '.status == "verified" and .agentId == "backup-example" and .coverage.openclawState == "unsupported"'
git check-ignore "$archive"
mkdir "$TMPDIR/backup-recovered"
tar -xzf "$archive" -C "$TMPDIR/backup-recovered"
cmp MEMORY.md "$TMPDIR/backup-recovered/workspace/MEMORY.md"
cmp memory/day.md "$TMPDIR/backup-recovered/workspace/memory/day.md"

# should let explicit excludes override included ignored memory
cd "$TMPDIR/backup-workspace"
openclaw agent-system backup create --dry-run --json --include 'memory/**' 'MEMORY.md' --exclude 'memory/**' | jq -e '(.files | index("MEMORY.md")) and ((.files | index("memory/day.md")) == null)'

# should clear manifest include defaults without restoring ignored memory
cd "$TMPDIR/backup-workspace"
openclaw as backup create --dry-run --json --include= | jq -e '.settings.include == [] and ((.files | index("MEMORY.md")) == null)'

# should report corrupt archive verification as a structured failure
cd "$TMPDIR/backup-workspace"
printf 'corrupt' > "$TMPDIR/bad-backup.tar.gz"
if output="$(openclaw as backup verify "$TMPDIR/bad-backup.tar.gz" --json)"; then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "failed" and (.diagnostics | length > 0)'
```
