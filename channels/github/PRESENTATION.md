# GitHub Notification Presentation

This guide defines the reusable human-visible components for the GitHub
notifications channel. It describes their appearance and composition only. The
[design guide](./DESIGN.md) defines message and lifecycle behavior, and the
[channel README](./README.md) describes the current implementation.

## Style

- Use one meaningful emoji and a short descriptive title.
- Follow the title with compact facts or one plain-language sentence, whichever
  makes the component easier to scan.
- Link canonical GitHub actors and items where they are named.
- Keep headings and labels stable while allowing natural response prose to vary.
- Keep literal plaintext understandable without relying on emoji or Markdown.
- Give private responses a report-like structure with stable sections for the
  complete assessment, plan, question, or result.
- Keep GitHub-facing responses conversational; they are comments rather than
  reports. Keep them shorter than their private counterparts.
- Use GitHub-flavored Markdown, including headings, lists, tables, blockquotes,
  code formatting, and links, only when it materially improves clarity.

## Card

```markdown
## <emoji> <short descriptive title>

- **<fact>:** <value>
- **<fact>:** <value>
```

Use a short bulleted fact list when a card primarily presents metadata. A
summary sentence may replace the list when the component primarily presents an
outcome or call to action.

## Assignment Card

```markdown
## 📥 Issue assigned

[@pirog](https://github.com/pirog) assigned you to [tanaabased/example#7 — Improve planning](https://github.com/tanaabased/example/issues/7). Please begin working on it in `work` mode.
```

```markdown
## 🔀 Pull request assigned

[@pirog](https://github.com/pirog) assigned you to [tanaabased/example#18 — Refine notification routing](https://github.com/tanaabased/example/pull/18). Please begin working on it in `plan` mode.
```

## Direct Message

A direct inbound comment replaces each admitted GitHub account mention with the
agent's installed emoji, display name, and OpenClaw Agents link. The remaining
author-written Markdown source stays exact, so standard links, headings, lists,
tables, blockquotes, and code formatting remain available to OpenClaw's Markdown
renderer. GitHub-specific shorthand such as bare mentions and issue numbers may
remain literal text. A quoted italic footer links the author and the source
comment:

```markdown
📬 [Notification Data](/agents) can you confirm whether this also covers comments received while planning?

> _[@pirog](https://github.com/pirog) mentioned Notification Data on [tanaabased/example#7](https://github.com/tanaabased/example/issues/7#issuecomment-123)._
```

Use the agent's configured emoji and fall back to `🤖` when it has none. Keep
the original GitHub comment as the raw inbound body even though the visible and
model-facing message uses this presentation.

## Pull Request Opened Card

```markdown
## 🔀 Pull request opened

- **Issue:** tanaabased/example#7
- **Pull request:** tanaabased/example#18
- **Comment flow:** This issue and its delivery pull request share this session; each reply returns to its originating item.
```

This observe-only card appears in the issue-owned private session after managed
delivery records its pull request. It does not start a model turn. The deterministic
GitHub handoff uses the same compact fact-list grammar on the issue, while later
comment responses use the ordinary direct-message and `To GitHub` components.

## Implementation Card

```markdown
## 🛠️ Implementation started

The public plan is published. Carry it out now in `work` mode.
```

Keep the following private result report-like with stable implementation and
validation sections. Do not add a second GitHub-facing response merely because
implementation began.

## Response

```markdown
## <emoji> <outcome title>

<one-sentence outcome summary>

## Response

<complete private response>
```

The private response is the report of record. Use headings and compact lists or
tables when they make the complete result easier to review.

## Plan

```markdown
## 🧭 Plan ready

<one-sentence plan summary>

## Assessment

<assessment>

## Plan

<implementation plan>
```

## Question

```markdown
## ❓ Clarification needed

<one-sentence explanation>

## Question

<complete private question and relevant choices>
```

## To GitHub

```markdown
## 📤 To GitHub

> Thanks for flagging this, @pirog. The notification flow now preserves the link.
```

Render the complete GitHub-facing text as one Markdown blockquote. Multi-paragraph
responses repeat the blockquote marker for each paragraph. Address the verified
source commenter where it reads naturally rather than imposing a fixed mention
position. Keep this candidate concise and conversational even when the private
response uses a fuller report structure.

## Private and Public Composition

When a surface presents both response parts together, use this composition:

```markdown
## 💬 Comment answered

The clarification is sufficient to continue planning.

## Response

<complete private response>

## 📤 To GitHub

> <complete GitHub-facing response>
```
