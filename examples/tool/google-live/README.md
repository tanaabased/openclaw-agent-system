# Live Google Tasks Example

This manual-only test uses the existing test 1Password environment and an ordinary
Google user grant for `tasks.readonly` plus identity/email scopes. It runs the
installed Agent System plugin without a Gateway or model. The workflow supplies
`GOG_TEST_ACCOUNT`, `GOG_HOME`, the packed plugin, and bootstrap 1Password access.
See [Google onboarding](../../../tools/google/README.md#test-authorization).

## Setup

```bash
# should prepare an isolated profile with the packed plugin
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"

# should initialize a fresh home through agent system and verify the account
cd "$GITHUB_WORKSPACE/examples/tool/google-live"
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "google-credentials-created")' > /dev/null
```

## Testing

```bash
# should reuse initialized credentials and inspect live identity without reimporting
cd "$GITHUB_WORKSPACE/examples/tool/google-live"
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "google-credentials-unchanged")' > /dev/null
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "google-live-identity-ready")' > /dev/null

# should read task lists through the managed tool without logging their contents
cd "$GITHUB_WORKSPACE/examples/tool/google-live"
openclaw agent-system tool gog --agent google-live -- tasks lists list --max 1 --readonly | jq -e 'has("tasklists") and (.tasklists == null or (.tasklists | type) == "array")' > /dev/null
```
