# GitHub Notification Presentation

This guide defines the reusable human-visible components for the GitHub
notifications channel. It describes their appearance and composition only. The
[advanced guide](./ADVANCED.md#processing-and-lifecycle) describes lifecycle behavior, and the
[channel README](./README.md) describes the current implementation.

## Style

- Use one meaningful emoji and a short descriptive title.
- Follow the title with compact facts or one plain-language sentence, whichever
  makes the component easier to scan.
- Link canonical GitHub actors and items where they are named.
- Keep headings and labels stable while allowing natural response prose to vary.
- Keep literal plaintext understandable without relying on emoji or Markdown.
- Give private lifecycle results a report-like structure with stable sections
  for the complete assessment, plan, question, or result.
- Keep GitHub-facing responses conversational; they are comments rather than
  reports. An ordinary comment response is mirrored unchanged in its private
  session.
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

## Session Appearance

Use the routed OpenClaw agent for the session's visible owner. Prefer red for
bugs, green for features, blue for documentation, and purple for maintenance;
use another supported native color when the issue fits better. Prefer a fitting
existing custom group, falling back to `GitHub Issues`. Keep appearance setup out
of the public GitHub response.

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

Use the agent's configured emoji and fall back to `🤖` when it has none.

A review feedback message groups its summary and selected findings under the
verified reviewer identity and review link. Each finding retains its own permalink,
body, file path, reviewed commit, and available current or original location. Mark
an unchanged summary as context. Later inline replies link to their exact source;
parent text and diff hunks belong in bounded structured context. Never label an
original location as current code.

## Pull Request Opened Card

```markdown
## 🔀 Pull request opened

- **Issue:** [tanaabased/example#7](https://github.com/tanaabased/example/issues/7)
- **Pull request:** [tanaabased/example#18](https://github.com/tanaabased/example/pull/18)
- **Comment flow:** This issue and its delivery pull request share this session; each reply returns to its originating item.
```

Use this card for the private `pull-request-opened` turn and the deterministic
GitHub handoff. See [processing and lifecycle](./ADVANCED.md#processing-and-lifecycle) for scheduling,
session ownership, and publication.

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

<one-sentence outcome summary>

## Assessment

<who is affected, what they are trying to do, what happens now, and why it falls short>

> ## 🧠 Model routing
>
> - **Selected:** <saved model> / <saved effort>
> - **Basis:** <complexity and concise selection rationale>
> - **Source:** <saved profile and evidence source>
> - **Effective settings:** <verified native settings or not independently verified>

## Plan summary

<proposed changes in the user's experience, important choices or limits, and how success will be checked>

## Full plan

<coherent approach and consequential sequencing>

### Code

- **Modify <file or related files>:** <intended change and necessary rationale>
```

Use the applicable subsections **Code**, **Documentation**, **Tests**, **Operations**,
and **Other** inside the full plan. Omit empty sections; a descriptive heading may replace
Other. Group tests by the repository's actual layers. Keep documentation and test
justifications beside their proposed changes, and preserve dependencies across sections.

Write Assessment and Plan summary for someone who knows the product but not its
implementation and is deciding what to approve, not reviewing an engineering design.
Assessment explains the user's task, current friction, and desired
outcome in concrete terms grounded in the investigation. Plan summary explains what
the proposed fix would let the user do, the important behavior and limits, and how
success will be checked. Translate the engineering plan; do not merely shorten it.

Keep schema keys, file paths, commit hashes, branch bookkeeping, and internal machinery
in the full plan or evidence unless a detail is necessary for a user decision. Explain
material dependencies and risks through their consequences for the user. Preserve
uncertainty and distinguish observed behavior, requirements, and proposed choices;
plain language must not turn assumptions into facts or hide blocking questions.
Apply the same audience to the opening outcome sentence and question context.

Describe actions, controls, and consequences the user can recognize. A sentence that
only names components, configuration structures, or lifecycle stages belongs in the
full plan. When a technical term is necessary, explain its meaning or effect in the
same sentence; do not make the reader translate internal vocabulary. Keep repository
readiness and implementation architecture out of the assessment unless they change
the user's understanding of the problem.

The opening describes a sequence the reader can picture: what they are trying to do,
where today's experience falls short, what they would do after the change, what they
would receive, and what they could do if something goes wrong. Name only actions and
outcomes supported by the investigation. A list of components or friendlier synonyms
for those components is not a user journey.

For example: “You could give your agent extra instructions or choose another assessment
skill. When you assign an issue, it would follow that choice and return its assessment
and plan in the usual chat. If it cannot find the chosen skill, it would tell you what
to fix.” This explains an experience; “add a supported selection pathway” does not.

Read Assessment and Plan summary without the full plan. The reader must be able to
explain their actions and expected results, along with any decision or limitation that
affects approval. Keep consequential uncertainty visible. Do not pad the opening with
branch bookkeeping, testing checklists, or architectural reassurance. Keep this review
out of the visible result; the assessment skill owns how the editing pass is performed.

Keep Assessment short. Plan summary has no word quota: use only what the user needs
to understand the proposed experience and make the relevant decision. Blocking questions
remain visible in the clarification outcome; never disguise them as settled decisions.

Retain the user-facing summary and full plan together and keep their facts consistent.
The full plan has no word-count or bullet-count target. Scale detail to the issue:
preserve implementation decisions, file changes, necessary rationale, consequential
sequencing, and non-obvious risks. Leave routine mechanics to implementation. State
shared constraints once; link evidence rather than repeating its findings throughout.
Render the complete full plan inline immediately after its summary, with no accordion,
separate-document link, or additional click. Never truncate it in the renderer.
Older retained results without a separate plan summary still show their complete full plan.

Pair each proposed change with its file or small group of related files in the same
bullet. Use **Add**, **Modify**, **Remove**, or **Move/merge**, followed by the paths and
the work to do; do not repeat the work in a separate file inventory. Show sources and
destinations for moves/merges, identify provisional paths, label generated and lockfile
changes, and give each file one primary section. Use short repository-relative labels
linked to inspected files where the host supports them; do not display absolute paths
as long bullet labels. Do not invent files or line-count estimates. These are expected
changes, not a frozen patch manifest; surface material deviations during implementation.
Keep cross-file sequencing and delivery checks in Operations. In Tests, group cases by
behavior and owning files; spell out individual cases only when needed to preserve an
important requirement or prevent a likely mistake. Work without file edits needs no
invented file list.

The private routing card follows the assessment. Its values come from saved routing and
native readback, with requested selection distinct from effective execution. Preserve
the model, effort, selection rationale, and provenance; use readable Markdown rather
than assuming native card styling. Place retained **Evidence** and **Investigation**
under one **Reference material** section after the full plan, questions, or setup action.
Introduce it as optional supporting detail; nest **Completed** and **Remaining** beneath
Investigation. Omit empty subsections and omit Reference material when both are empty.
Keep consequential uncertainty, blocking questions, and required actions in the primary
assessment, questions, or action; the reference section must not be their only home.
The framing follows the structured result; prose headings never select state.

When custom assessment instructions were selected, follow Model routing with a quoted
**🧩 Assessment instructions** card. Show the resolved custom **Skill** name and/or
**Guidance**: the workspace-relative file path for file guidance, or “Inline guidance”
followed by its text with line breaks preserved. Use the retained runtime selection,
not model-authored claims. Omit default skill metadata and omit the card entirely when
neither override is present. This identifies supplied instructions, not proof of compliance.

## Question

```markdown
## ❓ Clarification needed

<one-sentence explanation>

## Assessment

<useful investigation and the decision blocked by missing requirements>

<private model-routing card>

## Question

<complete private question and relevant choices>
```

Preserve each question and its context. Setup obstacles use **Issue assessment blocked**
with **Action** and **Diagnostic**, plus retained evidence and investigation; keep them
distinct from missing requirements. Show the routing card when saved routing is available.

## To GitHub

```markdown
## 📤 To GitHub

> Thanks for flagging this, @pirog. The notification flow now preserves the link.
```

Use this component only when a lifecycle turn intentionally separates its
private report from a typed public candidate. Render the complete GitHub-facing
text as one Markdown blockquote. Multi-paragraph responses repeat the blockquote
marker for each paragraph. Address the verified source commenter where it reads
naturally rather than imposing a fixed mention position.

## Ordinary Comment Response

Use one concise final answer for an ordinary admitted comment, without a
`To GitHub` wrapper or a second model-authored answer. The
[security and lifecycle](./ADVANCED.md#security-and-lifecycle) reference describes its private/public mirroring.

## Private and Public Composition

When a lifecycle turn presents distinct private and public response parts
together, use this composition:

```markdown
## 💬 Comment answered

The clarification is sufficient to continue planning.

## Response

<complete private response>

## 📤 To GitHub

> <complete GitHub-facing response>
```
