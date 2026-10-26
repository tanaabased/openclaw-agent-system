# OpenClaw Backup Prune Example

Preview and apply local retention with an owned historical snapshot that explicit verification rejects, retaining the newest archives by capture date without modifying retained bytes.

## What Belongs Here

- Public CLI preview/apply agreement for metadata-recognized historical archives.
- Explicit snapshot verification remains strict while retention does not require current-schema compatibility.

## What Does Not Belong Here

- Exhaustive metadata and concurrent-change permutations remain in source component tests.
- Capture/restore fidelity belongs in [backup](../openclaw-backup/README.md); interrupted artifacts belong in [backup cleanup](../openclaw-backup-cleanup/README.md).

## Notes

- Direct Ubuntu commands need no Gateway, model, or provider credential. Run only in GitHub Actions.
- The fixture derives disposable historical archives from this run's public creation result. Its SQLite database has a schema-24 marker and matching artifact metadata, not a complete historical OpenClaw schema. It does not migrate a database or access host backups.
- A selected retained archive is not certified restorable. The fresh workspace-only archive is explicitly verified before pruning; no upload is attempted in this local-only scenario.

## Setup

```bash
# should prepare an owned backup set with recognizable historical snapshot metadata
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
cd "$GITHUB_WORKSPACE/examples/openclaw-backup-prune/data"
openclaw agent-system install --yes --json | jq -e '.agentId == "backup-prune-tanaabot"'
openclaw agent-system backup create --json | tee "$TMPDIR/prune-created.json" | jq -e '.status == "created"'
node "$GITHUB_WORKSPACE/examples/openclaw-backup-prune/historical-fixture.mjs" "$TMPDIR/prune-created.json"
```

## Testing

```bash
# should keep explicit snapshot compatibility verification separate from retention
cd "$GITHUB_WORKSPACE/examples/openclaw-backup-prune/data"
archive=$(jq -er .archive "$TMPDIR/prune-created.json")
openclaw agent-system backup verify "$archive" --json | jq -e '.status == "verified"'
if openclaw agent-system backup verify .agent-system/backups/historical-2001.tar.gz --json > "$TMPDIR/prune-incompatible.json"; then exit 1; fi
jq -e '.status == "failed" and any(.diagnostics[]; .code == "backup-snapshot-failed" and (.message | contains("schema version 24")))' "$TMPDIR/prune-incompatible.json"

# should preview capture-date retention without changing archive bytes
cd "$GITHUB_WORKSPACE/examples/openclaw-backup-prune/data"
sha256sum .agent-system/backups/*.tar.gz > "$TMPDIR/prune-before.sha256"
openclaw agent-system backup prune --keep 2 --dry-run --json | tee "$TMPDIR/prune-preview.json" | jq -e '.status == "preview" and (.kept | length) == 2 and (.wouldDelete | length) == 1 and (.wouldDelete[0] | endswith("/historical-2000.tar.gz")) and (.skipped | length) == 0'
sha256sum -c "$TMPDIR/prune-before.sha256"

# should apply the previewed selection while preserving retained archives
cd "$GITHUB_WORKSPACE/examples/openclaw-backup-prune/data"
openclaw agent-system backup prune --keep 2 --json | tee "$TMPDIR/prune-applied.json" | jq -e '.status == "pruned" and (.deleted | length) == 1 and (.wouldDelete | length) == 0'
jq -e --slurp '.[0].kept == .[1].kept and .[0].wouldDelete == .[1].deleted' "$TMPDIR/prune-preview.json" "$TMPDIR/prune-applied.json"
grep -v 'historical-2000.tar.gz' "$TMPDIR/prune-before.sha256" | sha256sum -c -
test ! -e .agent-system/backups/historical-2000.tar.gz
```
