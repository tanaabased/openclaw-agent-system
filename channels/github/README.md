# GitHub Notifications

<p align="center">
  <img src="./assets/icon-large.svg" alt="Agent System GitHub Notifications" width="180" />
</p>

Activate Agent System's GitHub Notifications channel to work with your OpenClaw or
bound Codex agents like human developers. Assign them work on GitHub to start
planning, implementing, and opening pull requests for you to review. Mention them
in issue comments, pull request comments, or inline reviews to
[guide their work](#chatting).

- [Install](#install)
- [Usage](#usage)
- [Chatting](#chatting)
- [Task Retirement](#task-retirement)
- [Further Reading](#further-reading)

## Install

<a id="configuration"></a>

Start with an agent workspace and [model profiles](../../MANIFEST.md#models).
OpenClaw needs [managed Git](../../tools/git/README.md#configuration-reference) and
[GitHub credentials](../../tools/github/README.md#configuration-reference).
For standalone Codex, complete [workspace binding and hook approval](../../CODEX.md#workspace-setup)
and use the host's native Git and GitHub authorization.

Merge these fields into your existing `agent.yaml` configuration, retaining other
`github` settings. Replace the username and approved repository owners and assignment
actors with yours:

```yaml
github:
  schema-version: 3
  username: tanaabot
  runtimes: [openclaw]
  allowed-repository-owners: ['@tanaabased']
  issue-assignment:
    mode: auto
    allowed: ['@pirog']
```

Auto chooses whether to plan or implement each assignment. For Codex, use
`runtimes: [codex]`; see the [full configuration reference](./CONFIG.md) for modes,
permissions, and other options.

<a id="install-and-verify"></a>

For OpenClaw, apply the configuration and check readiness from the workspace:

```sh
openclaw agent-system install
openclaw agent-system doctor
```

For standalone Codex, use `$agent-system-install` in the app, then
`$agent-system-doctor` to check readiness.

Install creates the native `github-issue-assignment` automation and its intake chat;
subsequent installs reuse them. You do not need a separate entry under `automations`.
OpenClaw intake uses `models.default`; Codex uses `models.low`. The initial intake
baseline excludes existing assignments; assign new work after verifying the first run.

| Runtime  | Schedule                                                                                                           | Intake chat                                |
| -------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| OpenClaw | `github-issue-assignment`, visible through [automations list](../../CLI.md#openclaw-agent-system-automations-list) | `ISSUE ASSIGNMENTS` in **Agent System**    |
| Codex    | **📥 ISSUE ASSIGNMENTS** in native automations                                                                     | `ISSUE ASSIGNMENTS` under **AGENT SYSTEM** |

The intake chat reports started issues, pending assignments, capacity, and obstacles.
Follow its issue links for plans, questions, implementation, and PR delivery.

For OpenClaw, request a run and inspect its status:

```sh
openclaw agent-system notifications refresh
openclaw agent-system notifications status --json
```

`queued` confirms the request, not completion. See the [notification CLI reference](./CLI.md)
for tracking a run, waiting for a checkpoint, or resetting workflow state.

For Codex, follow a scheduled run in `ISSUE ASSIGNMENTS`, then open the issue chat.
Doctor checks setup; a completed scheduled run verifies unattended execution.

## Usage

Each example provides a complete notification configuration for an already-set-up
agent workspace. Choose one, replace the example accounts and repository owners,
and retain any existing GitHub credential and tool settings. These examples use
OpenClaw; a bound Codex workspace can use `runtimes: [codex]` instead.

Run Install and verify intake before assigning new work. Existing assignments from
before the initial baseline do not start automatically.

### Assess assigned issues before making changes

Let `@pirog` assign issues in `@tanaabased` repositories to `@tanaabot`. The agent
investigates each issue and prepares a plan, then waits for direction:

```yaml
github:
  schema-version: 3
  username: tanaabot
  runtimes: [openclaw]
  allowed-repository-owners: ['@tanaabased']
  issue-assignment:
    mode: plan
    allowed: ['@pirog']
```

Read the plan in the issue chat. To proceed, ask there or mention `@tanaabot` in an
issue comment requesting implementation and a PR. The comment must come from an
[approved feedback author](./CONFIG.md#allowed).

### Turn assignments into pull requests for review

Let `@pirog` assign implementation-ready issues to `@tanaabot`. The agent assesses
the work, implements an actionable plan, and opens a PR requesting `@pirog`'s review:

```yaml
github:
  schema-version: 3
  username: tanaabot
  runtimes: [openclaw]
  allowed-repository-owners: ['@tanaabased']
  issue-assignment:
    mode: work
    allowed: ['@pirog']
    reviewers: ['@pirog']
```

The agent asks when it needs clarification. Once the PR is ready, mention
`@tanaabot` in PR comments or inline review replies to request changes to the same
work. Configured reviewers can direct these follow-ups; merging remains your decision.

### Let the agent choose whether to plan or implement

Use Auto for a mix of straightforward fixes and issues that need discussion. Keep
one item active at a time and give the assessment guidance for that decision:

```yaml
github:
  schema-version: 3
  username: tanaabot
  runtimes: [openclaw]
  allowed-repository-owners: ['@tanaabased']
  max-concurrent-items: 1
  issue-assignment:
    mode: auto
    allowed: ['@pirog']
    reviewers: ['@pirog']
    assessment:
      guidance: |
        Prefer Work for well-defined fixes with clear acceptance criteria.
        Prefer Plan when requirements or the intended behavior need clarification.
```

Assign an issue to `@tanaabot` as `@pirog`. Auto records its Plan or Work decision:
Plan waits for direction, while Work proceeds to implementation and PR delivery.
Additional assignments wait for capacity. Guidance shapes the decision without
granting extra permissions.

## Chatting

Anyone in `issue-assignment.allowed` or `issue-assignment.reviewers` can direct
the agent by mentioning its GitHub username on a tracked issue or its linked PR.
You can also talk directly in the issue's agent chat. Use your agent's username
in place of `@tanaabot` below.

On an issue, ask a question about the plan:

> @tanaabot could you explain how this handles existing installations?

When you are ready to proceed from Plan mode:

> @tanaabot implement the plan and open a pull request.

The agent links its PR to the issue. Continue there with a PR comment:

> @tanaabot please add a test for the empty-input case and update this PR.

Or mention the agent in an inline review comment or reply:

> @tanaabot this should preserve the existing value when the option is omitted.

Replies return to the source issue, PR, or review thread, while the agent chat keeps
the full conversation. Follow-up changes update the same PR. If the agent asks for
clarification, answer in that chat or mention it in an approved GitHub comment.
Requests from other authors do not authorize work, and adding a reviewer only in
GitHub does not add them to the configured author list.

When the commenter and publishing agent use the same GitHub account, the response
stays in the agent chat rather than posting back to GitHub. If work is interrupted,
continue in the same chat and ask it to finish the missing step; avoid starting a
replacement task or reposting an uncertain reply. Native denials still require
recovery or renewed authorization.

## Task Retirement

Closing an issue, archiving its agent chat, or having an approved assignment actor
unassign the agent makes the task eligible for retirement. New workflow turns stop,
and cleanup waits for the agent to be idle and the
[cleanup grace period](../../CONFIG.md#cleanup), which defaults to
**60 minutes**. Both runtimes use the shared
`plugins.entries.agent-system.config.cleanup.graceMinutes` setting.
New activity can defer cleanup; a restart does not reset the deadline.

Retirement archives the chat and removes its owned checkout while preserving
branches and GitHub content. Unverified unassignment leaves the resources intact
and reports a warning. Before cleanup begins, verified reassignment or approved
feedback can reactivate an unarchived chat; reopening the issue alone does not.

> [!WARNING]
> For a verified closed issue, OpenClaw cleanup can discard modified or untracked
> checkout files, even if the branch name changed. Save work you need before closing
> the issue. Other retirement triggers require a clean checkout and the expected branch.

Codex uses native desktop archival and worktree preservation. If desktop settings
retain the checkout, retirement remains pending. Both runtimes preserve protected
or shared resources and unreferenced commits, and hold cleanup when ownership or
activity cannot be verified.

To retire one task explicitly, use [Task Retirement](../../skills/task-retirement/SKILL.md).
It skips the scheduled eligibility and grace period but keeps ownership, activity,
and preservation checks. It does not close or unassign the GitHub issue. A task
cannot archive its own active turn; intake can finish the pending cleanup later.

## Further Reading

- [CLI](./CLI.md) — Notification commands and run status.
- [Configuration](./CONFIG.md) — Workflow fields, defaults, and customization.
- [Issue Dispatch](../../tools/dispatch/README.md) — Start, assess, implement, or retire work directly.
