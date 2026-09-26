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

| Field              | Type                                  | Required | Default | Description                                                       |
| ------------------ | ------------------------------------- | -------- | ------- | ----------------------------------------------------------------- |
| `account`          | [ResolvableString](../../MANIFEST.md) | yes      | none    | Expected Google account email, literal or environment reference.  |
| `oauth-client`     | environment binding name              | yes      | none    | Downloaded installed-app OAuth client JSON.                       |
| `oauth-token`      | environment binding name              | yes      | none    | GoG-exported OAuth authorization JSON containing a refresh token. |
| `keyring-password` | environment binding name              | yes      | none    | Nonempty password for the private encrypted file keyring.         |

```yaml
google:
  account: agent@example.com
  oauth-client: GOOGLE_OAUTH_CLIENT_JSON
  oauth-token: GOOGLE_OAUTH_TOKEN_JSON
  keyring-password: GOOGLE_KEYRING_PASSWORD
```

To keep the email out of tracked configuration, replace `account` with:

```yaml
google:
  account:
    from-environment: GOOGLE_ACCOUNT
  oauth-client: GOOGLE_OAUTH_CLIENT_JSON
  oauth-token: GOOGLE_OAUTH_TOKEN_JSON
  keyring-password: GOOGLE_KEYRING_PASSWORD
```

Provide the credential bindings and any account reference through the existing
[environment declarations](../../MANIFEST.md).
For example, `environment.set` can bind them to separate 1Password fields:

```yaml
environment:
  set:
    GOOGLE_ACCOUNT:
      from-op: op://agents/google/account
    GOOGLE_OAUTH_CLIENT_JSON:
      from-op: op://agents/google/oauth-client
    GOOGLE_OAUTH_TOKEN_JSON:
      from-op: op://agents/google/oauth-token
    GOOGLE_KEYRING_PASSWORD:
      from-op: op://agents/google/keyring-password
```

Neither discovery nor schema validation resolves these values. Missing or empty
references fail when an explicit consumer needs them.

## Operator setup and verification

1. Install the [selected GoG release](https://github.com/openclaw/gogcli/releases/tag/v0.42.0)
   using [upstream installation instructions](https://github.com/openclaw/gogcli/blob/v0.42.0/docs/install.md).
2. Follow the [OAuth quickstart](https://github.com/openclaw/gogcli/blob/v0.42.0/docs/quickstart.md)
   to create a Desktop OAuth client and complete consent for the intended agent
   account. Include identity/email access and only the needed Google service scopes.
3. Use upstream `gog auth tokens export EMAIL --out authorization.json` to export
   the authorization. The file contains secrets; store its JSON in the declared
   secret binding, then remove the export from ordinary working directories.
   See [token transfer](https://github.com/openclaw/gogcli/blob/v0.42.0/internal/cmd/auth_tokens.go).
4. Generate a unique password for each agent's file keyring, for example with
   `openssl rand -base64 32`, and store it in the declared secret binding. Keep it
   out of tracked YAML and shell arguments. See [headless keyring and paths](https://github.com/openclaw/gogcli/blob/v0.42.0/docs/paths.md).
5. Run `openclaw agent-system install` from the agent workspace. Install imports
   the client and refresh authorization through bounded stdin into a fresh private
   generation, checks the authenticated email against `account`, and activates
   the generation only after verification succeeds.
6. Run `openclaw agent-system doctor --json`. A healthy Google finding explicitly
   reports a **live** authentication check. Doctor contacts Google using a temporary
   credential-store copy and does not repair durable state.

Repeated installation preserves unchanged credential material. Changed client,
refresh authorization, expected account, or password requires reconciliation.
Cached access tokens from exports are discarded so verification uses the declared
refresh authorization. A failed import or identity check does not replace the
active generation. OAuth app restrictions and grant expiry still apply; use the
upstream quickstart's guidance when reauthorization becomes necessary.

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
distinct statuses. Identity mismatch stops execution before the requested operation.

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
Private GoG state is kept under Agent System's private credential-state root,
separate for each agent. Routine calls use disposable private copies so GoG
refresh, cache, and migration effects do not change durable authentication state.
The agents still share an OS user; these are practical context and identity
boundaries, not complete operating-system isolation.
