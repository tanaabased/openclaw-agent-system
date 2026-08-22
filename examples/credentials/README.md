# Credentials Example

This scenario verifies OP credential fallback, explicit environment validation, platform-native and file storage, stdin storage, install preflight, stored resolution without the process token, and idempotent automatic removal on a fresh runner.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE" \
  --needs-secret-service
```

## Testing

```bash
# should validate the process-environment fallback against every declared op environment
cd "$GITHUB_WORKSPACE/examples/credentials/data"
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials validate op --from-env | grep -F 'process-environment'
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials validate op --from-env | grep -F 'environments' | grep -F '1'

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
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials validate op --store "$DEFAULT_CREDENTIAL_STORE" | grep -F "store:$DEFAULT_CREDENTIAL_STORE"
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials validate op --store "$DEFAULT_CREDENTIAL_STORE" | grep -F 'environments' | grep -F '1'

# should resolve stored op environment values without the process token
cd "$GITHUB_WORKSPACE/examples/credentials/data"
env -u OP_SERVICE_ACCOUNT_TOKEN XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system env --json | jq -e '.variables | any(.name == "VIBES" and .source == "environment.op[0]")'

# should install after validating the stored credential
cd "$GITHUB_WORKSPACE/examples/credentials/data"
env -u OP_SERVICE_ACCOUNT_TOKEN XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system install | grep -F 'created' | grep -F 'OpenClaw agent credential-data'

# should remove every persisted credential copy
cd "$GITHUB_WORKSPACE/examples/credentials/data"
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials unset op | grep -F 'removed' | grep -F 'op credential for credential-data'

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
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials validate op --store file | grep -F 'store:file'
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials validate op --store file | grep -F 'environments' | grep -F '1'

# should remove the explicitly selected file credential
cd "$GITHUB_WORKSPACE/examples/credentials/data"
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials unset op --store file | grep -F 'removed' | grep -F 'op credential for credential-data'

# should reject exact file-store validation after the credential is removed
cd "$GITHUB_WORKSPACE/examples/credentials/data"
if output=$(XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials validate op --store file 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'code=op-credential-missing'
```
