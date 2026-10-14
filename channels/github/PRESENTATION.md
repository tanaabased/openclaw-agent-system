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
  reports. Legacy OpenClaw ordinary comments mirror their public answer privately;
  Codex feedback presents the complete private response and a separate public quote.
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

## Codex Issue Assignment Notices

Use one compact card for the outcome of an intake check:

- **ℹ️ Information:** issues started, pending assignments, or intake recovery.
- **⚠️ Warning:** an intake action is needed or a temporary provider delay.
- **❌ Error:** intake or preparation could not complete.

List each started item as **Issue:** followed by its repository and number linked
to its work destination. Do not add an “Open chat” label or duplicate GitHub link.
Reserve **Feedback** for incoming comments and review feedback, and **Review** for
requests to review a pull request when those intake capabilities are available.
Follow with **Managing**, **Pending**, and **Slots** facts. Quiet checks reuse the
existing time-based message rotation. Omit unknown counts rather than showing zero.
Warnings and errors explain the affected item or intake operation and its next action;
include the exact project folder when registration is needed and a bounded diagnostic
when useful. Preserve successful starts in a report that also contains an obstacle.

```markdown
## ℹ️ Intake complete — 2 issues started

- **Issue:** [example/project #7](codex://threads/example-7)
- **Issue:** [example/project #8](codex://threads/example-8)

**Managing:** 5 issues · **Pending:** 1
**Slots:** 2/2 occupied
Pending issues will start when a slot becomes available.
```

Keep assessment plans, questions, and assessment-specific warnings or errors in the
individual issue using the components below. Native approvals keep their native UI.

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

Codex and OpenClaw use the same quoted card for an admitted comment. The heading
links the verified author, the body preserves the author's Markdown and mentions,
and the footer links to the exact source comment rather than only its issue or
pull request. Prefix every line, including blank lines, with the outer quote marker;
keep lists, code blocks, and nested quotes inside the card. Preserve the raw source
separately from this presentation.

```markdown
> ## 💬 From [@pirog](https://github.com/pirog)
>
> @tanaabot can you confirm whether this also covers comments received while planning?
>
> [View comment on tanaabased/example#7 ↗](https://github.com/tanaabased/example/issues/7#issuecomment-123)
```

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

For standalone Codex delivery, retain the original issue chat link and state that
automatic GitHub feedback delivery is unavailable. Render only after verified
publication; native attachment warnings accompany the card without suppressing it.
Use the shared info, warning, and error components for delivery notices. The card
itself is not delivery proof.

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

When the result includes a complete `fullAssessment`, show it unchanged under
**Full assessment** for every outcome, after the plan summary, question, or setup
action. It replaces the separately rendered Full plan, while questions and required
actions remain prominent. Do not impose the default plan headings on an ordinary
skill's output or use a summary in place of the complete source.

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

When debug presentation is enabled, follow Model routing with a quoted
**🧩 Assessment instructions** card. Show the retained **Skill**, including the
default, linked to its resolved `SKILL.md`. Show file **Guidance** as a linked
workspace-relative label. For inline guidance, link “Inline guidance” to its
verified manifest source when available, then show the retained text in a literal
block preserving whitespace and Markdown characters. The source file may change;
the retained text records what the turn used. Keep these links and instructions
private. Selection metadata is not proof of compliance.

Reuse the same component as **🧩 Implementation instructions** immediately after the
PR card and as **🧩 Feedback reply instructions** after the public reply quote and
publication link or obstacle. With debug off, omit instruction cards entirely,
including custom selections and guidance. Errors, blockers, private responses,
and publication outcomes remain visible. Do not put reply instructions in the
incoming comment card or public GitHub reply.

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
For manual Codex project registration in issue intake, use **⚠️ Add the project to continue**,
including separate **Project name**, **Folder path**, and **Next step** facts. Distinguish
the suggested name from the exact required primary folder; retain issue and diagnostic context.

## To GitHub

```markdown
> ## 📤 To GitHub
>
> Thanks for flagging this, @pirog. The notification flow now preserves the link.
```

Use this component only when a lifecycle turn intentionally separates its
private report from a typed public candidate. Render the complete GitHub-facing
text as one Markdown blockquote. Multi-paragraph responses repeat the blockquote
marker for each paragraph. Address the verified source commenter where it reads
naturally rather than imposing a fixed mention position.

## Ordinary Comment Response

Legacy OpenClaw ordinary comments use one concise final answer, without a
`To GitHub` wrapper or a second model-authored answer. The
[security and lifecycle](./ADVANCED.md#security-and-lifecycle) reference describes its private/public mirroring.

## Private and Public Composition

Codex feedback and lifecycle turns with distinct private and public parts use
this composition. Preserve the complete retained private response; do not replace
it with the public candidate. After publication, link the verified reply. If
publication is withheld or uncertain, report that outcome without claiming a post:

For feedback, include the complete incoming comment or review card at the top of
the final response. Progress commentary alone is insufficient: clients may collapse
it when the turn finishes. Keep the source card outside the public reply quote.

```markdown
> ## 💬 From [@author](https://github.com/author)
>
> <complete incoming comment>
>
> [View comment on owner/repo#123 ↗](https://github.com/owner/repo/issues/123#issuecomment-456)

## Response

<complete private response>

> ## 📤 To GitHub
>
> <complete GitHub-facing response>
```
