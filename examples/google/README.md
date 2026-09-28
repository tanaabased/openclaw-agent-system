# Google Tasks Example

This PR matrix example uses the existing test 1Password environment and an ordinary
Google user grant for `tasks.readonly` plus identity/email scopes. It runs the
installed Agent System plugin without a Gateway or model. The workflow supplies
the packed plugin, bootstrap 1Password access, and a runner-temp `GOG_HOME`.
The manifest installs GoG through pre-agent setup and resolves the account and
credentials from that environment. See
[Google onboarding](../../tools/google/README.md#test-authorization).

## Setup

```bash
# should prepare an isolated profile with the packed plugin and native credential store
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service

# should store the bootstrap 1password credential for the google agent
cd "$GITHUB_WORKSPACE/examples/google"
openclaw agent-system credentials set op --from-env | grep -F "$DEFAULT_CREDENTIAL_STORE"

# should install gog before google reconciliation and verify the account
cd "$GITHUB_WORKSPACE/examples/google"
openclaw agent-system install --json | jq -e '.outcomes | any(.stepId == "gog-cli" and (.status == "updated" or .status == "unchanged")) and any(.code == "google-credentials-created") and ([.[] | .stepId // .component] | index("gog-cli") < index("google"))' > /dev/null
```

## Testing

```bash
# should reuse initialized credentials and inspect live identity without reimporting
cd "$GITHUB_WORKSPACE/examples/google"
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "google-credentials-unchanged")' > /dev/null
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "google-live-identity-ready")' > /dev/null

# should read task lists through the managed tool without logging their contents
cd "$GITHUB_WORKSPACE/examples/google"
openclaw agent-system tool gog --agent google-live -- tasks lists list --max 1 --readonly | jq -e 'has("tasklists") and (.tasklists == null or (.tasklists | type) == "array")' > /dev/null
```
