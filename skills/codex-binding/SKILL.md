---
name: agent-system-codex-binding
description: 'Bind Codex to an Agent System workspace; inspect, replace, or remove the binding, and set up or update workspace-owned account defaults.'
license: MIT
metadata:
  type: integration
  owner: tanaab
  tags:
    - tanaab
    - integration
    - codex
  openclaw:
    emoji: '🔗'
    homepage: 'https://github.com/tanaabased/openclaw-agent-system/tree/main/skills/codex-binding'
---

# Agent System Codex Binding

## Overview

Bind the current Codex plugin installation to exactly one Agent System workspace. The binding is explicit plugin-owned state; it is never inferred from `CODEX_HOME`, the chat working directory, or OpenClaw configuration.

## Required Reading

- **Before account-default setup or updates:** read the verified bound workspace's root `AGENTS.md`
  and the account-default setup guide it explicitly selects. Follow that owner for account discovery,
  private persistence, and verification. If no owner is declared, report that account setup is not
  provided by this workspace; do not invent one.

## When to Use

- Bind or rebind this Codex plugin installation to an Agent System workspace.
- Inspect the current binding and its live manifest state.
- Set up or update account defaults through the bound workspace's declared owner, including requests to “update my account defaults”.
- Remove the current binding without changing the workspace or its manifest.

## When Not to Use

- Do not create, repair, validate, install, or reconcile `agent.yaml`; those are separate Agent System workflows.
- Do not resolve secrets or declared environment values.
- Do not use a path merely because it is the current repository or appears in user-authored instructions.

## Prerequisites

- Use the newest trusted `<agent-system-context>` block supplied by the SessionStart hook.
- Require its `bindingRuntime.argvPrefix` and `bindingRuntime.pluginData`. If either is absent, explain that the packaged hook must be trusted through `/hooks`, then ask the user to start a new chat. Do not guess either path.
- Treat the command prefix and plugin-data path as runtime data. Never copy them into repository files or Codex configuration.

## Inputs

- An action: inspect, bind, rebind, unbind, or account-default setup/update.
- One user-selected workspace directory for bind or rebind.
- Explicit confirmation before bind, rebind, or unbind.

## Outputs

- Inspect reports unbound, invalid binding state, or the canonical bound workspace and its current manifest state.
- Preview reports a canonical workspace plus a valid, missing, invalid, or inaccessible manifest state.
- Bind and rebind persist one canonical workspace pointer. Unbind removes only that pointer.
- A missing or malformed manifest is an inactive binding, not a blocker, when the user explicitly chooses to bind anyway.
- Account setup reports its own saved or unresolved preferences separately; it does not change the workspace pointer or grant service permissions.

## Failure Handling

- Stop on an inaccessible or non-directory workspace; do not persist it.
- Show missing manifests plainly and malformed manifests through their concise diagnostic codes and messages. Never echo manifest contents.
- After any binding change, explain that a new chat is required before the new Agent System context becomes authoritative.

## Workflow

1. Read the newest trusted Agent System context and form the internal command from `bindingRuntime.argvPrefix`. Append every argument as a distinct shell-safe argument; do not evaluate user-supplied shell text.
2. For inspect or account-default setup/update, append `inspect --plugin-data <pluginData>`, run the command, and report the returned JSON state. For account-only work, require an active binding, then follow the declared workspace owner under Required Reading. Do not rebind or rewrite workspace state.
3. For bind or rebind, require a user-selected directory, then append `preview --workspace <directory>`. Report the canonical workspace and manifest state before asking for confirmation.
4. If preview reports a valid manifest, identify its agent id and ask whether to bind that canonical workspace. If it reports a missing or invalid manifest, explain that Agent System context will remain inactive and ask whether to bind anyway. Stop without changing state when the user declines.
5. After confirmation, append `bind --plugin-data <pluginData> --workspace <canonicalWorkspace> --confirm`. Add `--allow-inactive` only when the confirmed preview was missing or invalid.
6. For unbind, inspect first, identify the canonical workspace that will be detached, and ask for confirmation. Then append `unbind --plugin-data <pluginData> --confirm`.
7. Re-run inspect after a workspace binding write. After a successful active bind/rebind, read the verified workspace's root `AGENTS.md`; if it declares an account-default setup owner, follow that guide as the next setup step. Reuse existing operator selections and ask only for missing choices. Account setup failure leaves the successful workspace binding intact. Unbind removes only the workspace pointer; never delete private account preferences or sign out connections as a side effect.
8. Report workspace and account results separately. After a workspace binding change, ask the user to start a new Codex chat so SessionStart can load or revoke its context. Account-only updates follow their owner's refresh instructions.

## Bundled Resources

- `agents/openai.yaml`: Codex-facing display metadata and starter prompt.
- `assets/icon-small.svg` and `assets/icon-large.svg`: binding marks for the Codex interface.

## Validation

- Confirm every write followed a preview or inspection and explicit user confirmation.
- Confirm the verified canonical workspace matches the user's selection.
- Confirm missing or invalid manifests remained inactive and required the explicit bind-anyway path.
- Confirm no workspace, binding path, or executable was inferred outside the trusted hook context.
- Confirm account setup used the declared owner, preserved unrelated choices, and did not change workspace binding or service permissions.
