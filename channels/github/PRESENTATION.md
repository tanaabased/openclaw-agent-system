# GitHub Notification Presentation

The GitHub notifications channel uses one presentation grammar for inbound
events, private agent responses, and outbound publication candidates. New
notification modes should adopt this grammar by default instead of inventing a
mode-specific response format. See the [channel README](./README.md) for setup,
configuration, and lifecycle behavior.

## Message Grammar

Every human-visible notification turn follows the same basic shape:

```markdown
## <emoji> <short descriptive title>

<one sentence describing what happened or what the agent did>

**<optional label>:** <one concise supporting note>
```

- Start with a level-two heading containing one meaningful emoji and a short,
  descriptive title.
- Follow the heading with one complete sentence that states the event, result,
  or requested action. Link the canonical GitHub target when it is safe and
  useful.
- Add at most one short supporting note before any detailed sections. Use a
  bold label such as `Mode`, `Status`, or `Next step` when the note benefits
  from one.
- Put additional private detail beneath descriptive Markdown headings. Use
  lists only when the content is naturally a list.
- Keep the message understandable as literal plain text. Emoji and Markdown
  improve scanning but must not carry meaning that the words omit.

The title and summary are the stable presentation contract. Exact wording,
emoji, optional sections, and labels may adapt to the event when they preserve
that contract.

## Context Boundary

The visible message is a presentation, not a provider-data envelope. Issue or
pull request bodies, comments, labels, changed-file summaries, verified head
identity, delivery metadata, local paths, and similar supporting evidence
belong in bounded current-turn structured context rather than normal chat.

| Surface                         | Contract                                                              |
| ------------------------------- | --------------------------------------------------------------------- |
| Visible inbound message         | Rich heading, one-sentence summary, and an optional concise note      |
| Current-turn structured context | Bounded untrusted provider data needed to understand the event        |
| Private agent response          | Complete operator-facing Markdown retained in the private session     |
| Public publication candidate    | Clearly quoted content that alone may enter an authorized public path |

Use OpenClaw's `UntrustedStructuredContext` boundary, or the equivalent
channel-owned current-turn context, for provider-controlled content. Preserve
canonical source links and stable identifiers so an authorized consumer can
re-fetch the source. Do not print raw payloads or transport metadata into the
visible message, copy them into the private response without a user-facing
reason, or promise that transient provider content will be retained
indefinitely.

## Inbound Messages

An inbound notification says what happened and, when needed, what mode or
constraint applies. The supporting context stays separate even when the model
needs it to answer.

```markdown
## 📥 Assignment received

You've been assigned [tanaabased/example#7 — Improve planning](https://github.com/tanaabased/example/issues/7).

**Mode:** Plan — review the assignment without using tools or beginning implementation.
```

Provider text must be escaped before it enters Markdown links or titles. A
notification may use a more specific title such as `Comment received`,
`Planning requested`, or `Review requested`, but it keeps the same grammar.
Detailed model instructions belong in the mode contract or structured context,
not as a long block of visible control prose.

## Private Responses and Public Candidates

An agent response uses the same rich heading and summary pattern, then adds
only the private sections needed for that turn. Headings such as `Assessment`,
`Blockers`, `Plan`, or `Response` are useful vocabulary, not a universal set
of required fields.

When any part of the private response is proposed for publication to GitHub,
show it under a descriptive outbound heading and render the complete candidate
as a Markdown blockquote:

```markdown
## 📤 Proposed GitHub reply

> I reviewed the request and will follow up after the local verification is complete.
```

The blockquote makes the private-to-public boundary visible to the operator.
The channel extracts the quoted content, validates it for the declared
publication intent, and sends the content without the local `>` presentation
marker only after the relevant authorization. Unquoted analysis, plans,
provider context, tool output, and ordinary local chat remain private.

Use `Proposed` when publication is still pending and `Published` only when the
channel has confirmed the public action. Parser sentinels and transport labels
may exist in hidden structured output when an implementation requires them,
but they must not replace the human-visible heading and blockquote grammar.

## Current Examples

These examples are illustrative, not exhaustive. Their subject matter and
sections may vary while the shared grammar and context boundary remain fixed.

### Planning request

```markdown
## 📋 Planning requested

Please prepare a private implementation plan for [tanaabased/example#7 — Improve planning](https://github.com/tanaabased/example/issues/7).

**Mode:** Plan — do not use tools or begin implementation.
```

### Private planning response

```markdown
## 🧭 Assignment assessed

The request is ready to implement after one repository boundary is confirmed.

## Assessment

The change belongs in the GitHub channel and should preserve the existing publication gate.

## Blockers

None.

## Plan

1. Trace the current inbound and outbound presentation helpers.
2. Apply the shared grammar at each session-facing boundary.
3. Verify private context and public candidate isolation.

## 📤 Proposed GitHub acknowledgment

> I reviewed the assignment and prepared an implementation plan.
```

### Comment received

```markdown
## 💬 Comment received

Michael mentioned you on [tanaabased/example#7 — Improve planning](https://github.com/tanaabased/example/issues/7).

**Mode:** Reply — answer from recorded evidence without using tools.
```

The exact comment, author identity, and bounded status evidence remain in the
current-turn structured context.

### Comment response

```markdown
## 💬 Comment answered

The requested status is supported by the recorded assignment evidence.

## Response

The private response may explain what evidence was available and what remains unverified.

## 📤 Proposed GitHub reply

> The implementation is complete locally, but no current check result is available from this notification turn.
```

## Future Examples

These examples show how a new surface can adopt the grammar without defining a
new presentation system. They do not claim that the corresponding lifecycle is
implemented.

### Pull request assignment

```markdown
## 🔀 Pull request assigned

You've been assigned [tanaabased/example#18 — Refine notification routing](https://github.com/tanaabased/example/pull/18).

**Mode:** Stewardship — assess discussion, blockers, and merge readiness without beginning implementation.
```

### Pull request review

```markdown
## 👀 Review requested

Your review was requested on [tanaabased/example#18 — Refine notification routing](https://github.com/tanaabased/example/pull/18).

**Mode:** Review — inspect the supplied revision context and return a private review before any public action.
```

### Private review response

```markdown
## 👀 Pull request reviewed

The supplied revision has one blocking correctness issue.

## Finding

The retry path can publish the same response twice after an ambiguous provider timeout.

## 📤 Proposed GitHub review

> Please make the retry idempotent so an ambiguous timeout cannot publish the response twice.
```

## Extension Rules

- Reuse the shared heading, summary, optional note, context, and blockquote
  helpers across modes.
- Add a mode-specific section only when it communicates a distinct private
  concept; do not add another delimiter or parallel response language.
- Keep publication intent, authorization, extraction, and validation separate
  from presentation.
- Preserve existing formats only as bounded compatibility inputs during an
  explicit transition. Mixed or ambiguous formats fail deterministically.
- Update this guide only when the shared grammar changes, not whenever a new
  event supplies different nouns or private details.

## Verification

- Assert the heading, one-sentence summary, optional-note, provider-link, and
  escaping contracts at every visible inbound and private-response boundary.
- Verify that provider-controlled detail is available through current-turn
  structured context without appearing in normal chat.
- Verify that outbound candidates are visibly quoted in the private response,
  extracted without their presentation markers, and isolated from all
  unquoted content.
- Assert semantic signal rather than complete human wording unless exact text
  is itself a stable public contract.
- Cover literal plaintext readability and use GitHub Actions-only OpenClaw
  examples when behavior crosses the installed plugin, session, channel, or
  Gateway boundary.
