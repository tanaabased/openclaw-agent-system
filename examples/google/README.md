# Google Tasks Example

This PR matrix example uses the existing test 1Password environment and an ordinary
Google user grant for `tasks.readonly` plus identity/email scopes. It runs the
installed Agent System plugin without a Gateway or model. The workflow supplies
the packed plugin, bootstrap 1Password access, and a runner-temp `GOG_HOME`.
The manifest installs GoG through `setup-host` and resolves the account and
credentials from that environment. See
[Google onboarding](../../tools/google/README.md#per-agent-onboarding).

## Manual Authorization

Reuse Emori's Google account with a **separate test Cloud project and OAuth app**.
No additional Workspace user license is needed. Name the app **Tanaab Agent System
Test**, enable **Tasks API**, and create a Desktop client. For an organization-owned
project and eligible Workspace users, use an Internal audience. An External app
needs the appropriate test-user/publishing setup described upstream.

In an operator shell, authorize only Tasks read-only plus the identity scopes GoG
includes. These are one-time provisioning commands, not executable scenario steps:

> ```sh
> # use the native binary and a separate private staging home for the test app.
> export GOG_HOME="$HOME/.config/tanaab/agent-system/google-live/tools/gog/onboarding"
> mkdir -p "$GOG_HOME"
> "$GOG_BIN" --client agent-system auth credentials set "$CLIENT_JSON" --no-input
> "$GOG_BIN" --client agent-system auth add "$GOOGLE_EMAIL" --services tasks --readonly --force-consent
> "$GOG_BIN" --client agent-system auth tokens export "$GOOGLE_EMAIL" --out "$GOG_HOME/authorization.json"
> ```

Use the test client's JSON and a separate password, following the private-shell
[onboarding steps](../../tools/google/README.md#per-agent-onboarding). Verify that consent requests Tasks read access and identity, with no
Drive, mail, or calendar access. [Google's `tasks.readonly` scope](https://developers.google.com/workspace/tasks/auth)
allows reading all this user's task lists/tasks, not modifying them; it is not a
per-list permission. A separate project avoids [combined authorization](https://developers.google.com/identity/protocols/oauth2/web-server#incrementalAuth)
with the production app. The reviewed GoG version disables incremental inclusion
when `--readonly` is selected.

Put the four named values (`GOG_ACCOUNT`, `GOG_CREDENTIALS_JSON_B64`,
`GOG_TOKEN_JSON_B64`, and `GOG_KEYRING_PASSWORD`) in the existing test 1Password environment
`jglytdfegfggijqkalco2cxexa`, which is already used by repository 1Password tests.
The repository secret `TANAAB_OP_TESTVAULT` supplies the service account; confirm it
can read these environment values. The test job does not need Google passwords,
`gcloud`, a model key, or extra project/client-ID/client-secret fields.

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
