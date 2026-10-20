# GitHub Notification Presentation

This guide defines the reusable human-visible components for the GitHub
notification workflows. It describes their appearance and composition only. The
[advanced guide](./ADVANCED.md) describes lifecycle behavior, and the
[notification README](./README.md) describes the current implementation.

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
  reports. Codex feedback presents the complete private response and a separate
  public quote.
- Use GitHub-flavored Markdown, including headings, lists, tables, blockquotes,
  code formatting, and links, only when it materially improves clarity.

## Card

```markdown
> ## <emoji> <short descriptive title>
>
> - **<fact>:** <value>
> - **<fact>:** <value>
```

Put the emoji, title, body, links, and notices inside one outer Markdown quote
block. Quote every line, including blanks and code fences; preserve author
quotations as nested quotes. Apply the wrapper once at the owning renderer.
Full assessments, plans, questions, and private responses remain ordinary document
sections outside their distinct cards.

This contract covers issue and PR assignments, intake status, model routing,
implementation and PR delivery, comment and review intake, public-reply previews,
instruction/debug cards, and information, warning, error, and outcome callouts.

Use a short bulleted fact list when a card primarily presents metadata. A
summary sentence may replace the list when the component primarily presents an
outcome or call to action.

## Issue Assignment Intake Notices

Use one compact card for the outcome of an intake check:

- **💡 Information:** issues started, pending assignments, or intake recovery.
- **✨ Update:** an available automation update, including a required update that pauses intake.
- **⚠️ Warning:** an intake action is needed or a temporary provider delay.
- **❌ Error:** intake or preparation could not complete.

Informational notices may supply a custom header emoji. Required automation updates
use ✨ with warning severity and explicitly say that new intake is paused. Other
warnings and errors keep their standard icons.

Reserve `intake-activation-required` for initial setup. An existing intake automation
that needs reconciliation uses `intake-automation-update-required`:

```markdown
> ## ✨ Automation update available
>
> - **What happened:** Your intake automation needs an update. New intake is paused until it’s applied. Existing chats and work are retained.
> - **Next step:** Run Agent System Install to apply the update and resume intake.
> - **Technical detail:** `intake-automation-update-required`
```

List each started item as **Issue:** followed by its repository and number linked
to its work destination. Do not add an “Open chat” label or duplicate GitHub link.
Reserve **Feedback** for incoming comments and review feedback, and **Review** for
requests to review a pull request when those intake capabilities are available.
Follow with **Managing**, **Pending**, and **Slots** facts. Codex quiet checks reuse the existing time-based message rotation. Native OpenClaw
healthy, unchanged checks produce no model turn and no card. Show a new or materially
changed blocker once, suppress identical repeats, and show verified recovery once.
Use native conversation destinations for OpenClaw issue links. Omit unknown counts rather than showing zero.
Warnings and errors explain the affected item or intake operation and its next action;
include the exact project folder when registration is needed and a bounded diagnostic
when useful. Provider failures name Git or GitHub, include its safe bounded detail
and supplied HTTP status, and distinguish access failures from temporary delays.
Preserve successful starts in a report that also contains an obstacle.

```markdown
> ## 💡 Intake complete — 2 issues started
>
> - **Issue:** [example/project #7](codex://threads/example-7)
> - **Issue:** [example/project #8](codex://threads/example-8)
>
> **Managing:** 5 issues · **Pending:** 1
> **Slots:** 2/2 occupied
> Pending issues will start when a slot becomes available.
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
> ## 📥 Issue assigned
>
> [@pirog](https://github.com/pirog) assigned you to [tanaabased/example#7 — Improve planning](https://github.com/tanaabased/example/issues/7). Assess this issue and prepare a plan. Stop before implementation or GitHub publication.
```

```markdown
> ## 🔀 Pull request assigned
>
> [@pirog](https://github.com/pirog) assigned you to [tanaabased/example#18 — Refine notification routing](https://github.com/tanaabased/example/pull/18). Please begin working on it in `plan` mode.
```

For issue assessment, show the shared assignment card with its verified
assigning actor, issue link, and assessment-stage action. Do not add model-routing or
assessment-instruction cards to the opening, including with debug enabled. Keep trusted
assessment instructions and retained routing, skill, and guidance available to the
agent. Show routing beside the resulting assessment, followed by selected assessment
instructions only when debug is enabled. Keep selected model/effort, native settings
readback, and execution evidence separately labeled. A successful renderer test does
not prove native delivery. Full assessments and plans remain outside the cards;
model-only provider facts never belong in them.

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

A review feedback message uses the same quoted **💬 From @author** card, with
its title, summary, selected findings, location metadata, and source links all
inside the quote. It groups findings under the verified reviewer identity and review link. Each finding retains its own permalink,
body, file path, reviewed commit, and available current or original location. Mark
an unchanged summary as context. Later inline replies link to their exact source;
parent text and full retained diff hunks belong in bounded structured context.
Show each finding's available GitHub diff hunk in a fenced `diff` block inside
the card, capped at its last 20 lines with long lines shortened. Label shortened
previews as excerpts, preserve literal code fences, and keep the source permalink
for full context. This is reviewed code, not the whole pull request or a fresh
working-tree diff. Never label an original location as current code.

## Pull Request Opened Card

```markdown
> ## 🔀 Pull request opened
>
> - **Issue:** [tanaabased/example#7](https://github.com/tanaabased/example/issues/7)
> - **Pull request:** [tanaabased/example#18](https://github.com/tanaabased/example/pull/18)
> - **Comment flow:** This issue and its delivery pull request share this session; each reply returns to its originating item.
```

For standalone Codex delivery, retain the original issue chat link. Configured
issue feedback also covers its verified delivery pull request. Render only after verified
publication; native attachment warnings accompany the card without suppressing it.
Use the shared info, warning, and error components for delivery notices. The card
itself is not delivery proof.

Use the quoted card for a private delivery notice. The deterministic GitHub
handoff retains the same content without the private outer quote. See
[native workflows](../../CODEX.md#github-notification-policy) for scheduling,
conversation ownership, and publication.

## Implementation Card

```markdown
> ## 🛠️ Implementation started
>
> The public plan is published. Carry it out now in `work` mode.
```

Keep the following private result report-like with stable implementation and
validation sections. Do not add a second GitHub-facing response merely because
implementation began.

## Response

```markdown
> ## <emoji> <outcome title>
>
> <one-sentence outcome summary>

## Response

<complete private response>
```

The private response is the report of record. Use headings and compact lists or
tables when they make the complete result easier to review.

## Plan

```markdown
> ## 🧭 Plan ready
>
> <one recommendation: what should change and why>

> ## 🧠 Model routing
>
> - **Selected:** <saved model> / <saved effort>
> - **Basis:** <complexity and concise selection rationale>
> - **Source:** <saved profile and evidence source>
> - **Effective settings:** <verified native settings or not independently verified>

## Full assessment

<short, complete plan with meaningful steps, necessary validation, and actual decisions or blockers>
```

Generate one recommendation and a concise, complete plan. For an ordinary issue,
roughly 200–400 words and typically three to six meaningful steps are useful editorial
targets, not limits, truncation rules, or minimum quotas. Small fixes need less;
consequential decisions and complex handoffs may need more. Name important owners,
dependencies, uncertainty, and non-obvious constraints once. Leave routine mechanics,
exhaustive file inventories, and speculative helper names to implementation.
Use Code, Documentation, Tests, Operations, or descriptive subsections only when useful;
omit empty sections and repeated scope/safety boilerplate. Link inspected owners with
short repository-relative labels where useful; identify provisional paths honestly.

Write the recommendation for someone who knows the product and needs to decide what
work should happen. Explain concrete actions and consequences, not a list of internal
components. Preserve decision-changing limits, risks, uncertainty, and blocking questions
in the primary response. Do not require another request to obtain the actionable plan.

The complete `fullAssessment` remains unchanged and inline for every outcome. For new
default ready plans it contains the same complete plan as `plan`; supporting sources
and investigation stay in their structured fields. `assessment` may repeat the concise
recommendation to satisfy the version 1 contract; `planSummary` is optional when redundant.
Omit a separately rendered assessment or plan summary only when its exact text is already
in the recommendation or complete source. Show a distinct plan even when a complete source
exists. Do not infer expendable text from headings, size, or skill identity. Preserve
substantive older and custom output without rewriting, truncation, or an additional click.
Questions and required actions remain prominent even when repeated in the complete source.

When an assessment includes a continuation decision, show an **Auto mode decision**
card after the instruction card (or routing card when debug is off). Keep it visible
regardless of debug presentation. Use ▶️ for `work` and ⏸️ for `plan`, with the exact
code-formatted value in **Decision**. Use **Next** to distinguish automatic continuation
once runtime checks pass from waiting for the operator's direction before implementation.
Follow with bounded **Reason** rows. Escape reason text and withhold credential-shaped
content; do not present the decision as permission or replace the complete assessment.

The private routing card follows the recommendation (or a distinct assessment). Its values come from saved routing and
native readback, with requested selection distinct from effective execution. Preserve
the model, effort, selection rationale, and provenance; use readable Markdown rather
than assuming native card styling. By default, do not append structured evidence or investigation. When explicitly requested,
place retained **Evidence** and **Investigation** under one **Reference material** section
after the complete source, questions, or setup action. Introduce it as supporting detail; nest **Completed** and **Remaining** beneath
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
> ## ❓ Clarification needed
>
> <one-sentence explanation>

## Assessment

<useful investigation and the decision blocked by missing requirements>

<private model-routing card>

## Question

<complete private question and relevant choices>
```

Preserve each question and its context. Setup obstacles use **Issue assessment blocked**
with **Action** and **Diagnostic** inside the same quoted callout, plus retained evidence and investigation; keep them
distinct from missing requirements. Show the routing card when saved routing is available.
For manual Codex project registration in issue intake, use **⚠️ Add the project to continue**,
including separate **Project name**, **Folder path**, and **Next step** facts. Distinguish
the suggested name from the exact required primary folder; retain issue and diagnostic context.

## Public Reply

```markdown
> ## 📤 To [@pirog](https://github.com/pirog)
>
> Thanks for flagging this, @pirog. The notification flow now preserves the link.
```

Use this component only when a lifecycle turn intentionally separates its
private report from a typed public candidate. Render the complete GitHub-facing
text as one Markdown blockquote headed **📤 To @recipient**, with the verified
source commenter linked to their GitHub profile. Quote every line, including
blank lines, lists, and code fences. Use the same card for the publication preview
and final response. Address the verified source commenter where it reads
naturally rather than imposing a fixed mention position.

For a PR delivery event with no source commenter, use **📤 To GitHub issue**
as the heading, linked to the originating issue. Quote the exact public announcement,
then show its verified comment link or a separate warning that the announcement remains pending. Keep the complete
private PR card above these components.

## Private and Public Composition

Codex feedback and lifecycle turns with distinct private and public parts use
this composition. Preserve the complete retained private response; do not replace
it with the public candidate. After publication, link the verified reply. If
publication is withheld or uncertain, report that outcome without claiming a post.
Put the publication link or obstacle in a quoted information or warning callout:

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

> ## 📤 To [@pirog](https://github.com/pirog)
>
> <complete GitHub-facing response>

> ## 💡 Reply published
>
> [Published reply ↗](https://github.com/example/project/issues/7#issuecomment-123)
```
