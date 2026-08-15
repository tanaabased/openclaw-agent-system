# GitHub Notification Design

This document defines the target message and lifecycle design for the GitHub
notifications channel. It does not claim that every part is implemented. The
[channel README](./README.md) describes current behavior, and
[Presentation](./PRESENTATION.md) defines the visible components.

## Flow

```text
GitHub notification
        |
   admit + classify
        |
 lifecycle session ---- optional worktree
        |
 assignment card + GitHub acknowledgment
        |
 hidden mode instructions + bounded context
        |
     model turn <---------------------------+
        |                                   |
 private response + To GitHub               |
        |                                   |
 validate and publish GitHub response       |
        |                                   |
 GitHub comment -> same lifecycle session --+
        |
 clarification / plan ready / work / complete
```

Polling discovers candidate events. Admission verifies the agent, actor,
repository, permission, and lifecycle type before creating or resuming the
session and any required worktree. Comments return to that same session.

## Vocabulary

Machine IDs are lowercase kebab-case and remain distinct across lifecycle type,
mode, and state.

### Lifecycle Types

A lifecycle type identifies the GitHub activity that owns a session.

| Name                    | Machine ID            | Session and worktree                                                                |
| ----------------------- | --------------------- | ----------------------------------------------------------------------------------- |
| Issue assignment        | `issue`               | One issue-scoped session and managed issue worktree                                 |
| Pull-request assignment | `pull-request`        | One directly assigned pull-request session; worktree behavior is lifecycle-specific |
| Pull-request review     | `pull-request-review` | One future review-request lifecycle with its own authority and worktree rules       |

Pull-request assignment and pull-request review are separate lifecycle types.
Additional types may reuse the shared flow while supplying their own context,
instructions, worktree requirements, and completion rules.

### Lifecycle Ownership

A lifecycle implementation such as `issue.ts` owns only provider-specific
facts and resources:

- validate that the classified item belongs to the lifecycle and project
  bounded trusted inputs;
- declare lifecycle-specific resources, such as the issue worktree;
- supply lifecycle facts for shared presentation, structured context, hidden
  instructions, and completion evidence as those capabilities are added.

The shared coordinator owns admission, durable session identity and state,
serialization, retries, mode enforcement, OpenClaw turn dispatch, response
validation, and publication. Lifecycle implementations do not load credentials,
write OpenClaw session storage, choose arbitrary tool lists, or publish directly.
Add lifecycle behavior through small explicit capabilities rather than one
all-purpose reconciliation method.

### Modes

A mode determines what the agent may do inside the lifecycle session.

| Name | Machine ID | Capability                                                                                                                                                                                |
| ---- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan | `plan`     | Investigate, inspect code and documentation, research, run safe disposable experiments, ask questions, and produce an implementation-ready plan without persistent implementation changes |
| Work | `work`     | Plan and clarify, then implement, validate, commit, open or update the authorized pull request, and report completion                                                                     |
| Auto | `auto`     | Apply a future bounded policy for choosing and advancing work                                                                                                                             |

The target `agent.yaml` notification configuration selects the initial mode.
Mode transitions are trusted lifecycle actions; GitHub prose cannot select or
elevate a mode. A comment inherits the session's current mode.

### Capability Enforcement

Mode capability is a shared runtime policy, not a lifecycle implementation
detail. The effective capability is the intersection of the configured agent
policy, trusted mode policy, harness support, sandbox policy, and execution
authorization. A turn may narrow those boundaries but never widen them.

- **Plan** uses an explicit inspection-and-research allowlist. It excludes
  persistent filesystem mutation, unrestricted shell execution, and generic
  provider mutation. A disposable experiment capability may add shell access
  only inside an isolated workspace whose source is read-only, whose outputs
  are disposable, and whose provider mutations are unavailable.
- **Work** may use the configured agent's coding capability and Agent System
  tools after a trusted mode transition. It does not imply OpenClaw's
  unrestricted `full` profile.

OpenClaw's `coding` profile is a useful configured ceiling for Work, not a Plan
profile: it includes filesystem and runtime tools, and shell execution can
mutate files even when write-specific tools are absent. The built-in harness
can enforce a per-turn runtime tool allowlist. In the native Codex harness, a
restrictive allowlist disables native code mode and exposes only permitted
OpenClaw dynamic tools; Work can retain the native coding surface when the
remaining sandbox and execution-authorization boundaries allow it. Capability
enforcement must therefore be verified separately in both harnesses rather
than expressed only as prompt instructions.

### States

State describes lifecycle progress. Delivery receipts remain separate so a
successful private turn is not erased by a failed GitHub publication.

| Name                 | Machine ID             | Meaning                                                    |
| -------------------- | ---------------------- | ---------------------------------------------------------- |
| Received             | `received`             | Admission and session preparation completed                |
| Planning             | `planning`             | The agent is investigating or preparing its next action    |
| Clarification needed | `clarification-needed` | A published question is waiting for an admitted answer     |
| Plan ready           | `plan-ready`           | A private plan and public summary are ready                |
| Working              | `working`              | Authorized implementation is underway                      |
| Completed            | `completed`            | The lifecycle produced its intended result                 |
| Failed               | `failed`               | A durable failure prevents the current transition          |
| Retired              | `retired`              | Monitoring ended while preserving the session and worktree |

```text
received -> planning -> clarification-needed -> planning
                     -> plan-ready -> working -> completed

any nonterminal state -> failed | retired
```

In Plan, `plan-ready` waits for an authorized transition to Work. In Work, an
unblocked plan may advance directly to `working`. Auto will define its own
bounded transitions.

The polling monitor owns provider intake stages (`admitted`, `prepared`, and
`retired`). The shared coordinator may record the deterministic OpenClaw route
while preparing intake, but model-backed lifecycle state begins after prepared
intake and lives in a separate session-owned record. Do not add prompt, comment,
publication, or conversation progress back to monitor state.

## Turn Contract

Each model-backed turn keeps these layers separate:

| Layer              | Purpose                                                      | Visibility                                    |
| ------------------ | ------------------------------------------------------------ | --------------------------------------------- |
| Presentation       | Assignment card, direct message, and response components     | Visible in the session                        |
| Structured context | Bounded GitHub content, provenance, and recorded state       | Model-only current-turn context               |
| Instructions       | Trusted guidance selected by lifecycle type, mode, and event | Hidden from the conversation                  |
| Capability         | Tool and mutation boundary selected from trusted mode state  | Runtime-enforced                              |
| Private response   | Complete local response                                      | Private session only                          |
| GitHub response    | Concise candidate beneath `To GitHub`                        | Visible locally; publishable after validation |

This contract must work through both the built-in OpenClaw agent harness and
the native Codex app-server harness. Their prompt, context, hook, and tool
projections may differ, but they must preserve the same visible presentation,
hidden instruction, capability, response, and publication boundaries.

Every agent-authored response printed in the chat must use the
[complete response](./PRESENTATION.md#complete-response) composition: the full
private response followed by an isolated, sanitized `To GitHub` summary. A
visible response is incomplete without both parts, even when GitHub publication
later fails.

Approved identity permits an event to enter the conversation. It does not make
GitHub prose trusted instructions or grant capabilities beyond the active mode.

## Lifecycle Rules

- **Receipt:** An admitted assignment produces a visible assignment card and an
  immediate GitHub acknowledgment appropriate to its lifecycle type and mode.
  The acknowledgment may be deterministic and does not wait for the main turn.
- **Turn:** Bounded provider context, hidden instructions, and enforced
  capability start the mode-specific model turn.
- **Response:** Every agent-authored outcome uses the complete private and
  `To GitHub` response composition.
- **Plan:** The agent investigates the item, discussion, code, and documentation.
  It returns a plan or enters `clarification-needed` with a concise public
  question. An admitted answer resumes the same Plan session.
- **Work:** The agent plans and clarifies before making authorized changes, then
  validates the work, creates or updates the pull request, and reports the
  result privately and publicly.
- **Comments:** An admitted comment enters as a direct message in the existing
  session and inherits its lifecycle type, mode, state, and capability.
- **Publication:** Only the isolated `To GitHub` candidate or a trusted
  provider-constructed message may be published. Publication validates the
  payload, reauthorizes the destination, records a durable receipt, and retries
  the accepted text without model regeneration.

Private responses, structured context, hidden instructions, tool output,
credentials, and local paths remain outside GitHub publication.

## Current Behavior

See the [GitHub notifications channel README](./README.md) for currently
implemented configuration, commands, checkpoints, security boundaries, and
limitations.
