# OpenClaw Google Example

Install GoG and apply the declared Google account settings. Check the account identity
and make a read-only Tasks request through both the public command and shim. Verify
that repeat installation preserves the account.

## What Belongs Here

- Prerequisite ordering and real account credential reconciliation.
- Repeat convergence and Doctor's live identity result.
- One read-only Tasks operation through each installed managed entrypoint.

## What Does Not Belong Here

- Google API behavior, service/option permutations, or mutating application workflows.
- General 1Password cache behavior: [credentials](../openclaw-credentials/README.md). Native credential storage: [OS credentials](../os-credentials/README.md).
- Gateway/model turns; direct commands establish this contract.

## Notes

- The existing 1Password test environment owns a separate Google test application's client, exported authorization, account, and keyring password. Tasks read-only and identity scopes are required.
- Follow [Google onboarding](../../tools/google/README.md#per-agent-onboarding) for provisioning/renewal. CI supplies `OP_SERVICE_ACCOUNT_TOKEN` and isolated credential homes; authorization material is not a repository fixture.
- The job removes its stored bootstrap credential after the read-only checks.

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
