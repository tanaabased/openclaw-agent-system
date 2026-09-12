# Credentials Example

Tests 1Password credential storage, fallback, validation, install preflight, removal,
and Gateway cache reuse, flush, and mutation invalidation. Storage checks use
direct commands; cache checks use two local Git consumers through strict AIMock.

## Setup

```bash
# should configure an isolated openclaw profile with the packed plugin and strict mock model
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE" \
  --needs-secret-service \
  --yolo
openclaw-aimock prepare --scenario credentials
```

## Testing

```bash
# should validate the process-environment fallback against every declared op environment
cd "$GITHUB_WORKSPACE/examples/credentials/data"
output=$(XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials validate op --from-env)
printf '%s\n' "$output" | grep -F 'process-environment'
printf '%s\n' "$output" | grep -F 'environments' | grep -F '1'

# should reject installation before openclaw mutation when no stored credential is available
cd "$GITHUB_WORKSPACE/examples/credentials/data"
if output=$(XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system install 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'code=op-credential-not-stored'
printf '%s\n' "$output" | grep -F 'credentials set op'

# should validate stdin and store it in the platform-native backend
cd "$GITHUB_WORKSPACE/examples/credentials/data"
printf '%s' "$OP_SERVICE_ACCOUNT_TOKEN" | env -u OP_SERVICE_ACCOUNT_TOKEN XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials set op --stdin | grep -F "$DEFAULT_CREDENTIAL_STORE"

# should validate only the selected platform-native store
cd "$GITHUB_WORKSPACE/examples/credentials/data"
output=$(XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials validate op --store "$DEFAULT_CREDENTIAL_STORE")
printf '%s\n' "$output" | grep -F "store:$DEFAULT_CREDENTIAL_STORE"
printf '%s\n' "$output" | grep -F 'environments' | grep -F '1'

# should resolve stored op environment values without the process token
cd "$GITHUB_WORKSPACE/examples/credentials/data"
env -u OP_SERVICE_ACCOUNT_TOKEN XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system env --json | jq -e '.variables | any(.name == "VIBES" and .source == "environment.op[0]")'

# should install after validating the stored credential
cd "$GITHUB_WORKSPACE/examples/credentials/data"
env -u OP_SERVICE_ACCOUNT_TOKEN XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system install | grep -F 'created' | grep -F 'OpenClaw agent credential-data'

# should install a second provider-backed agent for cache isolation
cd "$GITHUB_WORKSPACE/examples/credentials/peer"
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials set op --from-env
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system install

# should expose the selected policy in the installed gateway without reading provider resources
openclaw-gateway start
openclaw agent-system credentials cache status --json | jq -e '.runtime == "gateway" and .policy.mode == "process-lifetime" and .counts.resourceReads == 0'

# should summarize cache policy for human readers
output=$(NO_COLOR=1 openclaw agent-system credentials cache status)
printf '%s\n' "$output" | grep -F 'gateway' | grep -F 'process-local'
printf '%s\n' "$output" | grep -F 'policy' | grep -F 'process-lifetime'
printf '%s\n' "$output" | grep -F 'counts' | grep -F '0 reads'

# should summarize an empty agent flush without json
NO_COLOR=1 openclaw as credentials cache flush --agent credential-data | grep -F 'flushed' | grep -F 'credential-data: 0 entries'

# should flush an empty gateway through both command spellings without provider reads
openclaw agent-system credentials cache flush --agent credential-data --json | jq -e '.runtime == "gateway" and .invalidated.entries == 0 and .counts.resourceReads == 0'
openclaw as credentials cache flush --json | jq -e '.runtime == "gateway" and .invalidated.entries == 0 and .counts.resourceReads == 0'

# should warm both agents through local tool turns in the running gateway
openclaw agent \
  --agent credential-data \
  --session-key agent:credential-data:agent-system-credentials-warm \
  --message-file "$GITHUB_WORKSPACE/examples/credentials/data/warm.md" \
  --timeout 120 | grep -F 'git ready'
openclaw agent \
  --agent credential-peer \
  --session-key agent:credential-peer:agent-system-credentials-warm \
  --message-file "$GITHUB_WORKSPACE/examples/credentials/peer/warm.md" \
  --timeout 120 | grep -F 'git ready'

# should inspect both warmed agents through the gateway without making provider reads
first=$(openclaw agent-system credentials cache status --json)
printf '%s\n' "$first" | jq '.'
printf '%s\n' "$first" | jq -e '.runtime == "gateway" and .policy.mode == "process-lifetime" and ([.entries[] | select(.cached) | .agentId] | sort) == ["credential-data", "credential-peer"] and .counts.resourceReads > 0'
openclaw agent-system credentials cache status --json | jq -e --argjson first "$first" '.process.pid == $first.process.pid and .counts.resourceReads == $first.counts.resourceReads'

# should reuse credentials across separate agent turns in the same gateway
before=$(openclaw agent-system credentials cache status --json)
openclaw agent \
  --agent credential-data \
  --session-key agent:credential-data:agent-system-credentials-cache-hit \
  --message-file "$GITHUB_WORKSPACE/examples/credentials/data/cache-hit.md" \
  --timeout 120 | grep -F 'git ready'
after=$(openclaw agent-system credentials cache status --json)
printf '%s\n' "$after" | jq '.'
printf '%s\n' "$after" | jq -e --argjson before "$before" '.process.pid == $before.process.pid and .counts.resourceReads == $before.counts.resourceReads and .counts.clientCreations == $before.counts.clientCreations and .counts.hits > $before.counts.hits'

# should invalidate only the selected agent and lazily refill on its next operation
before=$(openclaw agent-system credentials cache status --json)
flushed=$(openclaw agent-system credentials cache flush --agent credential-data --json)
printf '%s\n' "$flushed" | jq '.'
printf '%s\n' "$flushed" | jq -e --argjson before "$before" '.process.pid == $before.process.pid and .invalidated.values == 1 and ([.entries[].agentId] == ["credential-peer"]) and .counts.resourceReads == $before.counts.resourceReads'
openclaw agent \
  --agent credential-data \
  --session-key agent:credential-data:agent-system-credentials-cache-refill \
  --message-file "$GITHUB_WORKSPACE/examples/credentials/data/cache-refill.md" \
  --timeout 120 | grep -F 'git ready'
after=$(openclaw agent-system credentials cache status --json)
printf '%s\n' "$after" | jq '.'
printf '%s\n' "$after" | jq -e --argjson before "$before" '.process.pid == $before.process.pid and .counts.resourceReads == ($before.counts.resourceReads + 1) and any(.entries[]; .agentId == "credential-data" and .cached)'

# should invalidate warmed gateway values after a separate credential store command
before=$(openclaw agent-system credentials cache status --json)
cd "$GITHUB_WORKSPACE/examples/credentials/data"
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials set op --from-env | grep -F 'gateway cache' | grep -F 'invalidation confirmed'
after=$(openclaw agent-system credentials cache status --json)
printf '%s\n' "$after" | jq '.'
printf '%s\n' "$after" | jq -e --argjson before "$before" '.process.pid == $before.process.pid and ([.entries[].agentId] == ["credential-peer"]) and .counts.resourceReads == $before.counts.resourceReads'
openclaw agent \
  --agent credential-data \
  --session-key agent:credential-data:agent-system-credentials-cache-mutation \
  --message-file "$GITHUB_WORKSPACE/examples/credentials/data/cache-mutation.md" \
  --timeout 120 | grep -F 'git ready'
refilled=$(openclaw agent-system credentials cache status --json)
printf '%s\n' "$refilled" | jq '.'
printf '%s\n' "$refilled" | jq -e --argjson before "$before" '.process.pid == $before.process.pid and .counts.resourceReads == ($before.counts.resourceReads + 1) and any(.entries[]; .agentId == "credential-data" and .cached)'

# should flush the running gateway without reading secrets or resetting backoff
before=$(openclaw agent-system credentials cache status --json)
flushed=$(openclaw agent-system credentials cache flush --json)
printf '%s\n' "$flushed" | jq '.'
printf '%s\n' "$flushed" | jq -e --argjson before "$before" '.runtime == "gateway" and .process.pid == $before.process.pid and .invalidated.values == 2 and (.entries | length) == 0 and .counts.resourceReads == $before.counts.resourceReads and .backoff.active == $before.backoff.active'
openclaw as credentials cache status --json | jq -e '.runtime == "gateway" and (.entries | length) == 0'

# should match the cache verification tool exchanges
openclaw-aimock evidence \
  --scenario credentials \
  --expected-evidence "$GITHUB_WORKSPACE/examples/credentials/expected-evidence.json"

# should remove every persisted credential copy
cd "$GITHUB_WORKSPACE/examples/credentials/data"
output=$(XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials unset op)
printf '%s\n' "$output" | grep -F 'removed' | grep -F 'op credential for credential-data'
printf '%s\n' "$output" | grep -F 'gateway cache' | grep -F 'invalidation confirmed'

# should leave the credential absent when removal is repeated
cd "$GITHUB_WORKSPACE/examples/credentials/data"
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials unset op | grep -F 'unchanged' | grep -F 'op credential for credential-data is not stored'

# should reject exact native-store validation after the credential is removed
cd "$GITHUB_WORKSPACE/examples/credentials/data"
if output=$(XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials validate op --store "$DEFAULT_CREDENTIAL_STORE" 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'code=op-credential-missing'

# should store and validate an explicitly selected file credential
cd "$GITHUB_WORKSPACE/examples/credentials/data"
printf '%s' "$OP_SERVICE_ACCOUNT_TOKEN" | env -u OP_SERVICE_ACCOUNT_TOKEN XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials set op --stdin --store file | grep -F 'file'
output=$(XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials validate op --store file)
printf '%s\n' "$output" | grep -F 'store:file'
printf '%s\n' "$output" | grep -F 'environments' | grep -F '1'

# should remove the explicitly selected file credential
cd "$GITHUB_WORKSPACE/examples/credentials/data"
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials unset op --store file | grep -F 'removed' | grep -F 'op credential for credential-data'

# should reject exact file-store validation after the credential is removed
cd "$GITHUB_WORKSPACE/examples/credentials/data"
if output=$(XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials validate op --store file 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'code=op-credential-missing'
```

## Cleanup

```bash
# should remove the peer credential after cache verification
cd "$GITHUB_WORKSPACE/examples/credentials/peer"
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials unset op | grep -F 'removed'

# should stop the isolated gateway
openclaw-gateway stop

# should report pending invalidation after a store command when the gateway is unavailable
cd "$GITHUB_WORKSPACE/examples/credentials/data"
output=$(XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials unset op --store file 2>&1)
printf '%s\n' "$output" | grep -F 'unchanged'
printf '%s\n' "$output" | grep -F 'Gateway invalidation is pending'

# should fail cache controls when the gateway is unavailable
if output=$(openclaw agent-system credentials cache status --json 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'Gateway cache request was not confirmed'
if output=$(openclaw agent-system credentials cache flush --json 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'Gateway cache request was not confirmed'

# should stop the strict mock model cleanly
openclaw-aimock stop
```

## Synthetic provider boundaries

These CI checks use a synthetic SDK failure without contacting 1Password.

```bash
# should register a synthetic quota agent without resolving provider values
openclaw agents add quota-diagnostic --workspace "$GITHUB_WORKSPACE/examples/credentials/quota-agent" --non-interactive

# should retain safe sdk rate-limit evidence through the installed managed cli
if output=$(OP_SERVICE_ACCOUNT_TOKEN=agent-system-synthetic-quota NODE_OPTIONS="--require=$GITHUB_WORKSPACE/examples/credentials/provider-failure.cjs" openclaw agent-system tool gh --agent quota-diagnostic api user 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'provider="1password"' | grep -F 'classification="rate-limit"' | grep -F 'httpStatus="unknown"' | grep -F 'resetAt="unknown"'
if printf '%s\n' "$output" | grep -E 'SYNTHETIC_PRIVATE|op://synthetic|Authorization:'; then exit 1; fi

# should start an isolated gateway with a synthetic sdk failure
openclaw-aimock prepare --scenario credentials
OP_SERVICE_ACCOUNT_TOKEN=agent-system-synthetic-quota NODE_OPTIONS="--require=$GITHUB_WORKSPACE/examples/credentials/provider-failure.cjs" openclaw-gateway start

# should deliver safe quota classification to the installed native tool consumer
openclaw agent --agent quota-diagnostic --session-key agent:quota-diagnostic:provider-diagnostic --message 'Use the configured Git tool to report its version for the synthetic provider diagnostic check.' --timeout 120 | grep -F 'quota reported'
openclaw-aimock evidence --scenario credentials --expected-evidence "$GITHUB_WORKSPACE/examples/credentials/quota-evidence.json"

# should stop the synthetic gateway
openclaw-gateway stop

# should stop the synthetic diagnostic model
openclaw-aimock stop
```
