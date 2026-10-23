# OpenClaw Backup Example

Create and verify an archive containing explicitly included private memory and agent database state, restore it into fresh staging without changing the source, and refuse to overwrite the populated recovery target.

## What Belongs Here

- Actual archived/restored data despite workspace Git-ignore rules, including committed SQLite WAL content.
- Preserved safe links, executable modes, manifest identity, and source checksums.
- A populated-target refusal that preserves the existing recovery data.

## What Does Not Belong Here

- Incomplete-artifact cleanup preview/apply/repeat behavior; that needs its own bounded cleanup contract.
- Retention policy, adversarial archive permutations, or general live-agent recovery; exhaustive variants remain in source tests.

## Notes

- Direct Ubuntu commands need no Gateway, model, or provider credential. The checked-in workspace runs in place with an independent checksum baseline and separate restore target.
- The database fixture keeps real committed WAL content present during capture; restoration verifies the recovered database, not just archive membership.
- Pending relocation: cleanup fixtures distinguish incomplete artifacts from complete/uncertain and differently owned attempts, then apply cleanup twice and reverify the published backup.

## Setup

```bash
# should install a disposable workspace with explicitly included ignored memory
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
cd "$GITHUB_WORKSPACE/examples/openclaw-backup/data"
mv gitignore .gitignore
sha256sum MEMORY.md memory/day.md run.sh > "$TMPDIR/backup-source.sha256"
git init --initial-branch=main
openclaw agent-system install --yes --json | jq -e '.agentId == "backup-tanaabot"'
```

## Testing

```bash
# should create and verify a managed archive containing the private memory
cd "$GITHUB_WORKSPACE/examples/openclaw-backup/data"
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

# should preview incomplete artifacts while preserving complete and differently owned attempts
cd "$GITHUB_WORKSPACE/examples/openclaw-backup/data"
archive=$(jq -er .archive "$TMPDIR/backup-created.json")
node "$GITHUB_WORKSPACE/examples/openclaw-backup/cleanup-fixture.mjs" "$archive"
openclaw agent-system backup cleanup --agent backup-tanaabot --json | jq -e '.status == "preview" and (.deleted | length) == 0 and (.wouldDelete | length) == 2 and any(.preserved[]; .reason == "complete-or-uncertain-archive") and any(.preserved[]; .reason == "ownership-mismatch")'

# should apply bounded cleanup once and leave the published backup verified
cd "$GITHUB_WORKSPACE/examples/openclaw-backup/data"
openclaw agent-system backup cleanup --agent backup-tanaabot --apply --json | jq -e '.status == "applied" and (.deleted | length) == 2 and (.wouldDelete | length) == 0'
openclaw agent-system backup cleanup --agent backup-tanaabot --apply --json | jq -e '.status == "applied" and (.deleted | length) == 0'
archive=$(jq -er .archive "$TMPDIR/backup-created.json")
openclaw agent-system backup verify "$archive" --json | jq -e '.status == "verified" and .agentId == "backup-tanaabot"'

# should restore memory safe links and executable modes into empty staging while preserving the source
cd "$GITHUB_WORKSPACE/examples/openclaw-backup/data"
archive=$(jq -er .archive "$TMPDIR/backup-created.json")
mkdir -m 700 "$TMPDIR/backup-recovered"
openclaw agent-system backup restore "$archive" --target "$TMPDIR/backup-recovered" --json | jq -e '.status == "restored" and .agentId == "backup-tanaabot" and .coverage.openclawState == "captured"'
node "$GITHUB_WORKSPACE/examples/openclaw-backup/agent-state-fixture.mjs" verify "$TMPDIR/backup-recovered/openclaw-state/openclaw-agent.sqlite"
cmp "$GITHUB_WORKSPACE/examples/openclaw-backup/data/MEMORY.md" "$TMPDIR/backup-recovered/workspace/MEMORY.md"
cmp "$GITHUB_WORKSPACE/examples/openclaw-backup/data/memory/day.md" "$TMPDIR/backup-recovered/workspace/memory/day.md"
test -L "$TMPDIR/backup-recovered/workspace/memory-link"
test "$(readlink "$TMPDIR/backup-recovered/workspace/memory-link")" = MEMORY.md
cmp "$GITHUB_WORKSPACE/examples/openclaw-backup/data/MEMORY.md" "$TMPDIR/backup-recovered/workspace/memory-link"
test -x "$TMPDIR/backup-recovered/workspace/run.sh"
cmp "$GITHUB_WORKSPACE/examples/openclaw-backup/data/run.sh" "$TMPDIR/backup-recovered/workspace/run.sh"
jq -e '.agentId == "backup-tanaabot"' "$TMPDIR/backup-recovered/manifest.json"
sha256sum --check "$TMPDIR/backup-source.sha256"

# should refuse to overwrite the populated recovery directory
cd "$GITHUB_WORKSPACE/examples/openclaw-backup/data"
archive=$(jq -er .archive "$TMPDIR/backup-created.json")
if openclaw agent-system backup restore "$archive" --target "$TMPDIR/backup-recovered" --json > "$TMPDIR/backup-refused.json"; then exit 1; fi
jq -e '.status == "failed" and any(.diagnostics[]; .code == "backup-target-nonempty")' "$TMPDIR/backup-refused.json"
cmp "$GITHUB_WORKSPACE/examples/openclaw-backup/data/MEMORY.md" "$TMPDIR/backup-recovered/workspace/MEMORY.md"
cmp "$GITHUB_WORKSPACE/examples/openclaw-backup/data/memory/day.md" "$TMPDIR/backup-recovered/workspace/memory/day.md"
```
