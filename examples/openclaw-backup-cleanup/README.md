# OpenClaw Backup Cleanup Example

Create one valid backup, preview interrupted capture artifacts, remove only owned incomplete attempts, and repeat cleanup without deleting the published archive or foreign state.

## What Belongs Here

- Preview without deletion, ownership-aware apply, and unchanged repeat cleanup.
- Preservation of complete or uncertain archives and differently owned attempts.

## What Does Not Belong Here

- WAL capture, workspace restoration, safe links, and populated-target refusal: [backup](../openclaw-backup/README.md).
- Adversarial archive and lock-loss permutations remain in source tests.

## Notes

- Direct packed-plugin checks need no Gateway, model, hosted secret, or agent database. The valid archive is created through the public command.
- The fixture uses runtime-derived filesystem identities and an exited writer to model interrupted captures; it preserves a valid complete archive and a foreign attempt.

## Setup

```bash
# should create a valid archive beside the disposable cleanup workspace
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
cd "$GITHUB_WORKSPACE/examples/openclaw-backup-cleanup/data"
openclaw agent-system install --yes --json | jq -e '.agentId == "backup-cleanup-tanaabot"'
openclaw agent-system backup create --json | tee "$TMPDIR/backup-created.json" | jq -e '.status == "created"'
```

## Testing

```bash
# should preview incomplete artifacts while preserving complete and differently owned attempts
cd "$GITHUB_WORKSPACE/examples/openclaw-backup-cleanup/data"
archive=$(jq -er .archive "$TMPDIR/backup-created.json")
node "$GITHUB_WORKSPACE/examples/openclaw-backup-cleanup/cleanup-fixture.mjs" "$archive"
openclaw agent-system backup cleanup --agent backup-cleanup-tanaabot --json | jq -e '.status == "preview" and (.deleted | length) == 0 and (.wouldDelete | length) == 2 and any(.preserved[]; .reason == "complete-or-uncertain-archive") and any(.preserved[]; .reason == "ownership-mismatch")'

# should apply bounded cleanup once and leave the published backup verified
cd "$GITHUB_WORKSPACE/examples/openclaw-backup-cleanup/data"
openclaw agent-system backup cleanup --agent backup-cleanup-tanaabot --apply --json | jq -e '.status == "applied" and (.deleted | length) == 2 and (.wouldDelete | length) == 0'
openclaw agent-system backup cleanup --agent backup-cleanup-tanaabot --apply --json | jq -e '.status == "applied" and (.deleted | length) == 0'
archive=$(jq -er .archive "$TMPDIR/backup-created.json")
openclaw agent-system backup verify "$archive" --json | jq -e '.status == "verified" and .agentId == "backup-cleanup-tanaabot"'
```
