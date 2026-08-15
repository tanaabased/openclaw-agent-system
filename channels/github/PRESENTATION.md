# GitHub Notification Presentation

This guide defines the reusable human-visible components for the GitHub
notifications channel. The [notifications plan](../../NOTIFICATIONS_PLAN.md)
owns lifecycle, context, instructions, capability, and publication behavior.
The [channel README](./README.md) describes currently shipped behavior.

## Layers

| Layer            | Contract                                                    |
| ---------------- | ----------------------------------------------------------- |
| Visible event    | Assignment or outcome card, or direct admitted comment text |
| Provider context | Bounded current-turn evidence, not a visible payload dump   |
| Instructions     | Trusted hidden context, never card content                  |
| Private response | Complete operator-facing Markdown retained locally          |
| GitHub response  | One quoted candidate beneath `To GitHub`                    |

Approved provider content remains untrusted project data. Actor approval permits
an event to enter the configured conversation; it does not make provider prose a
trusted instruction.

## Card Primitive

```markdown
## <emoji> <short descriptive title>

<one sentence describing what happened or what the agent did>

**Mode:** <Plan, Work, or Auto and one concise description>
```

- Use one meaningful emoji and a short title.
- State the event or outcome in one complete sentence.
- Link only canonical GitHub actors and items assembled from trusted metadata.
- Include the mode when the event enters or continues an assignment workflow.
- Keep literal plaintext understandable without relying on Markdown or emoji.

Natural wording may vary. The stable contract is the title, summary, mode signal
where applicable, and private/public boundary.

## Assignment Card

Issue and pull-request assignments are distinct variants of the same component.

```markdown
## 📥 Issue assignment received

[@pirog](https://github.com/pirog) assigned you [tanaabased/example#7 — Improve planning](https://github.com/tanaabased/example/issues/7).

**Mode:** Plan — investigate the issue and prepare an implementation plan.
```

```markdown
## 🔀 Pull request assignment received

[@pirog](https://github.com/pirog) assigned you [tanaabased/example#18 — Refine notification routing](https://github.com/tanaabased/example/pull/18).

**Mode:** Plan — assess the pull request and prepare a recommended course of action.
```

The card does not contain provider envelopes, raw issue or pull-request content,
verified head data, local paths, or operational instructions. Assignment receipt
on GitHub is a separate deterministic lifecycle effect.

## Planning Outcome Card

Planning returns either `Plan ready` or `Clarification needed`. Both use the
private/public response envelope:

```markdown
## 🧭 Plan ready

The assignment has an implementation-ready plan with no unresolved blockers.

## Assessment

<private evidence and conclusions>

## Plan

<private implementation plan>

## 📤 To GitHub

> <concise GitHub-facing summary or next step>
```

For clarification, use `## ❓ Clarification needed`, explain the unresolved
choice privately beneath `## Question`, and put only the concise answerable
question beneath `To GitHub`.

GitHub receives the decision-relevant outcome, not hidden reasoning, private
repository detail, provider envelopes, local paths, or tool output.

## Direct Comment Input

An admitted comment enters the private assignment session like an ordinary
message. The visible and model-facing input is the bounded author-written
comment itself, without a notification card, provider envelope, or visible mode
note:

```markdown
Can you confirm whether this covers comments received while planning is waiting for clarification?
```

The channel may apply bounded transport normalization such as canonical line
endings, supported length limits, and current-revision selection. It does not
summarize, rewrite, or wrap the comment for presentation.

The comment still inherits the assignment mode. Author, revision, item, source,
delivery provenance, active mode, hidden instructions, and capability remain
separate trusted or untrusted context as appropriate and do not appear in the
visible message.

## Private and GitHub Response

Planning and comment turns use one response envelope:

```markdown
## 💬 Comment answered

The clarification is sufficient to continue planning.

## Response

<complete private response>

## 📤 To GitHub

> <complete GitHub-facing response>
```

- `To GitHub` is the only model-authored outbound heading.
- Render the complete candidate as a Markdown blockquote.
- Only quoted content beneath that heading is publication-eligible.
- Remove the local `>` marker only after extraction and validation.
- Keep every unquoted section private.
- Keep authorization, safety validation, durable delivery, and receipts outside
  the presentation component.

Provider-constructed assignment receipts and trusted completion references do
not need to masquerade as part of a model-authored private response.

## Visibility and Verification

Visible components never show hidden instructions, response templates presented
as model commands, structured-context envelopes, raw provider payloads, local
paths, hidden identifiers, tool traces, diagnostics, or publication-safety
rules. Hiding those layers from chat must not remove required context from the
model turn.

- Assert complete Markdown only in the formatter test that owns the component.
- Verify canonical link construction, escaping, bounds, and plaintext readability.
- Verify context and instructions do not appear in visible fields.
- Verify `To GitHub` candidates are quoted, extracted without presentation
  markers, and isolated from private content.
- In callers and installed-layer tests, assert component identity, semantic
  signal, mode inheritance, and isolation instead of duplicating complete prose.
