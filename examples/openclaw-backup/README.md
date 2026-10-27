# OpenClaw Backup Example

Back up private memory and the agent database, verify the archive, and restore it
into fresh staging without changing the source. Check that live and populated targets
are refused, and that pruning older archives remains separate from integrity checks.

## What Belongs Here

- Actual archived/restored data despite workspace Git-ignore rules, including committed SQLite WAL content.
- Preserved safe links, executable modes, manifest identity, and source checksums.
- Refusal to restore into another registered agent’s live workspace or a populated recovery target.
- Retention preview/apply agreement and retained archive integrity when an older snapshot fails explicit verification.

## What Does Not Belong Here

- Incomplete-artifact cleanup preview/apply/repeat: [backup cleanup](../openclaw-backup-cleanup/README.md).
- Exhaustive retention-policy and adversarial archive permutations, or general live-agent recovery; these remain in source tests.

## Notes

- Direct Ubuntu commands need no Gateway, model, or provider credential. The checked-in workspace runs in place with an independent checksum baseline and separate restore target.
- The database fixture keeps real committed WAL content present during capture; restoration verifies the recovered database, not just archive membership.
- After the restore checks, the historical fixture replaces snapshot entries in disposable copies of the created archive with a schema-24 marker and matching artifact metadata. It is not a complete historical OpenClaw schema. The current archive remains unchanged.

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

# should refuse a recovery target inside another registered agent workspace
cd "$GITHUB_WORKSPACE/examples/openclaw-backup/data"
openclaw agents add backup-other --workspace "$TMPDIR/backup-other" --non-interactive --json
archive=$(jq -er .archive "$TMPDIR/backup-created.json")
if openclaw agent-system backup restore "$archive" --target "$TMPDIR/backup-other/recovery" --json > "$TMPDIR/backup-live-refused.json"; then exit 1; fi
jq -e '.status == "failed" and any(.diagnostics[]; .code == "backup-target-live")' "$TMPDIR/backup-live-refused.json"
test ! -e "$TMPDIR/backup-other/recovery"

# should refuse to overwrite the populated recovery directory
cd "$GITHUB_WORKSPACE/examples/openclaw-backup/data"
archive=$(jq -er .archive "$TMPDIR/backup-created.json")
if openclaw agent-system backup restore "$archive" --target "$TMPDIR/backup-recovered" --json > "$TMPDIR/backup-refused.json"; then exit 1; fi
jq -e '.status == "failed" and any(.diagnostics[]; .code == "backup-target-nonempty")' "$TMPDIR/backup-refused.json"
cmp "$GITHUB_WORKSPACE/examples/openclaw-backup/data/MEMORY.md" "$TMPDIR/backup-recovered/workspace/MEMORY.md"
cmp "$GITHUB_WORKSPACE/examples/openclaw-backup/data/memory/day.md" "$TMPDIR/backup-recovered/workspace/memory/day.md"

# should keep explicit snapshot compatibility verification separate from retention
cd "$GITHUB_WORKSPACE/examples/openclaw-backup/data"
node "$GITHUB_WORKSPACE/examples/openclaw-backup/historical-fixture.mjs" "$TMPDIR/backup-created.json"
if openclaw agent-system backup verify .agent-system/backups/historical-2001.tar.gz --json > "$TMPDIR/prune-incompatible.json"; then exit 1; fi
jq -e '.status == "failed" and any(.diagnostics[]; .code == "backup-snapshot-failed")' "$TMPDIR/prune-incompatible.json"

# should preview retention after a source file is removed without changing archive bytes
cd "$GITHUB_WORKSPACE/examples/openclaw-backup/data"
rm run.sh
sha256sum .agent-system/backups/*.tar.gz > "$TMPDIR/prune-before.sha256"
openclaw agent-system backup prune --keep 2 --dry-run --json | tee "$TMPDIR/prune-preview.json" | jq -e '.status == "preview" and (.kept | length) == 2 and (.wouldDelete | length) == 1 and (.wouldDelete[0] | endswith("/historical-2000.tar.gz")) and (.skipped | length) == 0'
sha256sum -c "$TMPDIR/prune-before.sha256"

# should apply the previewed selection while preserving retained archives
cd "$GITHUB_WORKSPACE/examples/openclaw-backup/data"
openclaw agent-system backup prune --keep 2 --json | tee "$TMPDIR/prune-applied.json" | jq -e '.status == "pruned" and (.deleted | length) == 1 and (.wouldDelete | length) == 0'
jq -e --slurp '.[0].kept == .[1].kept and .[0].wouldDelete == .[1].deleted' "$TMPDIR/prune-preview.json" "$TMPDIR/prune-applied.json"
grep -v 'historical-2000.tar.gz' "$TMPDIR/prune-before.sha256" | sha256sum -c -
test ! -e .agent-system/backups/historical-2000.tar.gz
```
