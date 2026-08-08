# GitHub Tool Example

This scenario runs the prepared Agent System package in the default Gateway with two explicitly installed agents. It verifies that GitHub lifecycle installation adds and diagnoses fresh ephemeral SSH authentication and signing keys, proves the already-installed path, and then verifies that the tool runtime selects each agent's configured 1Password-backed credential and authenticated account through either supported invocation route.

## Setup

```bash
# should configure the default profile with the ci model
openclaw onboard --non-interactive --accept-risk \
  --mode local \
  --auth-choice openai-api-key \
  --openai-api-key "$OPENAI_API_KEY" \
  --secret-input-mode plaintext \
  --workspace "$TMPDIR/main" \
  --gateway-bind loopback \
  --skip-daemon \
  --skip-health \
  --skip-bootstrap \
  --skip-channels \
  --skip-hooks \
  --skip-search \
  --skip-skills \
  --skip-ui \
  --suppress-gateway-token-output
openclaw models set "openai/$OPENAI_MODEL"

# should install, enable, and trust the packed plugin
openclaw plugins install "npm-pack:$AGENT_SYSTEM_PACKAGE" --force
openclaw plugins enable agent-system
openclaw config set plugins.allow '["agent-system","codex"]' --strict-json

# should prepare scenario-owned generated public keys under the temporary workspace
mkdir "$TMPDIR/agent-system-github-tanaabot"
cp "$GITHUB_WORKSPACE/examples/github/tanaabot/agent.yaml" "$TMPDIR/agent-system-github-tanaabot/agent.yaml"
ssh-keygen -q -t ed25519 -N '' -C agent-system-leia-auth -f "$TMPDIR/agent-system-github-tanaabot/generated-auth"
ssh-keygen -q -t ed25519 -N '' -C agent-system-leia-signing -f "$TMPDIR/agent-system-github-tanaabot/generated-signing"

# should store access and add missing tanaabot authentication and signing keys during install
cd "$TMPDIR/agent-system-github-tanaabot"
openclaw agent-system credentials set op --from-env
output="$(openclaw agent-system install --json)"
printf '%s\n' "$output" | grep -F '"code": "add-github-ssh-keys"'
printf '%s\n' "$output" | grep -F '"code": "add-github-ssh-signing-keys"'

# should store access and install the scenario-owned emori agent through agent system
cd "$GITHUB_WORKSPACE/examples/github/emori"
openclaw agent-system credentials set op --from-env
openclaw agent-system install

# should configure both installed agents with the ci model
openclaw config set 'agents.list[0].model' "openai/$OPENAI_MODEL"
openclaw config set 'agents.list[1].model' "openai/$OPENAI_MODEL"

# should allow unattended tool execution only on the isolated ci profile
openclaw exec-policy preset yolo

# should start the default gateway as a supervised background process
(
  exec openclaw gateway run --verbose > "$TMPDIR/gateway.log" 2>&1 < /dev/null
) &
echo "$!" > "$TMPDIR/gateway.pid"
"$GITHUB_WORKSPACE/scripts/gateway-process.sh" wait
```

## Testing

```bash
# should validate the tanaabot github lifecycle declaration without remote permission preflights
cd "$TMPDIR/agent-system-github-tanaabot"
openclaw agent-system validate | grep -F 'valid' | grep -F 'github' | grep -F 'GitHub tool and account key configuration'

# should report both tanaabot github key collections healthy through doctor
cd "$TMPDIR/agent-system-github-tanaabot"
openclaw agent-system doctor | grep -F 'healthy' | grep -F 'GitHub SSH authentication keys'
openclaw agent-system doctor | grep -F 'healthy' | grep -F 'GitHub SSH signing keys'

# should keep both tanaabot github key collections unchanged on repeated install
cd "$TMPDIR/agent-system-github-tanaabot"
output="$(openclaw agent-system install --json)"
printf '%s\n' "$output" | grep -F '"code": "github-ssh-keys-unchanged"'
printf '%s\n' "$output" | grep -F '"code": "github-ssh-signing-keys-unchanged"'

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
"$GITHUB_WORKSPACE/scripts/gateway-process.sh" stop
```
