# GitHub Tool Example

This scenario runs the prepared Agent System package in the default Gateway with two explicitly installed agents and a strict AIMock fixture. It verifies that GitHub lifecycle installation projects distinct OpenClaw identities, adds and diagnoses fresh ephemeral SSH authentication and signing keys, proves the already-installed path, and then verifies that Agent System and OpenClaw select each agent's configured 1Password-backed credential and authenticated account without depending on live model behavior.

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
  --message-file "$GITHUB_WORKSPACE/examples/github/whoami.md" \
  --timeout 120 | grep -F 'tanaabot'

# should identify emori through her configured github tool credential
openclaw agent \
  --agent emori \
  --session-key agent:emori:agent-system-github-leia \
  --message-file "$GITHUB_WORKSPACE/examples/github/whoami.md" \
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

# should match both strict mock tool exchanges
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
