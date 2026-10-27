# Agent System Google Tool

<a id="google"></a>

<p align="center">
  <img src="../../skills/google-cli/assets/icon-large.svg" alt="Agent System Google CLI" width="180" />
</p>

Run supported GoG commands with a separate Google user account for each OpenClaw
agent. Install GoG on the host, optionally through [`setup-host`](../../MANIFEST.md#setup),
and complete its OAuth consent flow. Google scopes and resource permissions determine
access. You do not need another ClawHub skill, GoG plugin, or MCP server.

- [Requirements](#requirements)
- [Configuration Reference](#configuration-reference)
- [Per-agent Onboarding](#per-agent-onboarding)
- [Supported Commands](#supported-commands)
- [`agent_system_google`](#agent_system_google)
- [CLI](#cli)
  - [`openclaw agent-system tool gog`](#openclaw-agent-system-tool-gog)
- [Shim](#shim)
- [Launcher Bindings](#launcher-bindings)

## Requirements

GoG **v0.43.0** is reviewed. Stable releases **>=0.42.0 <1.0.0** are accepted; minor and
patch updates do not require an exact version match. Only the reviewed commands and
flags are supported. Older releases, prereleases, and a future 1.x release require a
compatibility review.

Standalone Codex uses your host's Google tools and authorization. Its Agent System
Doctor and Install do not manage Google credentials; see [standalone Codex](../../CODEX.md).

<a id="configuration"></a>

## Configuration Reference

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

Merge this example into the existing manifest. Store credentials through
[declared environment sources](../../MANIFEST.md#environment); validation does not
resolve them. Set `google.account` only to override the agent email.

Managed state uses `$XDG_CONFIG_HOME/tanaab/agent-system/<agent-id>/tools/gog`,
or `$HOME/.config/tanaab/agent-system/<agent-id>/tools/gog` when unset.
`XDG_CONFIG_HOME` must be absolute. Optional `GOG_HOME` overrides this location;
the host value takes precedence over the declared agent environment. Use a separate
absolute private directory per agent, outside workspaces and worktrees.

## Per-agent Onboarding

If valid client and token exports are already saved, configure their bindings and
start at step 5. Each Google user needs separate consent and a token export, even
when agents share an OAuth client. Keep a separate keyring password per agent.

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
   run Install and Doctor from that agent's workspace:

```sh
unset GOG_HOME GOG_KEYRING_PASSWORD
openclaw agent-system install --json
openclaw agent-system doctor --json
openclaw agent-system tool gog -- tasks lists list --max 1
```

Choose a read command for a service the agent authorized. Doctor checks the authenticated email. A successful service read also verifies
access to that service. Calls need no interactive login after
setup. GoG performs access-token refresh; Agent System does not implement OAuth.

After managed verification succeeds, remove the identified plaintext download and
export and any no-longer-needed onboarding keyring. Retain the three secrets in
1Password. External apps in Testing can have seven-day refresh-token expiry;
follow the [upstream audience guidance](https://gogcli.sh/quickstart.html) rather
than treating Testing as a permanent unattended setup.

## Supported Commands

Use canonical command names; service and command aliases are not supported. The reviewed
flags are defined in [the static contract](./command-contract.ts). Unknown flags fail
before credentials resolve. See the
[upstream command index](https://github.com/openclaw/gogcli/tree/main/docs/commands) for
argument details.

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
conversion/import, diagram renderers, and unreviewed commands are unavailable. These
restrictions protect the agent's identity and keep file access within its allowed
directories. They are not a configurable Google operation policy. Ordinary supported
writes remain subject to Google authorization and any host approval mechanism.

Uploads, attachments, body files, signature files, contact input files, and notes
files must be regular files inside the agent workspace or trusted admitted
worktrees. Downloads and exports require an explicit output file inside those
roots, with an existing parent directory. Symlinks, hardlinked files, home expansion,
comma-separated file paths, and output directories are rejected. Pass repeatable
attachment flags separately. `--values-json` accepts inline JSON; `@file` input is
not admitted. Plain text file/stdin input works for Docs; Markdown processing is
excluded because it can introduce additional file and process effects.

## `agent_system_google`

Run supported Google data commands with the active agent account.

### Parameters

| Parameter | Type         | Required | Default | Description                                                                                   |
| --------- | ------------ | -------- | ------- | --------------------------------------------------------------------------------------------- |
| `argv`    | string array | yes      | none    | 1–256 canonical GoG arguments and admitted flags; each argument is at most 65,536 characters. |
| `stdin`   | string       | no       | closed  | Optional UTF-8 command input, at most 64 KiB.                                                 |

### Usage

Find up to ten unread messages:

```json
{ "argv": ["gmail", "search", "is:unread", "--max", "10"] }
```

Create an event in the configured account's primary calendar:

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

Upload a file from the allowed workspace:

```json
{ "argv": ["drive", "upload", "report.pdf"] }
```

JSON output is the default; use `--plain` for plain output. Results include
`exitCode`, `stdout`, `stderr`, `truncated`, and `status`, with diagnostics for
setup, authentication, scope, and provider failures. Identity mismatch stops the
requested operation.

## CLI

### `openclaw agent-system tool gog`

Run the [supported Google commands](#supported-commands) from an operator terminal
using the selected agent's account and workspace.

#### Options

| Option or argument   | Required | Default             | Description                                 |
| -------------------- | -------- | ------------------- | ------------------------------------------- |
| `--agent <id>`       | no       | workspace discovery | Select an installed agent's workspace.      |
| `-- <GoG arguments>` | yes      | none                | Forward canonical GoG arguments after `--`. |

#### Usage

```text
openclaw agent-system tool gog [--agent <id>] -- <GoG arguments>
```

```sh
# list task lists using the current workspace's configured account.
openclaw agent-system tool gog -- tasks lists list --max 1 --readonly
```

The same supported commands and file-access limits apply as for
[`agent_system_google`](#agent_system_google).

<a id="gog-and-agent_system_gog"></a>

## Shim

Install adds the packaged `gog` shim to supported agent command paths:

```sh
# confirm that this gog belongs to agent system.
gog --agent-system

# delegate a google command through the shared tool runtime.
gog gmail search 'is:unread' --max 10
```

The packaged command uses managed Google execution in agent context and sanitized
host execution outside it. Managed failures never fall back to host credentials.
See the [command-routing contract](../../CLI.md#trust-boundary).

## Launcher Bindings

Agent-bound Gateway and setup children receive `AGENT_SYSTEM_GOG`, the absolute
path to the strict managed launcher:

```sh
# require the bound agent's google account without host fallback.
"$AGENT_SYSTEM_GOG" gmail search 'is:unread' --max 10
```

This launcher requires active-agent authority under the shared
[execution boundary](../../CLI.md#trust-boundary). The [shim](#shim) retains
its contextual host fallback.
