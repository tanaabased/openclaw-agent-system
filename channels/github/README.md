# Agent System GitHub Notifications Channel

<p align="center">
  <img src="../../assets/github-icon-large.svg" alt="Agent System GitHub notifications" width="180" />
</p>

The `agent-system-github` channel discovers approved GitHub assignments and turns
accepted issue work into one private OpenClaw lifecycle per issue. It polls
through the configured agent identity, prepares managed issue worktrees, and
publishes bounded replies back to the issue or delivery pull request that
prompted them.

## Overview

- **[Configuration reference](./ADVANCED.md#configuration-reference)** — All channel fields and defaults.
- **[CLI reference](./ADVANCED.md#cli)** — Refresh intake, inspect state, and wait for lifecycle checkpoints.

Choose the initial mode through `github.notifications.initial-mode`:

| Mode     | Initial assignment behavior                                                              |
| -------- | ---------------------------------------------------------------------------------------- |
| `guided` | Prepares the session and worktree, acknowledges the assignment, and waits for direction. |
| `work`   | Assesses the issue, may publish a plan, and schedules one private implementation turn.   |

Work proceeds toward a validated change and delivery pull request. Guided waits
for direction. Approved issue and delivery pull-request comments continue in the
same private session; GitHub prose cannot elevate the configured mode. See
[processing and lifecycle](./ADVANCED.md#processing-and-lifecycle) for scheduling,
publication, and retirement behavior.

## Requirements

- Agent System installed and enabled
- Git available as `git`
- GitHub CLI available as `gh`
- an Agent System workspace manifest with an agent id and Git author email
- `git.worktrees`, `github.username`, `github.token`, and
  `github.notifications` configured
- the named GitHub token available in the completed Agent System environment
- an OpenClaw model configured for the notification agent
- the notification agent's effective OpenClaw tool profile set to `coding`

The GitHub account must have `write`, `maintain`, or `admin` access to every
repository from which the channel accepts assignments.

`github.token` names an environment variable and never accepts a literal token.
Work delivery requires [`git.ssh`](../../tools/git/README.md#gitsshprivate-keys)
for the authenticated branch push. The matching public key must already belong
to the configured GitHub account, or `github.ssh-keys` can declare it for
`install` to reconcile. SSH configuration also keeps private-repository
worktree preparation free of credential-bearing clone URLs.

## Configuration

Add the channel to `.agent-system/agent.yaml` or the root `agent.yaml`. Replace
the account, SSH paths, and pinned GitHub identities with your own:

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot
  email: tanaabot@tanaab.dev
  emoji: 🤖

environment:
  required:
    - GH_TOKEN_TANAABOT

git:
  worktrees: {}
  ssh:
    private-keys:
      path: ~/.ssh/id_ed25519

github:
  host: github.com
  username: tanaabot
  token: GH_TOKEN_TANAABOT
  ssh-keys: ~/.ssh/id_ed25519.pub
  notifications:
    assignment-types:
      - issue
    initial-mode: work
    interval-minutes: 5
    max-concurrent-issues: 2
    approved-actors:
      - login: pirog
        node-id: U_kgDOB9x7Qw
    allowed-repository-owners:
      - login: tanaabased
        node-id: O_kgDOB7x6Qw
```

`approved-actors` pins who may assign work; `allowed-repository-owners` restricts
which repositories are eligible. Neither grants GitHub repository access. See the
[configuration reference](./ADVANCED.md#configuration-reference) for all fields,
defaults, and optional OpenClaw operator recognition.

## Install and Verify

From the agent workspace:

```sh
# reconcile the channel and establish its assignment baseline.
openclaw agent-system install

# inspect configuration and required conversation-hook access.
openclaw agent-system doctor

# inspect the saved baseline and notification state.
openclaw agent-system notifications status --json
```

Installation records existing assignments without creating work for them. After
installation succeeds, have an approved actor assign a new issue to the configured
GitHub account in an eligible repository. The Gateway polls automatically.

A failed baseline leaves intake inactive. Install also grants the required
conversation hook; if the Gateway has not reloaded that permission, restart it.
See [hook access](./ADVANCED.md#required-conversation-hook) for diagnostics and
[the command reference](./ADVANCED.md#cli) to refresh intake or wait for a checkpoint.

## CLI

From the agent workspace:

```sh
# process eligible assignments and pending issue work now.
openclaw agent-system notifications refresh

# inspect saved state without advancing intake.
openclaw agent-system notifications status --json

# advance intake until this issue's worktree is ready.
openclaw agent-system notifications wait \
  --repository tanaabased/example --kind issue --number 12 \
  --for worktree-ready --refresh --json
```

See the [CLI reference](./ADVANCED.md#cli) for item selectors, timeouts, and supported checkpoints.

## Model Routing

Declare all four [model profiles](../../MANIFEST.md#models) to route new issue
conversations by complexity. Existing conversations retain their selection;
default-only manifests keep ordinary behavior. See [routing details](./ADVANCED.md#model-routing)
for assessment, permissions, overrides, and escalation.

## Current Limitations

- Automatic session appearance setup requires the assigning GitHub actor to have
  OpenClaw owner access (`commands.ownerAllowFrom`) and the native `sessions` tool
  enabled; otherwise the assignment continues without customization.
  Owner assignment requires a Gateway turn; CLI refresh can still set the color and group.
- Plan and Auto modes and mode transitions remain unavailable.
- Directly assigned pull requests retain bounded head metadata but do not create
  a managed worktree or an independent comment session.
- Work assignment turns require an implementation-ready plan; clarification is
  not yet a structured lifecycle outcome.
- Channel-owned publication begins from an admitted GitHub lifecycle. The
  GitHub Update skill is the explicit private-session path for publishing a
  missing progress update outside a notification reply turn.

## Further Reading

- [Advanced guide](./ADVANCED.md): configuration, commands, routing, security, and upgrades
- [Agent System README](../../README.md): installation and common manifest workflow
- [Global configuration](../../CONFIG.md): operator-owned plugin settings
- [Git tools](../../tools/git/README.md): identity, SSH, policy, and managed worktrees
- [GitHub CLI tool](../../tools/github/README.md): shared GitHub credentials and policy
- [Design](./DESIGN.md): target lifecycle behavior, including unimplemented features
- [Presentation](./PRESENTATION.md): reusable visible components
