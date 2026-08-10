---
name: agent-system-git-cli
description: Agent System Git guidance for using the active agent's managed identity, SSH signing, contained workspace, and operation policy.
license: MIT
metadata:
  type: integration
  owner: tanaab
  tags:
    - tanaab
    - integration
    - git
  openclaw:
    emoji: '🌿'
    homepage: https://github.com/tanaabased/openclaw-agent-system/tree/main/skills/git-cli
    requires:
      bins:
        - git
    install:
      - id: brew
        kind: brew
        formula: git
        bins:
          - git
        label: Install Git (brew)
---

# Agent System Git

## Overview

Use `agent_system_git` for working-tree and repository operations when the active agent manifest contains `git`. It applies the agent's operation policy, then runs the trusted `git` executable in a contained workspace directory with the agent's declared author and committer identity and any configured SSH signing key.

## When to Use

- Inspect or change local working trees, branches, commits, tags, and remotes.
- Fetch, pull, or push with the active agent's declared Git identity.
- Prefer this integration over `exec` or direct `git` commands.

## When Not to Use

- Use `agent_system_github` for GitHub issues, pull requests, releases, Actions, or API work.
- Do not use this skill when the active agent manifest does not configure `git`.
- Do not use it to mutate Git configuration, manage credentials, or escape the agent workspace.

## Prerequisites

- The active agent has a valid Agent System manifest with `git` configured.
- The manifest resolves both an effective name and email from `git` or `agent`.
- `git` is installed; the plugin skill metadata provides the Homebrew install hint.
- OpenSSH is installed when the manifest configures authentication or signing keys.

## Inputs

Pass ordinary noninteractive `git` arguments in `argv`. Native tool calls may provide a workspace-relative `cwd`; direct shim calls preserve the caller's directory when it is inside the agent workspace. Use `stdin` only for ordinary command input below 64 KiB.

```json
{ "argv": ["status", "--short"], "cwd": "project" }
```

```json
{ "argv": ["log", "-1", "--format=%an <%ae>"], "cwd": "project" }
```

```json
{ "argv": ["commit", "-m", "document agent identity"], "cwd": "project" }
```

## Outputs

The native tool returns structured `exitCode`, `stdout`, `stderr`, and `truncated` fields. Report the Git result without claiming that the wrapper makes an untrusted repository safe.

## Failure Handling

- Treat a nonzero `exitCode` and returned `stderr` as the underlying `git` failure.
- Report missing tool, unresolved identity, manifest binding, and workspace-containment errors directly.
- When OpenClaw requests approval, wait for the operator's decision and do not reshape the command to avoid policy.
- Do not work around denied or unknown operations with `exec`, direct `git`, alternate working-directory flags, or configuration overrides.
- Let Agent System apply configured signing automatically; do not pass signing-control flags or select another key.
- Repository-owned configuration remains a code-execution surface; do not run Git in an untrusted checkout solely because Agent System supplies the identity.

## Workflow

1. Confirm the request is Git work and the active agent configures the integration.
2. Choose the narrowest noninteractive Git command and contained working directory.
3. Invoke `agent_system_git` with only ordinary command arguments and optional bounded input.
4. Check `exitCode`, use `stdout` as the result, and surface concise failure details from `stderr`.

## Bundled Resources

- `agents/openai.yaml`: Codex-facing display metadata and default prompt.
- `agents/assets/`: skill icons.

## Validation

- Confirm the tool used the active agent rather than a model-supplied identity.
- Confirm the effective author and committer match the manifest when creating a commit.
- When signing is configured, confirm created commits and tags are signed and use local trust claims only when an allowed-signers file verifies them.
- Confirm the selected working directory stays inside the bound agent workspace.
