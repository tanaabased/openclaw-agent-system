# Google

Agent System runs a reviewed GoG command surface with one ordinary Google user
OAuth account per OpenClaw agent. The host supplies GoG **v0.42.0**; Agent System
neither installs the binary nor implements OAuth consent. Google scopes and
resource permissions remain authoritative. No additional ClawHub skill, GoG
plugin, or MCP server is needed.

Standalone Codex keeps native host-authorized Google operations. Its Agent System
Doctor and Install remain limited to Codex setup steps.

## Configuration

Declare `google` in the workspace's `agent.yaml`:

| Field                 | Type                                  | Required | Default       | Description                                                                                                                 |
| --------------------- | ------------------------------------- | -------- | ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `account`             | [ResolvableString](../../MANIFEST.md) | no       | `agent.email` | Expected Google account; an explicit value overrides the agent email. One must be declared and resolve to a Google email.   |
| `credential-encoding` | `json` or `base64`                    | no       | `json`        | Representation of both OAuth JSON bindings. Base64 must be canonical, padded, single-line UTF-8 JSON; it is not encryption. |
| `oauth-client`        | environment binding name              | yes      | none          | Complete downloaded Desktop OAuth client JSON.                                                                              |
| `oauth-token`         | environment binding name              | yes      | none          | Complete GoG-exported refresh authorization JSON for this account.                                                          |
| `keyring-password`    | environment binding name              | yes      | none          | Nonempty password for this agent's encrypted file keyring.                                                                  |

```yaml
agent:
  id: emori
  email: emori@example.com
environment:
  op: YOUR_AGENT_ENVIRONMENT_ID
  required:
    - GOG_CREDENTIALS_JSON_B64
    - GOG_TOKEN_JSON_B64
    - GOG_KEYRING_PASSWORD
google:
  credential-encoding: base64
  oauth-client: GOG_CREDENTIALS_JSON_B64
  oauth-token: GOG_TOKEN_JSON_B64
  keyring-password: GOG_KEYRING_PASSWORD
```

Merge these fields into the existing manifest; retain `schema-version: 1` and other
agent configuration. For a different Google email, set `google.account` explicitly;
both it and `agent.email` accept environment-reference forms. Raw JSON bindings
remain supported with `credential-encoding: json` or omission. Values arrive through
[declared environment sources](../../MANIFEST.md#environment), including 1Password
Environments or individual `environment.set` secret references. Validation and
passive discovery never resolve credentials.

### Environment and state

The names below are a suggested binding convention, not extra native GoG inputs.
Only the three credential values need secret storage.

| Variable or setting                                                | Required                       | Source and precedence                                                                                             | Default                                     | Store in 1Password? |
| ------------------------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------- |
| `GOG_CREDENTIALS_JSON_B64`                                         | yes, with the example bindings | Declared agent environment; decoded according to `credential-encoding`                                            | none                                        | yes                 |
| `GOG_TOKEN_JSON_B64`                                               | yes, with the example bindings | Declared agent environment; must match the expected account and OAuth client                                      | none                                        | yes                 |
| `GOG_KEYRING_PASSWORD`                                             | yes, with the example binding  | Declared agent environment; supplied only to explicit credential consumers and GoG child processes                | none                                        | yes                 |
| `GOG_HOME`                                                         | no                             | Launching host environment wins over declared agent environment, then the derived per-agent home                  | private state root / agent ID / `tools/gog` | no                  |
| `GOG_ACCOUNT`                                                      | no                             | Managed execution ignores inherited selection and supplies the resolved `google.account`, otherwise `agent.email` | resolved email                              | no                  |
| `GOG_CLIENT`                                                       | no                             | Managed execution fixes the local label through `--client=agent-system`                                           | `agent-system`                              | no                  |
| `GOG_KEYRING_BACKEND`                                              | no                             | Managed execution fixes the backend; inherited values cannot redirect it                                          | `file`                                      | no                  |
| `GOG_AUTH_MODE`                                                    | no                             | Managed execution fixes the authentication mode                                                                   | `stored`                                    | no                  |
| `GOG_CONFIG_DIR`, `GOG_DATA_DIR`, `GOG_STATE_DIR`, `GOG_CACHE_DIR` | no                             | Derived for each managed generation or invocation; inherited overrides are discarded                              | private subdirectories                      | no                  |

Without a home override, Agent System uses
`$XDG_CONFIG_HOME/tanaab/agent-system/<agent-id>/tools/gog` when `XDG_CONFIG_HOME`
is absolute, otherwise `$HOME/.config/tanaab/agent-system/<agent-id>/tools/gog`.
A relative `XDG_CONFIG_HOME` makes the default state root unavailable. For agent
`emori` with user home `/Users/emori` and no XDG override, the durable home is
`/Users/emori/.config/tanaab/agent-system/emori/tools/gog`.

A supplied `GOG_HOME` selects the managed store root directly. Use a separate
absolute private directory per agent, outside workspaces and admitted worktrees.
A receipt binds an overridden home to one agent; another agent cannot reuse it.
For CI, set `GOG_HOME` to a dedicated directory under `runner.temp`. This narrow
host override applies only to the home location; it does not import host secrets
or replace the normal environment-source precedence. Individual GoG directory,
access-token, and ADC overrides cannot bypass the managed store.

Install stores encrypted generations under that root and activates one with
`current.json`. Routine calls and Doctor use disposable private copies, so the
child's `GOG_HOME`, `HOME`, and directory variables point at that copy; they do
not change the host process's environment or runner home. The OAuth app/client
can be shared across production agents. Each Google user needs their own consent
and token export; each agent gets separate state and should get a separate keyring
password. Client ID, client secret, and project ID need no additional bindings
when the complete client JSON is provided.

## Per-agent onboarding

1. Install [GoG v0.42.0](https://github.com/openclaw/gogcli/releases/tag/v0.42.0).
   Follow the [upstream OAuth quickstart](https://gogcli.sh/quickstart.html) to
   select the Cloud project, enable needed APIs, configure the audience, and
   download a Desktop OAuth client JSON. Reuse the production client for other
   agents where appropriate; user consent is still separate.
2. Use the resolved agent email and a private operator staging home beneath the
   managed home, such as `<managed-home>/onboarding`. Run an absolute native GoG
   binary, rather than the Agent System shim. Keep the same staging home, file
   backend, password, and `agent-system` label for import, consent, and export.
3. Choose a fresh keyring password, save it in 1Password, and supply it privately
   in the operator shell. Import the downloaded client and authorize once:

```sh
# run these operator commands in a private shell with tracing disabled.
set +x
umask 077
export GOG_HOME="$HOME/.config/tanaab/agent-system/emori/tools/gog/onboarding"
export GOG_KEYRING_BACKEND=file
export GOG_AUTH_MODE=stored
unset GOG_CONFIG_DIR GOG_DATA_DIR GOG_STATE_DIR GOG_CACHE_DIR GOG_ACCESS_TOKEN GOOGLE_APPLICATION_CREDENTIALS
mkdir -p "$GOG_HOME"
GOG_BIN=/opt/homebrew/bin/gog
GOOGLE_EMAIL=emori@example.com
CLIENT_JSON=/absolute/private/path/client.json
# paste the chosen keyring password at the hidden prompt.
read -r -s GOG_KEYRING_PASSWORD
export GOG_KEYRING_PASSWORD
"$GOG_BIN" --client agent-system auth credentials set "$CLIENT_JSON" --no-input
"$GOG_BIN" --client agent-system auth add "$GOOGLE_EMAIL" --services gmail,calendar,drive,docs,sheets,slides,contacts,tasks
"$GOG_BIN" --client agent-system auth tokens export "$GOOGLE_EMAIL" --out "$GOG_HOME/authorization.json"
```

Replace the email, paths, and services with the intended agent's choices. The
password is a chosen local keyring password, not the user's Google password.
`auth add` is the one interactive step. Request identity/email access and only
needed services; GoG includes identity scopes with service authorization.

4. Save single-line Base64 of the full client and authorization files in the
   agent's 1Password environment. On macOS, these commands copy each value to
   the clipboard without printing it in terminal logs:

```sh
base64 -i "$CLIENT_JSON" | tr -d '\n' | pbcopy
base64 -i "$GOG_HOME/authorization.json" | tr -d '\n' | pbcopy
```

Paste them into `GOG_CREDENTIALS_JSON_B64` and `GOG_TOKEN_JSON_B64`, respectively.
Store the chosen password as `GOG_KEYRING_PASSWORD`. Base64 remains a secret.

5. Configure the per-agent manifest bindings. Unset the staging `GOG_HOME`, then
   run the managed lifecycle from that agent's workspace:

```sh
unset GOG_HOME GOG_KEYRING_PASSWORD
openclaw agent-system install --json
openclaw agent-system doctor --json
openclaw agent-system tool gog -- tasks lists list --max 1
```

Choose a read command for a service the agent authorized. A healthy Google finding
reports a live authenticated email check. The harmless service read also proves
that the grant has the service permission. Calls need no interactive login after
setup. GoG performs access-token refresh; Agent System does not implement OAuth.

Only explicit Install reconciles durable state. An unchanged install verifies
through a copy without reimporting; changed account/client/token/password imports
into a new generation. Failed import or identity verification leaves the active
generation intact. Competing installs for the same home fail with an actionable
busy diagnostic; retry once the current install finishes. Ordinary calls never
repair missing state. Credential consumers resolve the declared values explicitly;
the existing secret resolver may cache them in process memory.

After managed verification succeeds, remove the identified plaintext download and
export and any no-longer-needed onboarding keyring. Retain the three secrets in
1Password. External apps in Testing can have seven-day refresh-token expiry;
follow the [upstream audience guidance](https://gogcli.sh/quickstart.html) rather
than treating Testing as a permanent unattended setup.

### Recover existing Emori credentials

After installing this updated Agent System version, reuse the saved Base64 values;
valid saved authorizations require no new consent:

1. Confirm the manifest's agent ID/email, 1Password environment, and three binding
   names. Set `credential-encoding: base64` and omit `google.account` only when
   `agent.email` is the intended Google account.
2. From Emori's workspace, unset the old shell `GOG_HOME`. Run
   `openclaw agent-system install --json`. This imports the saved values into the
   derived home using the fixed `agent-system` label; a token export's previous
   local label does not change its actual OAuth client. A fresh encrypted store
   can use a new password without changing the Google grant.
3. Run Doctor, then a harmless managed read for an already authorized service.
   Do not add Tasks or any other scope merely to perform recovery. If the grant
   is revoked/expired or lacks identity access, redo consent for the needed scopes.
4. Only after success, identify and remove old GoG-owned files from the workspace.
   Do not delete generic `config` or `data` directories wholesale. Keep saved
   credentials until the managed entrypoint works.

### Test authorization

Reuse Emori's Google account with a **separate test Cloud project and OAuth app**.
No additional Workspace user license is needed. Name the app **Tanaab Agent System
Test**, enable **Tasks API**, and create a Desktop client. For an organization-owned
project and eligible Workspace users, use an Internal audience. An External app
needs the appropriate test-user/publishing setup described upstream.

Authorize only Tasks read-only plus the identity scopes GoG includes:

```sh
# use the native binary and a separate private staging home for the test app.
export GOG_HOME="$HOME/.config/tanaab/agent-system/google-live/tools/gog/onboarding"
mkdir -p "$GOG_HOME"
"$GOG_BIN" --client agent-system auth credentials set "$CLIENT_JSON" --no-input
"$GOG_BIN" --client agent-system auth add "$GOOGLE_EMAIL" --services tasks --readonly --force-consent
"$GOG_BIN" --client agent-system auth tokens export "$GOOGLE_EMAIL" --out "$GOG_HOME/authorization.json"
```

Use the test client's JSON and a separate password, following the private-shell
steps above. Verify that consent requests Tasks read access and identity, with no
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

The normal PR example matrix runs the
[Google Tasks scenario](../../examples/google/README.md) on macOS and Linux. It
imports into a fresh runner-temp `GOG_HOME`, verifies identity, confirms
unchanged installation, and reads one task list through the managed tool.
Assertions discard task data, and the ephemeral runner removes its store.
The scenario runs after the test environment is populated; this guide does not
claim live authorization has already passed.

## `agent_system_google`

Run supported Google data commands with the active agent account.

### Parameters

| Parameter | Type         | Required | Default | Description                                                    |
| --------- | ------------ | -------- | ------- | -------------------------------------------------------------- |
| `argv`    | string array | yes      | none    | Canonical GoG service/subcommand arguments and admitted flags. |
| `stdin`   | string       | no       | closed  | Optional UTF-8 command input, at most 64 KiB.                  |

### Usage

```json
{ "argv": ["gmail", "search", "is:unread", "--max", "10"] }
```

```json
{
  "argv": [
    "calendar",
    "create",
    "primary",
    "--summary",
    "Review",
    "--from",
    "2026-10-01T09:00:00-04:00",
    "--to",
    "2026-10-01T10:00:00-04:00"
  ]
}
```

```json
{ "argv": ["drive", "upload", "report.pdf"] }
```

JSON output is the default; `--plain` requests upstream plain output. The result
includes `exitCode`, `stdout`, `stderr`, `truncated`, and `status`. Authentication
rejection, insufficient scopes, provider permission denial, and missing setup have
distinct statuses; disabled APIs and unreadable keyrings have separate diagnostics. Identity mismatch stops execution before the requested operation.

### Supported commands

Use canonical command names; service and command aliases are not admitted. The
reviewed flags are defined in [the static contract](./command-contract.ts). Unknown
flags fail before credentials resolve. See the [upstream command index](https://github.com/openclaw/gogcli/tree/v0.42.0/docs/commands)
for argument details.

| Service  | Commands                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| Gmail    | `search`, `get`, `send`, `attachment`                                                                        |
| Calendar | `events`, `event`, `calendars`, `create`, `update`, `delete`                                                 |
| Drive    | `ls`, `search`, `get`, `upload`, `download`, `mkdir`, `copy`, `delete`, `rename`, `move`, `share`, `unshare` |
| Docs     | `info`, `cat`, `create`, `export`, `copy`, `insert`, `write`                                                 |
| Sheets   | `get`, `update`, `append`, `clear`, `create`, `metadata`, `export`, `copy`                                   |
| Slides   | `info`, `create`, `export`, `copy`, `list-slides`, `update-notes`, `insert-text`                             |
| Contacts | `list`, `search`, `get`, `create`, `update`, `delete`                                                        |
| Tasks    | `lists list`, `lists create`, `list`, `get`, `add`, `update`, `done`, `undo`, `delete`                       |

Auth/config administration, account/client/home/credential overrides, alternate
authentication, generic API calls, MCP, watches, sync, persisted batches, Markdown
conversion/import, diagram renderers, and unreviewed commands are unavailable.
This admission boundary protects identity and filesystem containment; it is not a
configurable Google operation policy. Ordinary supported writes remain subject to
Google authorization and any host approval mechanism.

Uploads, attachments, body files, signature files, contact input files, and notes
files must be regular files inside the agent workspace or trusted admitted
worktrees. Downloads and exports require an explicit output file inside those
roots, with an existing parent directory. Symlinks, hardlinked files, home expansion,
comma-separated file paths, and output directories are rejected. Pass repeatable
attachment flags separately. `--values-json` accepts inline JSON; `@file` input is
not admitted. Plain text file/stdin input works for Docs; Markdown processing is
excluded because it can introduce additional file and process effects.

## `gog` and `AGENT_SYSTEM_GOG`

The contextual `gog` shim uses the managed runtime inside an agent context and the
existing sanitized host-execution route outside it. Managed failures never fall
back to host credentials. `gog --agent-system` reports `agent-system` as a shim
diagnostic. The strict launcher binding `AGENT_SYSTEM_GOG` requires active-agent
authority and is suitable for bound scripts.

### Options

| Option or argument | Required | Default | Description                                          |
| ------------------ | -------- | ------- | ---------------------------------------------------- |
| GoG arguments      | yes      | none    | Same canonical command surface as the native tool.   |
| `--agent-system`   | no       | off     | Diagnostic used alone to identify the packaged shim. |

### Usage

```sh
# identify the contextual shim.
gog --agent-system

# use the strict launcher from an authorized agent-bound script.
"$AGENT_SYSTEM_GOG" gmail search 'is:unread' --max 10
```

The [generic tool CLI](../../CLI.md) remains operator-only when invoked unbound.
Private GoG state follows the [per-agent home contract](#environment-and-state). Routine calls use disposable private copies so GoG
refresh, cache, and migration effects do not change durable authentication state.
The agents still share an OS user; these are practical context and identity
boundaries, not complete operating-system isolation.
