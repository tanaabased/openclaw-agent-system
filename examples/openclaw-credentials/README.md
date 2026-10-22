# OpenClaw Credentials Example

Verify real 1Password Environment and direct vault-secret resolution through stored bootstrap credentials, then Gateway cache reuse, per-agent flush, and credential-mutation invalidation. Strict AIMock drives five local Git tool exchanges; model judgment and live model credentials are unnecessary. The provider environment and service account are the existing disposable CI fixtures.

OpenClaw runtime tests run this example on Ubuntu with `OP_SERVICE_ACCOUNT_TOKEN`. File credentials live beneath the scenario's temporary configuration directory. Native storage and filesystem protection remain in OS coverage.

Provider failures include a bounded, redacted `providerMessage`. When the SDK supplies an HTTP status in a structured field or explicitly in its message, diagnostics include `httpStatus` and `httpStatusSource`; otherwise the status remains unknown. These details remain on the existing diagnostic output path, with credentials and declared resource references redacted.

## Setup

```bash
# should prepare the packed plugin and strict credential consumer fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --yolo
openclaw config set cron.enabled false --strict-json
openclaw-aimock prepare --scenario openclaw-credentials

# should validate and store bootstrap credentials for both provider-backed agents
export XDG_CONFIG_HOME="$TMPDIR/credential-config"
for agent in data peer; do
  cd "$GITHUB_WORKSPACE/examples/openclaw-credentials/$agent"
  printf '%s' "$OP_SERVICE_ACCOUNT_TOKEN" | env -u OP_SERVICE_ACCOUNT_TOKEN openclaw agent-system credentials set op --stdin --store file | grep -F file
  env -u OP_SERVICE_ACCOUNT_TOKEN openclaw agent-system credentials validate op --store file | grep -F 'environments' | grep -F '1'
  env -u OP_SERVICE_ACCOUNT_TOKEN openclaw agent-system env --json | jq -e '.variables | any(.name == "VIBES" and .source == "environment.op[0]")'
  env -u OP_SERVICE_ACCOUNT_TOKEN openclaw agent-system install --json | jq -e '.outcomes | any(.component == "agent" and .status == "created")'
done

# should resolve a direct vault key into a verifiable signed commit
cd "$GITHUB_WORKSPACE/examples/openclaw-credentials/direct"
export XDG_CONFIG_HOME="$TMPDIR/credential-config"
openclaw agent-system credentials set op --from-env --store file | grep -F file
env -u OP_SERVICE_ACCOUNT_TOKEN openclaw agent-system install --yes --json | jq -e '.agentId == "credential-direct"'
mkdir repository
cd repository
env -u OP_SERVICE_ACCOUNT_TOKEN openclaw agent-system tool git -- init --quiet
env -u OP_SERVICE_ACCOUNT_TOKEN openclaw agent-system tool git -- commit --quiet --allow-empty --message 'verify direct vault secret'
git -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=$GITHUB_WORKSPACE/examples/openclaw-credentials/direct/allowed_signers" verify-commit HEAD
cd "$GITHUB_WORKSPACE/examples/openclaw-credentials/direct"
openclaw agent-system credentials unset op --store file | grep -F removed

# should start the gateway using stored credentials rather than the process token
env -u OP_SERVICE_ACCOUNT_TOKEN XDG_CONFIG_HOME="$TMPDIR/credential-config" openclaw-gateway start
```

## Testing

```bash
# should expose a cold cache without reading provider resources
openclaw agent-system credentials cache status --json | jq -e '.runtime == "gateway" and .policy.mode == "process-lifetime" and .counts.resourceReads == 0'

# should warm independent agent entries through real tool consumers
openclaw agent --agent credential-data --session-key agent:credential-data:credentials-warm --message-file "$GITHUB_WORKSPACE/examples/openclaw-credentials/data/warm.md" --timeout 120 | grep -F 'git ready'
openclaw agent --agent credential-peer --session-key agent:credential-peer:credentials-warm --message-file "$GITHUB_WORKSPACE/examples/openclaw-credentials/peer/warm.md" --timeout 120 | grep -F 'git ready'
openclaw agent-system credentials cache status --json | tee "$TMPDIR/credentials-warm.json"
jq -e '.runtime == "gateway" and ([.entries[] | select(.cached) | .agentId] | sort) == ["credential-data", "credential-peer"] and .counts.resourceReads > 0' "$TMPDIR/credentials-warm.json"

# should reuse credentials on a later tool turn without another provider read
openclaw agent --agent credential-data --session-key agent:credential-data:credentials-hit --message-file "$GITHUB_WORKSPACE/examples/openclaw-credentials/data/cache-hit.md" --timeout 120 | grep -F 'git ready'
before=$(cat "$TMPDIR/credentials-warm.json")
openclaw agent-system credentials cache status --json | tee "$TMPDIR/credentials-hit.json"
jq -e --argjson before "$before" '.process.pid == $before.process.pid and .counts.resourceReads == $before.counts.resourceReads and .counts.clientCreations == $before.counts.clientCreations and .counts.hits > $before.counts.hits' "$TMPDIR/credentials-hit.json"

# should flush only the selected agent and refill lazily on its next tool turn
before=$(cat "$TMPDIR/credentials-hit.json")
openclaw agent-system credentials cache flush --agent credential-data --json | jq -e --argjson before "$before" '.process.pid == $before.process.pid and .invalidated.values == 1 and ([.entries[].agentId] == ["credential-peer"]) and .counts.resourceReads == $before.counts.resourceReads'
openclaw agent --agent credential-data --session-key agent:credential-data:credentials-refill --message-file "$GITHUB_WORKSPACE/examples/openclaw-credentials/data/cache-refill.md" --timeout 120 | grep -F 'git ready'
openclaw agent-system credentials cache status --json | tee "$TMPDIR/credentials-refill.json"
jq -e --argjson before "$before" '.process.pid == $before.process.pid and .counts.resourceReads == ($before.counts.resourceReads + 1) and any(.entries[]; .agentId == "credential-data" and .cached)' "$TMPDIR/credentials-refill.json"

# should invalidate a stored credential mutation in the gateway before its next use
cd "$GITHUB_WORKSPACE/examples/openclaw-credentials/data"
export XDG_CONFIG_HOME="$TMPDIR/credential-config"
before=$(cat "$TMPDIR/credentials-refill.json")
openclaw agent-system credentials set op --from-env --store file | grep -F 'invalidation confirmed'
openclaw agent-system credentials cache status --json | jq -e --argjson before "$before" '.process.pid == $before.process.pid and ([.entries[].agentId] == ["credential-peer"]) and .counts.resourceReads == $before.counts.resourceReads'
openclaw agent --agent credential-data --session-key agent:credential-data:credentials-mutation --message-file "$GITHUB_WORKSPACE/examples/openclaw-credentials/data/cache-mutation.md" --timeout 120 | grep -F 'git ready'
openclaw agent-system credentials cache status --json | jq -e --argjson before "$before" '.process.pid == $before.process.pid and .counts.resourceReads == ($before.counts.resourceReads + 1) and any(.entries[]; .agentId == "credential-data" and .cached)'

# should complete exactly the authored credential consumer exchanges
openclaw-aimock evidence --scenario openclaw-credentials --expected-evidence "$GITHUB_WORKSPACE/examples/openclaw-credentials/expected-evidence.json"
```

## Cleanup

```bash
# should remove the persisted bootstrap credentials and invalidate their cached values
export XDG_CONFIG_HOME="$TMPDIR/credential-config"
for agent in data peer; do
  cd "$GITHUB_WORKSPACE/examples/openclaw-credentials/$agent"
  openclaw agent-system credentials unset op --store file | grep -F removed
done
openclaw agent-system credentials cache status --json | jq -e '(.entries | length) == 0'

# should stop the gateway and strict mock provider
openclaw-gateway stop --timeout 340
openclaw-aimock stop
```
