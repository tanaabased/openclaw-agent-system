# Environment Example

This scenario uses scenario-owned workspaces on a fresh runner. It verifies ordered dotenv, 1Password Environment, and direct secret resolution; host references; required-value enforcement; and value-free environment inspection without invoking a model. One local signature verifies that the `from-op` SSH key resolves to usable private-key material.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE"

# should install the scenario-owned data workspace through agent system
cd "$GITHUB_WORKSPACE/examples/env/data"
openclaw agent-system install

# should register the vault fixture workspace for the private-key consumer check
openclaw agents add onepassword-data --workspace "$GITHUB_WORKSPACE/examples/env/onepassword" --non-interactive --json
```

## Testing

```bash
# should inspect resolved host and dotenv metadata without exposing values
cd "$GITHUB_WORKSPACE/examples/env/data"
output="$(AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env --json)"
printf '%s\n' "$output" | jq -e '.variables | any(.name == "AGENT_SYSTEM_LEIA_BARE")'
printf '%s\n' "$output" | jq -e '.variables | any(.name == "AGENT_SYSTEM_LEIA_BRACED")'
printf '%s\n' "$output" | jq -e '.variables | any(.name == "AGENT_SYSTEM_LEIA_LAYERED" and .source == "environment.dotenv[1]" and .required == false and (.overriddenSources | length) == 1)'
printf '%s\n' "$output" | jq -e '.variables | any(.name == "AGENT_SYSTEM_LEIA_SET_OVERRIDE" and .source == "environment.set" and .required == false and (.overriddenSources | length) == 1)'
printf '%s\n' "$output" | jq -e '.variables | any(.name == "AGENT_SYSTEM_LEIA_FROM_DOTENV" and .source == "environment.set" and .required == true and (.overriddenSources | length) == 0)'
printf '%s\n' "$output" | jq -e '.variables | any(.required == true)'
printf '%s\n' "$output" | jq -e '[.. | objects | has("values")] | all(. == false)'
if printf '%s\n' "$output" | grep -Fq -e 'leia-agent-system-reference' -e 'leia-agent-system-private-'; then exit 1; fi

# should report human environment metadata across wrapped lines without exposing values
cd "$GITHUB_WORKSPACE/examples/env/data"
output="$(AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env)"
# The table header is present when rows fit; narrow terminals label each field instead.
if ! printf '%s\n' "$output" | grep -Eq 'variable[[:space:]]+source[[:space:]]+required[[:space:]]+overrides'; then
  printf '%s\n' "$output" | grep -F 'variable:'
fi
assert_env_metadata() {
  printf '%s\n' "$output" | awk -v name="$1" -v source="$2" -v required="$3" -v overrides="$4" '
    $1 == name && $2 == source && $3 == required && $4 == overrides { found = 1 }
    $1 == "variable:" { in_record = ($2 == name); next }
    in_record && $1 == "source:" { actual_source = $2; next }
    in_record && $1 == "required:" { actual_required = $2; next }
    in_record && $1 == "overrides:" {
      if (actual_source == source && actual_required == required && $2 == overrides) found = 1
      in_record = 0
    }
    END { exit !found }
  '
}
assert_env_metadata AGENT_SYSTEM_LEIA_LAYERED 'environment.dotenv[1]' false 1
assert_env_metadata AGENT_SYSTEM_LEIA_SET_OVERRIDE environment.set false 1
assert_env_metadata AGENT_SYSTEM_LEIA_FROM_DOTENV environment.set true 0
if printf '%s\n' "$output" | grep -Fq -e 'leia-agent-system-reference' -e 'leia-agent-system-private-'; then exit 1; fi

# should inspect a registered agent without current workspace discovery
AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env --agent data --json | jq -e '.agentId == "data"'

# should fail when a required environment variable is absent
cd "$GITHUB_WORKSPACE/examples/env/missing-required"
if output=$(openclaw agent-system env 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'code=environment-required-missing'

# should resolve live 1password environments and direct secrets without exposing values or the bootstrap token
cd "$GITHUB_WORKSPACE/examples/env/onepassword"
output="$(openclaw agent-system env --json)"
printf '%s\n' "$output" | jq -e '.variables | any(.name == "VIBES" and .source == "environment.op[0]")'
printf '%s\n' "$output" | jq -e '.variables | any(.name == "OP_SSH_KEY" and .source == "environment.set" and .required == true)'
printf '%s\n' "$output" | jq -e '[.. | objects | has("values")] | all(. == false)'
if printf '%s\n' "$output" | grep -Fq "$OP_SERVICE_ACCOUNT_TOKEN"; then exit 1; fi

# should resolve a usable openssh private key from the declared vault reference
git init --quiet "$GITHUB_WORKSPACE/examples/env/onepassword/repository"
cd "$GITHUB_WORKSPACE/examples/env/onepassword/repository"
openclaw agent-system tool git -- commit --quiet --allow-empty --message 'verify resolved private key'
git -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=$GITHUB_WORKSPACE/examples/env/onepassword/.agent-system/allowed_signers" verify-commit HEAD

# should validate access to every declared 1password resource without returning values
cd "$GITHUB_WORKSPACE/examples/env/onepassword"
output=$(openclaw agent-system credentials validate op --from-env)
printf '%s\n' "$output" | grep -F 'environments' | grep -F '1'
printf '%s\n' "$output" | grep -F 'secrets' | grep -F '1'
```
