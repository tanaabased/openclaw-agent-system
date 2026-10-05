# Google

Agent System runs a reviewed GoG command surface with one ordinary Google user
OAuth account per OpenClaw agent. The host supplies GoG, optionally
through [`setup-host`](../../MANIFEST.md#setup); Agent System does not implement
OAuth consent. Google scopes and resource permissions remain authoritative. No
additional ClawHub skill, GoG
plugin, or MCP server is needed.

GoG **v0.43.0** is reviewed. Stable releases **>=0.42.0 <1.0.0** are accepted;
minor and patch updates do not require an exact version match. The admitted
commands and flags remain restricted to the reviewed surface. Older releases,
prereleases, and a future 1.x release require a compatibility review.

Standalone Codex keeps native host-authorized Google operations. Its Agent System
Doctor and Install do not manage Google credentials; see [standalone Codex](../../CODEX.md).

## Configuration

Declare `google` in the workspace's `agent.yaml`:

| Field                 | Type                                  | Required | Default       | Description                                                                                                                 |
| --------------------- | ------------------------------------- | -------- | ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `account`             | [ResolvableString](../../MANIFEST.md) | no       | `agent.email` | Expected Google account; an explicit value overrides the agent email. One must be declared and resolve to a Google email.   |
| `credential-encoding` | `json` or `base64`                    | no       | `json`        | Representation of both OAuth JSON bindings. Base64 must be canonical, padded, single-line UTF-8 JSON; it is not encryption. |
| `keyring-password`    | environment binding name              | yes      | none          | Nonempty password for this agent's encrypted file keyring.                                                                  |
| `oauth-client`        | environment binding name              | yes      | none          | Complete downloaded Desktop OAuth client JSON.                                                                              |
| `oauth-token`         | environment binding name              | yes      | none          | Complete GoG-exported refresh authorization JSON for this account.                                                          |

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
| `GOG_ACCOUNT`                                                      | no                             | Managed execution ignores inherited selection and supplies the resolved `google.account`, otherwise `agent.email` | resolved email                              | no                  |
| `GOG_AUTH_MODE`                                                    | no                             | Managed execution fixes the authentication mode                                                                   | `stored`                                    | no                  |
| `GOG_CLIENT`                                                       | no                             | Managed execution fixes the local label through `--client=agent-system`                                           | `agent-system`                              | no                  |
| `GOG_CONFIG_DIR`, `GOG_DATA_DIR`, `GOG_STATE_DIR`, `GOG_CACHE_DIR` | no                             | Derived for each managed generation or invocation; inherited overrides are discarded                              | private subdirectories                      | no                  |
| `GOG_CREDENTIALS_JSON_B64`                                         | yes, with the example bindings | Declared agent environment; decoded according to `credential-encoding`                                            | none                                        | yes                 |
| `GOG_HOME`                                                         | no                             | Launching host environment wins over declared agent environment, then the derived per-agent home                  | private state root / agent ID / `tools/gog` | no                  |
| `GOG_KEYRING_BACKEND`                                              | no                             | Managed execution fixes the backend; inherited values cannot redirect it                                          | `file`                                      | no                  |
| `GOG_KEYRING_PASSWORD`                                             | yes, with the example binding  | Declared agent environment; supplied only to explicit credential consumers and GoG child processes                | none                                        | yes                 |
| `GOG_TOKEN_JSON_B64`                                               | yes, with the example bindings | Declared agent environment; must match the expected account and OAuth client                                      | none                                        | yes                 |

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

Only explicit Install changes durable authentication state. It stores encrypted
generations under the managed home and activates one with `current.json`.
Unchanged installs verify through a copy without reimporting; changed credentials
create a new generation. Failed import or identity verification preserves the
active generation. Competing installs report a busy diagnostic; retry after the
current install finishes.

Routine calls and Doctor use disposable private copies and never repair missing
state. Their `GOG_HOME`, `HOME`, and directory variables point at that copy without
changing the host environment. The OAuth app/client
can be shared across production agents. Each Google user needs their own consent
and token export; each agent gets separate state and should get a separate keyring
password. Client ID, client secret, and project ID need no additional bindings
when the complete client JSON is provided.

## Per-agent onboarding

1. Install [GoG v0.43.0](https://github.com/openclaw/gogcli/releases/tag/v0.43.0)
   or a compatible stable release in the range above.
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

After managed verification succeeds, remove the identified plaintext download and
export and any no-longer-needed onboarding keyring. Retain the three secrets in
1Password. External apps in Testing can have seven-day refresh-token expiry;
follow the [upstream audience guidance](https://gogcli.sh/quickstart.html) rather
than treating Testing as a permanent unattended setup.

### Recover existing credentials

Reuse valid saved authorizations with `credential-encoding: base64`; no new
consent is needed. Confirm the agent ID/email, 1Password environment, and three
binding names. Omit `google.account` only when `agent.email` is the intended
account. Unset any old `GOG_HOME`, run `openclaw agent-system install --json`,
then Doctor and a harmless managed read for an already-authorized service.
A fresh encrypted store can use a new password without changing the Google grant;
a token export's previous local label does not change its OAuth client.

Repeat consent only for revoked or expired grants or missing identity access;
do not add service scopes merely for recovery. After verification, remove only
identified obsolete GoG files. Do not delete generic `config` or `data` directories
or discard working credentials before the managed entrypoint succeeds.

For repository CI authorization, follow the
[Google Tasks example](https://github.com/tanaabased/openclaw-agent-system/blob/main/examples/google/README.md#manual-authorization).

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
flags fail before credentials resolve. See the [upstream command index](https://github.com/openclaw/gogcli/tree/main/docs/commands)
for argument details.

| Service  | Commands                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| Calendar | `events`, `event`, `calendars`, `create`, `update`, `delete`                                                 |
| Contacts | `list`, `search`, `get`, `create`, `update`, `delete`                                                        |
| Docs     | `info`, `cat`, `create`, `export`, `copy`, `insert`, `write`                                                 |
| Drive    | `ls`, `search`, `get`, `upload`, `download`, `mkdir`, `copy`, `delete`, `rename`, `move`, `share`, `unshare` |
| Gmail    | `search`, `get`, `send`, `attachment`                                                                        |
| Sheets   | `get`, `update`, `append`, `clear`, `create`, `metadata`, `export`, `copy`                                   |
| Slides   | `info`, `create`, `export`, `copy`, `list-slides`, `update-notes`, `insert-text`                             |
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
| `--agent-system`   | no       | off     | Diagnostic used alone to identify the packaged shim. |
| GoG arguments      | yes      | none    | Same canonical command surface as the native tool.   |

### Usage

```sh
# identify the contextual shim.
gog --agent-system

# use the strict launcher from an authorized agent-bound script.
"$AGENT_SYSTEM_GOG" gmail search 'is:unread' --max 10
```

The [generic tool CLI](../../CLI.md) remains operator-only when invoked unbound.
Private GoG state follows the [per-agent home contract](#environment-and-state).
The agents still share an OS user; these are practical context and identity
boundaries, not complete operating-system isolation.
