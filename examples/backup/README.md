# Workspace Backup Example

Tests packed-plugin backups, ignored-memory selection, setup authority,
destination ignore rules, and verification. Writes stay in disposable runner state.

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
openclaw agents add backup-example --workspace "$TMPDIR/backup-workspace" --non-interactive --json
```

## Testing

```bash
# should preview ignored memory without creating any backup state
cd "$TMPDIR/backup-workspace/memory"
openclaw as backup create --dry-run --json | jq -e '.status == "preview" and .coverage.openclawState == "off" and (.files | index("MEMORY.md")) and (.files | index("memory/day.md"))'
test ! -e "$TMPDIR/backup-workspace/.agent-system"

# should keep brace alternatives root-only and tolerate optional absent glob alternatives
cd "$TMPDIR/backup-workspace"
openclaw as backup create --dry-run --json --include '{MEMORY,DREAMS,BOOTSTRAP}.md' '{optional,absent}.md' | jq -e '(.files | index("MEMORY.md")) and ((.files | index("memory/MEMORY.md")) == null) and (.diagnostics | any(.code == "backup-include-unmatched" and .path == "{optional,absent}.md"))'

# should recover ignored nested continuity through a recursive glob
cd "$TMPDIR/backup-workspace"
openclaw as backup create --dry-run --json --include '**/MEMORY.md' | jq -e '(.files | index("MEMORY.md")) and (.files | index("memory/MEMORY.md"))'

# should prevent setup checks from creating archives and allow an explicit apply
cd "$TMPDIR/backup-workspace"
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.component == "setup" and .status == "updated")'
test -f backup-applied
test "$(find .agent-system/backups -name '*.tar.gz' | wc -l | tr -d ' ')" = 1

# should verify and restore selected memory without modifying the live workspace
cd "$TMPDIR/backup-workspace"
archive="$(find .agent-system/backups -name '*.tar.gz' | head -1)"
openclaw as backup verify "$archive" --json | jq -e '.status == "verified" and .agentId == "backup-example" and .coverage.openclawState == "off"'
git check-ignore "$archive"
openclaw as backup restore "$archive" --target "$TMPDIR/backup-recovered" --json | jq -e '.status == "restored" and .agentId == "backup-example" and .coverage.openclawState == "off"'
cmp MEMORY.md "$TMPDIR/backup-recovered/workspace/MEMORY.md"
cmp memory/day.md "$TMPDIR/backup-recovered/workspace/memory/day.md"

# should describe deliberate omissions separately from staging and degraded capture
cd "$TMPDIR/backup-workspace"
archive="$(find .agent-system/backups -name '*.tar.gz' | head -1)"
NO_COLOR=1 openclaw as backup restore "$archive" --target "$TMPDIR/backup-human" > "$TMPDIR/backup-human-output"
grep -F 'archive' "$TMPDIR/backup-human-output"
grep -F 'target' "$TMPDIR/backup-human-output"
grep -F 'workspace' "$TMPDIR/backup-human-output"
grep -F 'activation' "$TMPDIR/backup-human-output" | grep -F 'not activated'
grep -F 'database disabled' "$TMPDIR/backup-human-output"
grep -F 'protected path' "$TMPDIR/backup-human-output"
grep -F 'capture scope' "$TMPDIR/backup-human-output"
grep -F 'non-atomic capture' "$TMPDIR/backup-human-output"
cmp MEMORY.md "$TMPDIR/backup-human/workspace/MEMORY.md"

# should reject reusing a populated staging target with an error message
cd "$TMPDIR/backup-workspace"
archive="$(find .agent-system/backups -name '*.tar.gz' | head -1)"
if NO_COLOR=1 openclaw as backup restore "$archive" --target "$TMPDIR/backup-human" > "$TMPDIR/backup-rejected-output" 2> "$TMPDIR/backup-rejected-messages"; then exit 1; fi
grep -F 'backup-target-nonempty' "$TMPDIR/backup-rejected-output"
grep -F 'messages' "$TMPDIR/backup-rejected-messages"
grep -F 'error' "$TMPDIR/backup-rejected-messages"
cmp MEMORY.md "$TMPDIR/backup-human/workspace/MEMORY.md"

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

# should reject a crafted traversal archive without writing outside recovery
cd "$TMPDIR/backup-workspace"
archive="$(find .agent-system/backups -name '*.tar.gz' | head -1)"
tar -xOf "$archive" manifest.json > "$TMPDIR/backup-manifest.json"
node "$GITHUB_WORKSPACE/examples/backup/traversal-fixture.mjs" "$TMPDIR/backup-manifest.json" "$TMPDIR/traversal-backup.tar.gz"
if output="$(openclaw as backup restore "$TMPDIR/traversal-backup.tar.gz" --target "$TMPDIR/traversal-recovered" --json)"; then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "failed" and (.diagnostics | any(.code == "backup-path-unsafe"))'
test ! -e "$TMPDIR/traversal-recovered"
test ! -e "$TMPDIR/escape"

# should capture committed wal data and compact the selected agent database
cd "$TMPDIR/backup-workspace"
node "$GITHUB_WORKSPACE/examples/backup/agent-state-fixture.mjs" seed "$TMPDIR/backup-agent-ready" &
fixture_pid=$!
trap 'kill "$fixture_pid" 2>/dev/null || true' EXIT
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if test -f "$TMPDIR/backup-agent-ready"; then break; fi
  sleep 1
done
test -f "$TMPDIR/backup-agent-ready"
database="$(cat "$TMPDIR/backup-agent-ready")"
test -s "$database-wal"
archive="$(openclaw as backup create --openclaw-state required --json | jq -er '.archive')"
openclaw as backup verify "$archive" --json | jq -e '.coverage.openclawState == "captured" and .snapshot.manifest.database.agentId == "backup-example"'
openclaw as backup restore "$archive" --target "$TMPDIR/backup-with-state" --json | jq -e '.status == "restored" and .coverage.openclawState == "captured"'
node "$GITHUB_WORKSPACE/examples/backup/agent-state-fixture.mjs" verify "$TMPDIR/backup-with-state/openclaw-state/openclaw-agent.sqlite"
cmp MEMORY.md "$TMPDIR/backup-with-state/workspace/MEMORY.md"
```

```bash
# should create five installed-cli backups for retention.
cd "$TMPDIR/backup-workspace"
for index in 1 2 3 4 5; do
  openclaw as backup create --output "$TMPDIR/prune-archives" --openclaw-state off --json | jq -e '.status == "created"'
done
test "$(find "$TMPDIR/prune-archives" -maxdepth 1 -name '*.tar.gz' | wc -l | tr -d ' ')" = 5
```

```bash
# should preview counted removals with selected agent and destination context.
cd "$TMPDIR/backup-workspace"
preview="$(NO_COLOR=1 openclaw as backup prune --output "$TMPDIR/prune-archives" --keep 3 --dry-run)"
printf '%s\n' "$preview" | grep -F 'mode' | grep -F 'preview'
printf '%s\n' "$preview" | grep -F 'agent' | grep -F 'backup-example'
printf '%s\n' "$preview" | grep -F 'output' | grep -F "$TMPDIR/prune-archives"
printf '%s\n' "$preview" | grep -F 'kept (3)'
printf '%s\n' "$preview" | grep -F 'would-delete (2)'
printf '%s\n' "$preview" | grep -F 'deleted (0)' | grep -F 'none'
```

```bash
# should preview and apply retention without changing the retained set.
cd "$TMPDIR/backup-workspace"
openclaw as backup prune --output "$TMPDIR/prune-archives" --keep 3 --dry-run --json | jq -e '.status == "preview" and (.kept | length) == 3 and (.wouldDelete | length) == 2 and (.deleted | length) == 0'
test "$(find "$TMPDIR/prune-archives" -maxdepth 1 -name '*.tar.gz' | wc -l | tr -d ' ')" = 5
openclaw as backup prune --output "$TMPDIR/prune-archives" --keep 3 --dry-run --json | jq -r '.kept[]' | sort > "$TMPDIR/prune-expected"
openclaw as backup prune --output "$TMPDIR/prune-archives" --keep 3 --json | jq -e '.status == "pruned" and (.deleted | length) == 2'
find "$TMPDIR/prune-archives" -maxdepth 1 -name '*.tar.gz' | sort > "$TMPDIR/prune-actual"
cmp "$TMPDIR/prune-expected" "$TMPDIR/prune-actual"
while IFS= read -r archive; do openclaw as backup verify "$archive" --json | jq -e '.status == "verified"'; done < "$TMPDIR/prune-actual"
openclaw as backup prune --output "$TMPDIR/prune-archives" --keep 3 --json | jq -e '.status == "pruned" and (.deleted | length) == 0'
```

```bash
# should show applied retention with no pending removals after pruning.
cd "$TMPDIR/backup-workspace"
applied="$(NO_COLOR=1 openclaw as backup prune --output "$TMPDIR/prune-archives" --keep 3)"
printf '%s\n' "$applied" | grep -F 'mode' | grep -F 'applied'
printf '%s\n' "$applied" | grep -F 'keep' | grep -F '3'
printf '%s\n' "$applied" | grep -F 'kept (3)'
printf '%s\n' "$applied" | grep -F 'would-delete (0)' | grep -F 'none'
printf '%s\n' "$applied" | grep -F 'deleted (0)' | grep -F 'none'
```

```bash
# should skip pruning when creation or upload fails in an automation sequence.
cd "$TMPDIR/backup-workspace"
before="$(find "$TMPDIR/prune-archives" -maxdepth 1 -name '*.tar.gz' | wc -l | tr -d ' ')"
if archive="$(false)"; then openclaw as backup prune --output "$TMPDIR/prune-archives" --keep 1; fi
if archive="$(openclaw as backup create --output "$TMPDIR/prune-archives" --openclaw-state off --json | jq -er '.archive')"; then
  if false; then openclaw as backup prune --output "$TMPDIR/prune-archives" --keep 1; fi
fi
after="$(find "$TMPDIR/prune-archives" -maxdepth 1 -name '*.tar.gz' | wc -l | tr -d ' ')"
test "$after" = "$((before + 1))"
```

```bash
# should prune only after the stubbed upload succeeds for the exact returned archive.
cd "$TMPDIR/backup-workspace"
archive="$(openclaw as backup create --output "$TMPDIR/prune-archives" --openclaw-state off --json | jq -er '.archive')"
openclaw as backup verify "$archive" --json | jq -e '.status == "verified"'
test -s "$archive"
if true; then
  openclaw as backup prune --output "$TMPDIR/prune-archives" --keep 3 --json | jq -e '.status == "pruned" and (.deleted | length) > 0'
fi
test "$(find "$TMPDIR/prune-archives" -maxdepth 1 -name '*.tar.gz' | wc -l | tr -d ' ')" = 3
```
