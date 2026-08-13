---
name: agent-system-github-cli
description: Agent System GitHub CLI guidance for using the active agent's isolated GitHub credential, config, and operation policy.
license: MIT
metadata:
  type: integration
  owner: tanaab
  tags:
    - tanaab
    - integration
    - github
  openclaw:
    emoji: '🐙'
    homepage: https://github.com/tanaabased/openclaw-agent-system/tree/main/skills/github-cli
    requires:
      bins:
        - gh
    install:
      - id: brew
        kind: brew
        formula: gh
        bins:
          - gh
        label: Install GitHub CLI (brew)
---

# Agent System GitHub CLI

## Overview

Use `agent_system_github` for GitHub work when the active agent manifest contains `github`. It applies the agent's operation policy, then runs the trusted `gh` executable with that agent's Agent System environment, selected token, and isolated generated config.

## When to Use

- Work with GitHub repositories, issues, pull requests, checks, releases, Actions, or API queries.
- Use the active agent's declared GitHub identity instead of Gateway-wide credentials.
- Prefer this integration over `exec`, direct `gh`, HTTP, SDKs, or unrelated GitHub integrations.

## When Not to Use

- Use ordinary `git` tooling for local working-tree, branch, commit, or push operations.
- Do not use this skill when the active agent manifest does not configure `github`.
- Do not use it to manage GitHub authentication, aliases, extensions, or Agent System's generated config.

## Prerequisites

- The active agent has a valid Agent System manifest with `github` configured.
- `gh` is installed; the plugin skill metadata provides the Homebrew install hint.
- The completed Agent System environment contains the configured token binding or fallback `GH_TOKEN` or `GITHUB_TOKEN`.

## Inputs

Pass ordinary noninteractive `gh` arguments in `argv`. Use `stdin` only for ordinary command input whose contents are safe for the selected operation and keep it below 64 KiB. Never pass a token in arguments or stdin.

```json
{ "argv": ["api", "user", "--jq", ".login"] }
```

```json
{ "argv": ["repo", "view", "owner/repo", "--json", "name,description,url"] }
```

```json
{ "argv": ["pr", "checks", "42", "--repo", "owner/repo"] }
```

Prefer `--json` with `--jq`, or `gh api` with `--jq`, for targeted output.

## Outputs

The native tool returns structured `exitCode`, `stdout`, `stderr`, and `truncated` fields. Report the GitHub result without exposing or guessing the selected credential.

## Failure Handling

- Treat a nonzero `exitCode` and returned `stderr` as the underlying `gh` failure.
- Report missing tool, missing credential, manifest binding, or configured-username mismatch errors directly.
- Treat an Agent System denial as final for the current manifest: report the policy reason and required manifest change instead of waiting for an interactive decision.
- Do not work around containment failures with `exec`, direct HTTP, another integration, or a different GitHub identity.
- Agent System applies `github.policy.releases` before credentials load. GitHub token permissions, repository roles, organization policy, and rulesets remain authoritative for remote operations, so use least-privilege credentials.

## Workflow

1. Confirm the request is GitHub work and the active agent configures the integration.
2. Choose the narrowest noninteractive `gh` command and targeted output flags.
3. Invoke `agent_system_github` with only ordinary command arguments and optional bounded input.
4. Check `exitCode`, use `stdout` as the result, and surface concise failure details from `stderr`.

## Bundled Resources

- `agents/openai.yaml`: Codex-facing display metadata and default prompt.
- [Small GitHub icon](../../assets/github-icon-small.svg) and [large GitHub icon](../../assets/github-icon-large.svg): shared Codex and tool-guide marks.

## Validation

- Confirm the tool used the active agent rather than a model-supplied identity.
- Confirm no token or secret reference appears in arguments, stdin, results, or the response.
- For identity-sensitive work, rely on Agent System's configured-username preflight and report mismatches without retrying under another account.
