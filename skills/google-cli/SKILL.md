---
name: agent-system-google-cli
description: Agent System Google CLI guidance for using the active agent's isolated Google account and OAuth credentials.
license: MIT
metadata:
  type: integration
  owner: tanaab
  tags:
    - tanaab
    - integration
    - google
  openclaw:
    emoji: '📬'
    homepage: https://github.com/tanaabased/openclaw-agent-system/tree/main/skills/google-cli
    requires:
      bins:
        - gog
    install:
      - id: brew
        kind: brew
        formula: openclaw/tap/gogcli
        bins:
          - gog
        label: Install GoG (brew)
---

# Agent System Google CLI

## Overview

Use `agent_system_google` for Google data operations in OpenClaw when the active
agent configures `google`. Agent System supplies one verified account, a fixed
OAuth client, and an isolated encrypted file keyring. In standalone Codex, use
native Google tools with host authorization; this skill does not enable managed
Google credentials or extend Codex's setup lifecycle.

## When to Use

- Read or modify Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts, or Tasks.
- Use the active OpenClaw agent's Google account and supplied OAuth grant.

## When Not to Use

- Authentication, consent, credential export, account switching, or config changes.
- Service accounts, domain delegation, generic API calls, MCP, or unreviewed GoG commands.
- An agent that does not configure `google`.

## Prerequisites

- The host supplies a GoG executable within the [Google tool guide's supported version range](../../tools/google/README.md).
- An operator completed consent, stored the three declared secret bindings, and
  ran Agent System install. See the [Google tool guide](../../tools/google/README.md).
- The grant includes identity email access and the scopes required by the operation.

## Inputs

Pass canonical service/subcommand arguments in `argv`, with optional UTF-8 `stdin`
up to 64 KiB. Do not supply account, client, home, credential, or interactive flags.
Use explicit workspace-contained output files for downloads and exports.

```json
{ "argv": ["gmail", "search", "is:unread", "--max", "10"] }
```

```json
{ "argv": ["drive", "download", "FILE_ID", "--out", "report.pdf"] }
```

```json
{ "argv": ["docs", "write", "DOC_ID", "--file", "-"], "stdin": "Document text" }
```

## Outputs

The tool returns `exitCode`, `stdout`, `stderr`, `truncated`, and a diagnostic
`status`. JSON is the default; `--plain` requests upstream plain output.
Google scopes and resource permissions determine remote access.

## Failure Handling

- Report missing executable/setup, account mismatch, authentication rejection,
  insufficient scopes, or provider denial directly.
- Do not retry through another account, host credentials, HTTP, or a different integration.
- Unknown commands and flags require an implementation compatibility review.
- Do not blindly replay uncertain writes after a timeout or transport failure.

## Workflow

1. Confirm trusted runtime context identifies an OpenClaw agent with `google` configured.
2. Select a supported canonical command and admitted input/output paths.
3. Invoke `agent_system_google`; use `AGENT_SYSTEM_GOG` only in an authorized bound script.
4. Check the exit code and diagnostic status before reporting the result.

## Bundled Resources

- [Google tool guide](../../tools/google/README.md): supported surface, setup, and verification.
- `agents/openai.yaml`: interface metadata and default prompt.
- [Small Google icon](./assets/icon-small.svg) and [large Google icon](./assets/icon-large.svg).

## Validation

- Confirm the managed runtime verified the declared Google account.
- Confirm credentials do not appear in arguments, results, or the response.
- Confirm local files stay within the workspace or trusted admitted worktrees.
