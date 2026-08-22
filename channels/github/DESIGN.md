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
 private response + typed GitHub candidate  |
        |                                   |
 validate and publish GitHub response       |
        |                                   |
 GitHub comment -> same lifecycle session --+
        |
 question / plan summary / work result / complete
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
  bounded provider facts;
- declare lifecycle-specific resources, such as the issue worktree;
- declare which registered modes the lifecycle supports;
- supply lifecycle facts for shared presentation, structured context, hidden
  instructions, and completion evidence through small capabilities.

The shared coordinator owns admission, durable session identity and state,
serialization, retries, mode enforcement, OpenClaw turn dispatch, response
validation, and publication. Lifecycle implementations do not load credentials,
write OpenClaw session storage, choose arbitrary tool lists, or publish directly.
Add lifecycle behavior through small explicit capabilities rather than one
all-purpose reconciliation method.

The lifecycle's structured-context projector selects normalized facts already
obtained through authorized, bounded provider reads. It does not perform lazy
credential resolution from the prompt hook. The shared coordinator calls the
projector again for each turn so current lifecycle metadata is available without
copying provider prose into durable conversation state. Durable records retain
only identifiers, digests, current mode, transition facts, and delivery receipts.
A pull-request lifecycle can therefore project base and head refs, head SHA,
draft state, and repository identity while a review lifecycle can project its
review identifiers and target commit without changing the coordinator.

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

A distinct mode is justified only when it changes runtime capability,
authorization, or transition policy. Planning, clarification, and implementation
style may all happen inside Work without changing modes. If Plan and Work ever
differ only by prompt wording, they should be one mode with behavioral guidance.
Every implemented lifecycle-mode pair must be declared explicitly and resolve
through the shared registry; missing lifecycle, mode, event, or compatibility
definitions fail closed.

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

### Durable Conversation State

Do not persist a broad phase machine merely to describe what a capable model is
doing. Planning, asking a question, and working are ordinary turn outcomes until
the runtime needs a durable fact for authorization, scheduling, retry, UI, or
operator control. A clarification question is published, the turn ends, and an
admitted answer resumes the same session without a `clarification-needed`
transition.

The conversation record retains the current trusted mode, processed comment
revision identifiers and digests, and publication receipts. If promotion from
Plan to Work requires an authorized decision, add one bounded pending
mode-transition record with its source, target, requester, and decision rather
than introducing general planning and working phases. Human-facing labels such
as planning, waiting for clarification, working, completed, failed, and retired
may be derived for presentation until runtime behavior depends on them.

While an admitted model turn is running or remains retryable, the conversation
also retains one bounded active-turn descriptor containing its registered event
ID and stable source ID. The coordinator clears that descriptor when it
checkpoints a response, so prompt selection never depends on process-local
memory or arbitrary prompt text in persisted state.

The polling monitor owns provider intake stages (`admitted`, `prepared`, and
`retired`). The shared coordinator may record the deterministic OpenClaw route
while preparing intake, but model-backed lifecycle state begins after prepared
intake and lives in a separate session-owned record. Do not add prompt, comment,
publication, or conversation progress back to monitor state.

## Turn Contract

Each model-backed turn keeps these layers separate:

| Layer              | Purpose                                                      | Visibility                                      |
| ------------------ | ------------------------------------------------------------ | ----------------------------------------------- |
| Presentation       | Assignment card, direct message, and response components     | Visible in the session                          |
| Structured context | Bounded GitHub content, provenance, and recorded state       | Model-only current-turn context                 |
| Instructions       | Trusted guidance selected by lifecycle type, mode, and event | Hidden from the conversation                    |
| Capability         | Tool and mutation boundary selected from trusted mode state  | Runtime-enforced                                |
| Private response   | Complete local response                                      | Private session only                            |
| GitHub response    | Concise typed candidate, separate from response Markdown     | Channel-owned; optionally rendered or published |

This contract must work through both the built-in OpenClaw agent harness and
the native Codex app-server harness. Their prompt, context, hook, and tool
projections may differ, but they must preserve the same visible presentation,
hidden instruction, capability, response, and publication boundaries.

The model writes the private response as ordinary Markdown. It supplies the
GitHub-facing candidate through a typed channel-owned interface rather than
recreating a Markdown envelope for the host to parse. A host may render the two
parts with the [private and public composition](./PRESENTATION.md#private-and-public-composition),
but publication never depends on that rendering.

Approved identity permits an event to enter the conversation. It does not make
GitHub prose trusted instructions or grant capabilities beyond the active mode.
Structured context is untrusted data even when the channel hides it from the
visible transcript. Hidden instructions are composed only from registered
lifecycle, lifecycle-mode, mode, event, and shared-response definitions selected
by channel-owned turn identity.

### Prompt Transport

The central `before_prompt_build` hook is the supported cross-harness transport
for hidden channel instructions. Turn dispatch options project capability only;
they do not carry lifecycle, mode, or event prompts through
`extraSystemPrompt`. Typed GitHub reply candidates use their separate
channel-owned file-backed handoff and are not inferred from response Markdown.

The selector resolves the active lifecycle, mode, and event through the shared
catalog using trusted hook routing and the private durable turn descriptor
available to both the Gateway and native Codex runtimes. It does not derive
capability from GitHub prose, depend on process-local memory, or store prompt
text as arbitrary channel metadata. Missing, conflicting, or unsupported turn
selection fails closed instead of falling back to a different prompt.

## Lifecycle Rules

- **Receipt:** An admitted assignment produces a visible assignment card and an
  immediate GitHub acknowledgment appropriate to its lifecycle type and mode.
  The acknowledgment may be deterministic and does not wait for the main turn.
- **Turn:** Bounded provider context, hidden instructions, and enforced
  capability start the mode-specific model turn.
- **Response:** Every agent-authored outcome keeps its complete private response
  separate from one typed GitHub-facing candidate.
- **Plan:** The agent investigates the item, discussion, code, and documentation.
  It returns a plan or asks one concise public question and ends the turn. An
  admitted answer resumes the same Plan session.
- **Work:** The agent plans and clarifies before making authorized changes, then
  validates the work, creates or updates the pull request, and reports the
  result privately and publicly.
- **Comments:** An admitted comment enters as a direct message in the existing
  session and inherits its lifecycle type, current mode, and capability.
- **Publication:** Only the typed GitHub candidate or a trusted
  provider-constructed message may be published. Publication validates the
  payload, reauthorizes the destination, records a durable receipt, and retries
  the accepted text without model regeneration.

Private responses, structured context, hidden instructions, tool output,
credentials, and local paths remain outside GitHub publication.

## Implementation Map

The channel source is organized by the behavior being changed:

| Scope                        | Ownership                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `events/`                    | Trusted event definitions and explicit registration; lifecycle support and runtime orchestration remain separate           |
| `lifecycles/`                | Lifecycle descriptors, supported-mode declarations, structured-context projection, and lifecycle-specific resources        |
| `modes/`                     | Trusted mode instructions, policies, and runtime tool projection; register implemented definitions during runtime assembly |
| `intake/`                    | Assignment admission, classification, preparation, and polling checkpoints                                                 |
| `conversation/context/`      | Event-specific composition over lifecycle-owned bounded structured context                                                 |
| `conversation/prompts/`      | Hidden lifecycle, event, mode, and response instruction text and pure composition                                          |
| `conversation/presentation/` | Reusable visible components governed by [Presentation](./PRESENTATION.md)                                                  |
| `conversation/`              | Session preparation, comment admission, turn dispatch, and conversation state                                              |
| `publication/`               | Typed public candidates, validation, leases, delivery, and reconciliation                                                  |
| `provider/`                  | Bounded GitHub reads and provider data normalization                                                                       |
| `routing/`                   | Installed OpenClaw channel routes and durable route receipts                                                               |
| `runtime/`                   | Channel-owned assembly and its Agent System lifecycle contribution                                                         |
| `cli/`                       | GitHub notification subcommand implementations and options                                                                 |

Keep small scopes flat. Add a nested `lib/` or `utils/` only when a scope has
enough files to make that distinction useful, and do not add placeholder mode or
lifecycle files before an implementation exists.

## Current Behavior

See the [GitHub notifications channel README](./README.md) for currently
implemented configuration, commands, checkpoints, security boundaries, and
limitations.
