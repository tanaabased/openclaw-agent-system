# GitHub Notification Presentation

This guide defines the reusable human-visible components for the GitHub
notifications channel. It describes their appearance and composition only. The
[design guide](./DESIGN.md) defines message and lifecycle behavior, and the
[channel README](./README.md) describes the current implementation.

## Style

- Use one meaningful emoji and a short descriptive title.
- Follow the title with one plain-language sentence whenever a summary helps.
- Link canonical GitHub actors and items in the sentence that names them.
- Use `**Mode:** <name>` for a compact mode label.
- Keep headings and labels stable while allowing natural response prose to vary.
- Keep literal plaintext understandable without relying on emoji or Markdown.

## Card

```markdown
## <emoji> <short descriptive title>

<one sentence describing the item or result>

**Mode:** <Plan, Work, or Auto>
```

The mode line is optional. Supporting detail may follow the summary when the
component needs it.

## Assignment Card

```markdown
## 📥 Issue assignment received

[@pirog](https://github.com/pirog) assigned you [tanaabased/example#7 — Improve planning](https://github.com/tanaabased/example/issues/7).

**Mode:** Plan
```

```markdown
## 🔀 Pull request assignment received

[@pirog](https://github.com/pirog) assigned you [tanaabased/example#18 — Refine notification routing](https://github.com/tanaabased/example/pull/18).

**Mode:** Plan
```

## Direct Message

A direct inbound message is presented as its normalized author-written text:

```markdown
Can you confirm whether this also covers comments received while planning?
```

## Response

```markdown
## <emoji> <outcome title>

<one-sentence outcome summary>

## Response

<complete private response>
```

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

> <complete GitHub-facing response>
```

Render the complete GitHub-facing text as one Markdown blockquote. Multi-paragraph
responses repeat the blockquote marker for each paragraph.

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
