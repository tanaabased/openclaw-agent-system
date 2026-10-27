# Codex

The standalone Codex plugin binds your Codex profile to an agent workspace so you can
use its [GitHub notification and issue workflow](./channels/github/README.md), from
assignment and assessment through implementation and PR delivery.

- [Plugin Installation](#plugin-installation)
- [Workspace Setup](#workspace-setup)
- [Hook Trust](#hook-trust)
- [Workspace Binding](#workspace-binding)
- [Skills](#skills)
- [Additional Usage](#additional-usage)

## Plugin Installation

Install through [Codex Tools](https://github.com/tanaabased/codex-tools) without a global CLI installation:

```sh
# preview registration and installation.
npx --yes @tanaab/codex-tools install npm:@tanaab/openclaw-agent-system --dry-run --json

# install the plugin.
npx --yes @tanaab/codex-tools install npm:@tanaab/openclaw-agent-system
```

<a id="development"></a>

For source installation and cache refresh, see [Codex development](./DEVELOPMENT.md#codex).

## Workspace Setup

Clone the agent workspace you want to use, or use an existing checkout. For example,
[Me](https://github.com/pirog/me) is a Codex profile workspace:

```sh
mkdir -p ~/tanaab
git clone https://github.com/pirog/me.git ~/tanaab/me
cd ~/tanaab/me

# copy the absolute path for the binding prompt.
pwd -P
```

Open the checkout as a local project in the Codex app, or run `codex` there.
Use the desktop app when applying native automations. Git and GitHub use your host
credentials and native permissions; the plugin does not install OpenClaw-managed
credentials or intercept ordinary host `gh` commands.

<a id="runtime-execution-approval"></a>

## Hook Trust

Before binding, use `/hooks` in Codex CLI with the same profile to
[review and trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)
the installed Agent System hooks:

- **SessionStart** loads the trusted workspace binding and runtime context when a
  chat starts or resumes.
- **PermissionRequest** is optional. Trusting it delegates execution approval for
  recognized direct Agent System runtime calls, including their request data and
  commands introduced by later plugin updates. The runtime still checks task
  authorization and operator-only requirements; the hook does not independently
  assess those decisions.

Other commands and app tools keep their native approval behavior. Existing workflow
denials and provider protections still apply. Disable PermissionRequest through
`/hooks` to restore ordinary approval. See the
[native hook contract](https://learn.chatgpt.com/docs/hooks#permissionrequest) for
its behavior and [`debug`](./MANIFEST.md#debug) for diagnostic logging.

> [!IMPORTANT]
> Open a new chat after approving hooks. Plugin installation alone does not grant trust.

## Workspace Binding

In the new chat, use the workspace's absolute path:

```text
Use $agent-system-codex-binding to bind this plugin to /absolute/path/to/tanaab/me.
```

Confirm the binding, then open a new chat and run:

```text
Use $agent-system-install to initialize this installation and apply declared setup.
Then use $agent-system-doctor to check readiness.
```

Install runs [setup steps that select Codex](./MANIFEST.md#setup) and updates
native automations. Doctor inspects readiness without changing settings or running jobs.

Install creates a persistent installation UUID and readable name. Reinstalling or
rebinding preserves them. Ask Codex to “rename this instance to office-laptop” to
change its name. For a copied installation, explicitly request UUID rotation;
rotation detaches old assignment claims without transferring active work. See
[runtime ownership](./channels/github/CONFIG.md#runtimes).

## Skills

- [Codex Binding](./skills/codex-binding/SKILL.md) — Inspect, bind, replace, or remove this installation's workspace binding.

See the [shared skill inventory](./README.md#skills) for the other skills.

> [!NOTE]
> OpenClaw-managed command execution—Git, Git worktrees, GitHub CLI, and Google CLI—is
> unavailable in standalone Codex. Those skills direct Codex to native host tools and
> authorization instead; they do not provide managed credentials or tool policy.

<a id="github-notification-policy"></a>
<a id="issue-feedback"></a>
<a id="auto-mode"></a>
<a id="work-mode"></a>
<a id="pull-request-delivery"></a>
<a id="model-routing"></a>
<a id="repository-automations"></a>
<a id="ownership-and-recovery"></a>
<a id="workflow-recovery"></a>
<a id="intake-approval-recovery"></a>
<a id="reset-and-retirement"></a>
<a id="additional-setup"></a>

## Additional Usage

| Use case                                      | Guide                                                                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub assignments, feedback, and PR delivery | [GitHub Notifications setup](./channels/github/README.md#install) and [workflow examples](./channels/github/README.md#usage).                                                                                                   |
| Recurring repository work                     | [Automation declarations](./MANIFEST.md#automations) and [Codex support and limitations](./MANIFEST.md#codex-execution-and-ownership).                                                                                          |
| Model selection for new work                  | [Model profiles](./MANIFEST.md#models) and the [Model Routing tool](./tools/model-routing/README.md#agent_system_model_routing).                                                                                                |
| Interrupted issue work                        | Continue the existing task, or explicitly select an [existing PR or preserved replacement](./tools/dispatch/README.md#existing-pull-requests-and-recovery). Preserve work and uncertain attempts; never bypass a native denial. |
| Resetting intake or retiring a task           | Use [Notifications Reset](./skills/notifications-reset/SKILL.md) from an operator chat, or [Task Retirement](./skills/task-retirement/SKILL.md) for one task.                                                                   |

<a id="issue-assessment"></a>

### Register repositories for GitHub work

Managed GitHub work requires a saved local project for each repository. Dispatch uses
[configured repository locations](./tools/git/worktree/README.md#gitworktrees), or
reuses a matching saved project. If neither exists, it prepares a stable base checkout;
Codex creates a separate worktree for the issue.

When asked to register a repository, add the reported checkout as the primary folder
of one saved local Codex project. The next scheduled run verifies it and resumes work.
A new repository needs this one-time step before assignments can start unattended.

Keep the repository at its saved path while an assignment is being prepared. If you
changed the path settings, restore them before resuming. Recover interrupted clones
at their original location. Do not create replacement projects
or chats to clear a blocker.
