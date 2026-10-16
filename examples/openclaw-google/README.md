# OpenClaw Google Example

Verify Google onboarding through the packed plugin: host setup installs GoG before credential reconciliation, repeated installation preserves the account, Doctor verifies identity, and both the public command and contextual shim perform one read-only Tasks request. No Gateway or model is needed.

The existing test 1Password environment owns the separate Google test application's client, exported authorization, account, and keyring password. Its grant needs Tasks read-only and identity scopes. Follow [Google onboarding](../../tools/google/README.md#per-agent-onboarding) to provision or renew it; never put authorization material in this repository. CI supplies bootstrap access through `OP_SERVICE_ACCOUNT_TOKEN` and isolated credential homes.

## Setup

```bash
# should install gog before reconciling the declared google account
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
cd "$GITHUB_WORKSPACE/examples/openclaw-google"
openclaw agent-system credentials set op --from-env --store file | grep -F file
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.code == "google-credentials-created") and ([.[] | .stepId // .component] | index("gog-cli") < index("google"))'
```

## Testing

```bash
# should retain the initialized account and verify its live identity
cd "$GITHUB_WORKSPACE/examples/openclaw-google"
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.code == "google-credentials-unchanged")'
openclaw agent-system doctor --json | tee "$TMPDIR/openclaw-google-doctor.json"
jq -e '.findings | any(.code == "google-live-identity-ready" and .status == "healthy")' "$TMPDIR/openclaw-google-doctor.json"

# should read task lists through the public command and installed contextual shim
cd "$GITHUB_WORKSPACE/examples/openclaw-google"
openclaw agent-system tool gog -- tasks lists list --max 1 --readonly | jq -e 'has("tasklists") and (.tasklists == null or (.tasklists | type) == "array")' > /dev/null
plugin_dir=$(openclaw plugins inspect agent-system --json | jq -er '.plugin.rootDir')
"$plugin_dir/bin/gog" tasks lists list --max 1 --readonly | jq -e 'has("tasklists") and (.tasklists == null or (.tasklists | type) == "array")' > /dev/null
```

## Cleanup

```bash
# should remove the scenario bootstrap credential
cd "$GITHUB_WORKSPACE/examples/openclaw-google"
openclaw agent-system credentials unset op --store file | grep -F removed
```
