# GitHub Notifications

Agent System turns approved GitHub issue assignments into runtime-owned work.
Native OpenClaw supports issue planning and explicitly requested implementation and
PR delivery in the same issue chat, plus authorized feedback on the issue and its
linked PR. Standalone Codex additionally supports declared automatic implementation.

## Configuration

In `agent.yaml`, set `github.schema-version: 3` and declare `issue-assignment`
directly under `github`. Identity lists accept quoted `@name`, node IDs, and pinned
objects. Declare repository owners explicitly; an empty actor list admits no new
assignments. Mode defaults to Auto; Plan stops after assessment, Work continues an
actionable plan, and Auto chooses Plan or Work. See the
[manifest reference](../../MANIFEST.md#githubnotifications) for fields, defaults,
and runtime limitations, and the [migration guide](../../UPGRADING.md#github-v3-configuration)
for existing profiles.

Independent review requests remain unavailable and warn without stopping supported
assignment intake. Invalid assessment selections block actionably and are never
silently replaced. Correct them and refresh context in the same issue chat; no
Install or replacement conversation is needed.

After reading a retained plan, ask the agent in that issue chat to implement it and
open a PR, together or separately. The authenticated operator request authorizes
only the requested work. The agent keeps the same worktree and returns a quoted
card linking the issue and PR. If publication is interrupted, continue in that chat
so it can reconcile the existing attempt without creating another PR.

Once intake is installed, feedback authors are the union of approved assignment actors
and configured reviewers. Use `feedback` only for skill/guidance customization; see
[feedback permissions](../../MANIFEST.md#feedback-permissions). Approved mentions
in issue comments, PR conversation comments, submitted reviews, and inline
replies return to the original issue chat. The agent retains its complete private
answer and composes a separate public reply with the configured feedback skill.
Inline replies return to their original review thread; other replies return to the
source issue or PR. Feedback follows the issue stage: Plan investigates and plans;
Work may implement appropriate changes; Auto may choose Plan or Work. Updates stay
on the existing PR, with the original assessment and implementation preserved.
Busy chats queue comments in the shared oldest-eligible capacity pool. Edited or
removed sources and changed authority stop pending replies; uncertain sends or
publications are reconciled without repeating them.

## Install and Verify

From the configured workspace:

```sh
# reconcile declared configuration and inspect readiness.
openclaw agent-system install
openclaw agent-system doctor

# inspect native intake and dispatch evidence without advancing work.
openclaw agent-system notifications status --json

# request one run of the already installed owning automation.
openclaw agent-system notifications refresh --json
```

Install also manages the **GitHub Notifications** readiness channel. It shows when
an agent needs setup or automation synchronization, and reports recent intake
health. Remove the supported workflow declaration from the manifest and run Install to deactivate that
agent's account; there is no separate channel setup. See [channel readiness and
compatibility](./ADVANCED.md#v1-retirement) for observation limits.

A queued refresh is an admission receipt. It does not prove a completed scan,
created conversation, or finished plan. Status reads durable intake and dispatch
records; `wait --for plan-ready` requires the retained assessment result.

## Further Reading

- [CLI reference and V1 retirement](./ADVANCED.md)
- [Standalone Codex workflows](../../CODEX.md#github-notification-policy)
- [Presentation contract](./PRESENTATION.md)
