# Credentials Example

This scenario verifies OP credential fallback, explicit environment validation, stdin storage, install preflight, stored resolution without the process token, and idempotent automatic removal on a fresh runner.

## Setup

```bash
# should configure an unauthenticated local openclaw profile
openclaw onboard --non-interactive --accept-risk \
  --mode local \
  --auth-choice skip \
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

# should install and enable the packed plugin
openclaw plugins install "npm-pack:$AGENT_SYSTEM_PACKAGE" --force
openclaw plugins enable agent-system
```

## Testing

```bash
# should validate the process-environment fallback against every declared op environment
cd "$GITHUB_WORKSPACE/examples/credentials/data"
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials validate op --from-env | grep -F 'process-environment'
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials validate op --from-env | grep -F 'environments  1'

# should reject installation before openclaw mutation when no stored credential is available
cd "$GITHUB_WORKSPACE/examples/credentials/data"
if XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system install; then exit 1; fi
grep -F 'code=op-credential-not-stored' < <(XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system install 2>&1)
grep -F 'credentials set op' < <(XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system install 2>&1)

# should validate stdin and store it in the preferred available backend
cd "$GITHUB_WORKSPACE/examples/credentials/data"
printf '%s' "$OP_SERVICE_ACCOUNT_TOKEN" | env -u OP_SERVICE_ACCOUNT_TOKEN XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials set op --stdin | grep -F 'stored  op credential for credential-data'

# should validate only the explicitly selected file store
cd "$GITHUB_WORKSPACE/examples/credentials/data"
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials validate op --store file | grep -F 'store:file'
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials validate op --store file | grep -F 'environments  1'

# should resolve stored op environment values without the process token
cd "$GITHUB_WORKSPACE/examples/credentials/data"
env -u OP_SERVICE_ACCOUNT_TOKEN XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system env --json | grep -F '"name": "VIBES"'
env -u OP_SERVICE_ACCOUNT_TOKEN XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system env --json | grep -F '"source": "environment.op[0]"'

# should install after validating the stored credential
cd "$GITHUB_WORKSPACE/examples/credentials/data"
env -u OP_SERVICE_ACCOUNT_TOKEN XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system install | grep -F 'created    OpenClaw agent credential-data'

# should remove every persisted credential copy
cd "$GITHUB_WORKSPACE/examples/credentials/data"
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials unset op | grep -F 'removed  op credential for credential-data'

# should leave the credential absent when removal is repeated
cd "$GITHUB_WORKSPACE/examples/credentials/data"
XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials unset op | grep -F 'unchanged  op credential for credential-data is not stored'

# should reject exact-store validation after the credential is removed
cd "$GITHUB_WORKSPACE/examples/credentials/data"
if XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials validate op --store file; then exit 1; fi
grep -F 'code=op-credential-missing' < <(XDG_CONFIG_HOME="$TMPDIR/config" openclaw agent-system credentials validate op --store file 2>&1)
```
