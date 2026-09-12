# GitHub Tool Example

Tests two agents' installation, SSH keys, distinct GitHub identities, and 1Password
cache reuse, flush, and mutation invalidation through the real Gateway with AIMock.
The [credentials example](../credentials/README.md) covers storage and cache commands.

## Setup

```bash
# should configure the default profile with the prepared plugin and strict mock model
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE" \
  --yolo
openclaw-aimock prepare --scenario github

# should prepare scenario-owned generated public keys under the temporary workspace
mkdir "$TMPDIR/agent-system-github-tanaabot"
runner_os="$(printf '%s' "$RUNNER_OS" | tr '[:upper:]' '[:lower:]')"
sed \
  -e "s/__GITHUB_RUN_ID__/$GITHUB_RUN_ID/g" \
  -e "s/__GITHUB_RUN_ATTEMPT__/$GITHUB_RUN_ATTEMPT/g" \
  -e "s/__RUNNER_OS__/$runner_os/g" \
  "$GITHUB_WORKSPACE/examples/github/tanaabot/agent.yaml" > "$TMPDIR/agent-system-github-tanaabot/agent.yaml"
ssh-keygen -q -t ed25519 -N '' -C agent-system-leia-auth -f "$TMPDIR/agent-system-github-tanaabot/generated-auth"
ssh-keygen -q -t ed25519 -N '' -C agent-system-leia-signing -f "$TMPDIR/agent-system-github-tanaabot/generated-signing"

# should store access and add missing tanaabot authentication and signing keys during install
cd "$TMPDIR/agent-system-github-tanaabot"
openclaw agent-system credentials set op --from-env
output="$(openclaw agent-system install --json)"
printf '%s\n' "$output" | jq -e '.outcomes | any(.code == "create-openclaw-github-profile")'
printf '%s\n' "$output" | jq -e '.outcomes | any(.code == "set-openclaw-github-profile")'
printf '%s\n' "$output" | jq -e '.outcomes | any(.code == "add-github-ssh-keys")'
printf '%s\n' "$output" | jq -e '.outcomes | any(.code == "add-github-ssh-signing-keys")'

# should store access and install the scenario-owned emori agent through agent system
cd "$GITHUB_WORKSPACE/examples/github/emori"
openclaw agent-system credentials set op --from-env
openclaw agent-system install

# should start the default gateway as a supervised background process
openclaw-gateway start
```

## Testing

```bash
# should grant agent system and native openclaw github tools to each installed github agent
openclaw config get agents.entries.tanaabot.tools --json | jq -e '((.allow // []) + (.alsoAllow // [])) as $tools | ($tools | index("agent_system_github") != null) and ($tools | index("github_identity_status") != null)'
openclaw config get agents.entries.emori.tools --json | jq -e '((.allow // []) + (.alsoAllow // [])) as $tools | ($tools | index("agent_system_github") != null) and ($tools | index("github_identity_status") != null)'

# should bind distinct agent-scoped openclaw github identities with manifest-derived authors
tanaabot_profile="$(openclaw config get agents.entries.tanaabot.tools.github.profileId --json | jq -r '.')"
emori_profile="$(openclaw config get agents.entries.emori.tools.github.profileId --json | jq -r '.')"
printf '%s\n' "$tanaabot_profile" | grep -E '^ghp_[a-f0-9]{32}$'
printf '%s\n' "$emori_profile" | grep -E '^ghp_[a-f0-9]{32}$'
test "$tanaabot_profile" != "$emori_profile"
openclaw config get agents.entries.tanaabot.tools.github.gitAuthor --json | jq -e '. == {"name":"MODEL L3-37","email":"tanaabot@tanaab.dev"}'
openclaw config get agents.entries.emori.tools.github.gitAuthor --json | jq -e '. == {"name":"EMORI","email":"emori@tanaab.dev"}'
```

```bash
# should explain the operator-owned policy change for a denied release mutation
cd "$GITHUB_WORKSPACE/examples/github/emori"
if output="$(openclaw agent-system tool gh -- release delete agent-system-policy-proof --yes 2>&1)"; then
  exit 1
fi
printf '%s\n' "$output" | grep -F 'denied by github.policy.releases'
printf '%s\n' "$output" | grep -F 'operator must set github.policy.releases to allow'

# should validate the tanaabot github lifecycle declaration without remote permission preflights
cd "$TMPDIR/agent-system-github-tanaabot"
openclaw agent-system validate | grep -F 'valid' | grep -F 'github' | grep -F 'GitHub tool and account key configuration'

# should report both tanaabot github key collections healthy through doctor
cd "$TMPDIR/agent-system-github-tanaabot"
output="$(openclaw agent-system doctor)"
printf '%s\n' "$output" | grep -F 'healthy' | grep -F 'agent-scoped OpenClaw GitHub identity'
printf '%s\n' "$output" | grep -F 'healthy' | grep -F 'GitHub SSH authentication keys'
printf '%s\n' "$output" | grep -F 'healthy' | grep -F 'GitHub SSH signing keys'

# should keep both tanaabot github key collections unchanged on repeated install
cd "$TMPDIR/agent-system-github-tanaabot"
output="$(openclaw agent-system install --json)"
printf '%s\n' "$output" | jq -e '.outcomes | any(.code == "openclaw-github-profile-unchanged")'
printf '%s\n' "$output" | jq -e '.outcomes | any(.code == "openclaw-github-binding-unchanged")'
printf '%s\n' "$output" | jq -e '.outcomes | any(.code == "github-ssh-keys-unchanged")'
printf '%s\n' "$output" | jq -e '.outcomes | any(.code == "github-ssh-signing-keys-unchanged")'

# should identify tanaabot through its configured github tool credential
openclaw agent \
  --agent tanaabot \
  --session-key agent:tanaabot:agent-system-github-leia \
  --message-file "$GITHUB_WORKSPACE/examples/github/tanaabot/whoami.md" \
  --timeout 120 | grep -F 'tanaabot'

# should identify emori through her configured github tool credential
openclaw agent \
  --agent emori \
  --session-key agent:emori:agent-system-github-leia \
  --message-file "$GITHUB_WORKSPACE/examples/github/emori/whoami.md" \
  --timeout 120 | grep -F 'emoriwan'

# should report emori through openclaw's agent-scoped managed github profile
openclaw gateway call tools.github.status \
  --params '{"agentId":"emori","selectedScope":"agent"}' \
  --timeout 30000 \
  --json | jq -e '
    .agentId == "emori" and
    .selectedScope == "agent" and
    .selected.configured == true and
    .selected.identity.source == "agent-override" and
    .selected.identity.credentialKind == "managed-pat" and
    .selected.identity.credentialState == "available" and
    .selected.identity.account.login == "emoriwan" and
    .effective.account.login == "emoriwan"
  '

# should inspect both warmed agents through the gateway without making provider reads
first=$(openclaw agent-system credentials cache status --json)
printf '%s\n' "$first" | jq '.'
printf '%s\n' "$first" | jq -e '.runtime == "gateway" and .policy.mode == "process-lifetime" and ([.entries[] | select(.cached) | .agentId] | sort) == ["emori", "tanaabot"] and .counts.resourceReads > 0'
openclaw agent-system credentials cache status --json | jq -e --argjson first "$first" '.process.pid == $first.process.pid and .counts.resourceReads == $first.counts.resourceReads'

# should reuse credentials across separate agent turns in the same gateway
before=$(openclaw agent-system credentials cache status --json)
openclaw agent \
  --agent emori \
  --session-key agent:emori:agent-system-github-cache-hit \
  --message-file "$GITHUB_WORKSPACE/examples/github/emori/cache-hit.md" \
  --timeout 120 | grep -F 'emoriwan'
after=$(openclaw agent-system credentials cache status --json)
printf '%s\n' "$after" | jq '.'
printf '%s\n' "$after" | jq -e --argjson before "$before" '.process.pid == $before.process.pid and .counts.resourceReads == $before.counts.resourceReads and .counts.clientCreations == $before.counts.clientCreations and .counts.hits > $before.counts.hits'

# should invalidate only the selected agent and lazily refill on its next operation
before=$(openclaw agent-system credentials cache status --json)
flushed=$(openclaw agent-system credentials cache flush --agent emori --json)
printf '%s\n' "$flushed" | jq '.'
printf '%s\n' "$flushed" | jq -e --argjson before "$before" '.process.pid == $before.process.pid and .invalidated.values == 1 and ([.entries[].agentId] == ["tanaabot"]) and .counts.resourceReads == $before.counts.resourceReads'
openclaw agent \
  --agent emori \
  --session-key agent:emori:agent-system-github-cache-refill \
  --message-file "$GITHUB_WORKSPACE/examples/github/emori/cache-refill.md" \
  --timeout 120 | grep -F 'emoriwan'
after=$(openclaw agent-system credentials cache status --json)
printf '%s\n' "$after" | jq '.'
printf '%s\n' "$after" | jq -e --argjson before "$before" '.process.pid == $before.process.pid and .counts.resourceReads == ($before.counts.resourceReads + 1) and any(.entries[]; .agentId == "emori" and .cached)'

# should invalidate warmed gateway values after a separate credential store command
before=$(openclaw agent-system credentials cache status --json)
cd "$GITHUB_WORKSPACE/examples/github/emori"
openclaw agent-system credentials set op --from-env | grep -F 'gateway cache' | grep -F 'invalidation confirmed'
after=$(openclaw agent-system credentials cache status --json)
printf '%s\n' "$after" | jq '.'
printf '%s\n' "$after" | jq -e --argjson before "$before" '.process.pid == $before.process.pid and ([.entries[].agentId] == ["tanaabot"]) and .counts.resourceReads == $before.counts.resourceReads'
openclaw agent \
  --agent emori \
  --session-key agent:emori:agent-system-github-cache-mutation \
  --message-file "$GITHUB_WORKSPACE/examples/github/emori/cache-mutation.md" \
  --timeout 120 | grep -F 'emoriwan'
refilled=$(openclaw agent-system credentials cache status --json)
printf '%s\n' "$refilled" | jq '.'
printf '%s\n' "$refilled" | jq -e --argjson before "$before" '.process.pid == $before.process.pid and .counts.resourceReads == ($before.counts.resourceReads + 1) and any(.entries[]; .agentId == "emori" and .cached)'

# should flush the running gateway without reading secrets or resetting backoff
before=$(openclaw agent-system credentials cache status --json)
flushed=$(openclaw agent-system credentials cache flush --json)
printf '%s\n' "$flushed" | jq '.'
printf '%s\n' "$flushed" | jq -e --argjson before "$before" '.runtime == "gateway" and .process.pid == $before.process.pid and .invalidated.values == 2 and (.entries | length) == 0 and .counts.resourceReads == $before.counts.resourceReads and .backoff.active == $before.backoff.active'
openclaw as credentials cache status --json | jq -e '.runtime == "gateway" and (.entries | length) == 0'

# should match the identity and cache verification tool exchanges
openclaw-aimock evidence \
  --scenario github \
  --expected-evidence "$GITHUB_WORKSPACE/examples/github/expected-evidence.json"
```

## Cleanup

```bash
# should remove only the exact generated tanaabot authentication key
key_material="$(awk '{ print $2 }' "$TMPDIR/agent-system-github-tanaabot/generated-auth.pub")"
key_id="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent tanaabot -- api --paginate /user/keys --jq ".[] | select((.key | split(\" \") | index(\"$key_material\")) != null) | .id")"
if test -n "$key_id"; then
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent tanaabot -- api --method DELETE "/user/keys/$key_id"
fi
remaining="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent tanaabot -- api --paginate /user/keys --jq ".[] | select((.key | split(\" \") | index(\"$key_material\")) != null) | .id")"
test -z "$remaining"

# should remove only the exact generated tanaabot signing key
key_material="$(awk '{ print $2 }' "$TMPDIR/agent-system-github-tanaabot/generated-signing.pub")"
key_id="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent tanaabot -- api --paginate /user/ssh_signing_keys --jq ".[] | select((.key | split(\" \") | index(\"$key_material\")) != null) | .id")"
if test -n "$key_id"; then
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent tanaabot -- api --method DELETE "/user/ssh_signing_keys/$key_id"
fi
remaining="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent tanaabot -- api --paginate /user/ssh_signing_keys --jq ".[] | select((.key | split(\" \") | index(\"$key_material\")) != null) | .id")"
test -z "$remaining"

# should stop the background gateway cleanly
openclaw-gateway stop

# should stop the strict mock model cleanly
openclaw-aimock stop
```
