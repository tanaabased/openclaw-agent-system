# GitHub Notification Presentation

This guide defines the reusable human-visible components for the GitHub
notification workflows. It describes their appearance and composition only. The
[advanced guide](./ADVANCED.md) describes lifecycle behavior, and the
[notification README](./README.md) describes the current implementation.

## Style

- Use one meaningful emoji and a short descriptive title, except for the body-first
  comment cards below.
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

### Literal Machine Values

Use inline code for literal model IDs, efforts, profile/tier names, modes,
diagnostic codes, configuration keys, commands/flags, paths, and exposed technical
IDs. Format the value, not its explanatory label: `medium` profile, `work` mode,
and `issue-assignment.mode`. Lowercase words alone are not machine values; keep
ordinary statuses, provenance descriptions, reasons, and product names as prose.
Counts and line numbers do not need code merely because they are numeric.

Apply this at the shared presentation owner using structured values, never by
rewriting whole cards or searching arbitrary prose. Reuse the shared Markdown
code-span helper: choose delimiters longer than embedded backtick runs and pad
boundary backticks. Do not backslash-escape literal contents as Markdown text.
Retain clickable links, including code-formatted technical labels such as
[`agent-system-issue-assessment`](../../skills/issue-assessment/SKILL.md); leave
actors and issue/PR links readable in their existing form. Preserve raw incoming
and outgoing comment bodies and literal guidance/diff blocks without rewriting.

Representative facts (the Auto decision value is already aligned):

```markdown
> ## 🧠 Model routing
>
> - **Selected:** `openai/gpt-6.1-sol` / `high`
> - **Basis:** `medium` complexity. The change affects shared cards.
> - **Source:** `medium` profile; native
> - **Effective settings:** Verified: `openai/gpt-6.1-sol` / `high`
> - **Execution:** Model and effort not independently verified.

> ## ▶️ Auto mode decision
>
> - **Decision:** `work`
> - **Next:** Continue automatically once runtime checks pass.
> - **Reason:** Requirements are clear and the repair is bounded.

> ## ⚠️ Add the project to continue
>
> - **Folder path:** `/work/example`
> - **Diagnostic:** `dispatch-project-registration-unavailable`
```

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

Codex and OpenClaw share one body-first comment-card renderer. Do not add an
emoji heading or top padding. Preserve the complete body's Markdown and mentions,
quote every line once (including blanks and fences), then put a visible gap and an
italic attribution footer inside that same quote. Preserve raw provider text separately.

```markdown
> @tanaabot can you confirm whether this also covers comments received while planning?
>
> <br>
>
> _[Comment ↗](https://github.com/tanaabased/example/issues/7#issuecomment-123) from [@pirog](https://github.com/pirog)_
```

Use these labels and connectors. The label links to the exact verified comment,
not merely its issue or PR; the handle links to the verified author's profile.
Normal HTTPS links do not promise a particular browser destination.

| Variant                           | Label           | Connector |
| --------------------------------- | --------------- | --------- |
| Incoming comment                  | Comment         | from      |
| Outgoing reply                    | Reply           | from      |
| Inline or grouped review feedback | Review comment  | from      |
| Public assessment summary         | Plan assessment | by        |
| Public PR announcement            | PR announcement | by        |

The quoted `<br>` separator has operator-confirmed Codex display support. Native
OpenClaw spacing must also be observed: renderer output or an HTML preview is not
native display evidence. Do not introduce `<small>` or HTML anchors, which Codex
displays literally. Record any unsupported host limitation and missing native
capture in acceptance evidence; do not claim cross-host rendering from strings alone.

Review cards put each finding's prose before its file, reviewed commit, and available
current/original location. Retain each finding's own permalink and the group's exact
review permalink in the footer. Mark unchanged summaries as context and original
locations as historical. Show available reviewed diff hunks in fenced `diff` blocks,
capped at the last 20 lines with long lines shortened; label shortened previews as
excerpts and keep warnings and links to full context. These are reviewed commits,
not fresh working-tree diffs. Parent text and full retained hunks remain structured context.

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
> - **Selected:** `<saved model>` / `<saved effort>`
> - **Basis:** <complexity and concise selection rationale>
> - **Source:** <saved profile and evidence source>
> - **Effective settings:** <verified native settings or not independently verified>

## Proposed change

<problem and proposed solution as a concise user journey, brief documentation/test impact, and consequential limits or decisions>

The full assessment and engineering plan are saved for implementation. Ask for the full assessment to inspect them.
```

For results with an explicit `reviewSummary` and retained `fullAssessment`, show the
review by default instead of the engineering source. Explain what the person does
today, where it fails, and what they would do and receive after the proposed change.
Include brief documentation and test impact in the repository's own terms, plus any
risk, uncertainty, or decision that could change approval. Roughly 200–400 words is
an editorial guide for an ordinary human review, not a limit or minimum. Small fixes
need less. Do not apply review-length guidance to the retained assessment or plan.

The full engineering assessment remains authoritative for implementation: rationale,
tradeoffs, owners, dependencies, constraints, complete plan, validation, evidence, and
unresolved questions. Keep it unchanged in `fullAssessment` and retain the full
implementation plan in `plan`. `reviewSummary` is a derived human view, never a
replacement source. `assessment` may repeat the recommendation; `planSummary` remains
optional. Requesting `includeDetails: true` shows the complete assessment and any
distinct plan, followed by supporting evidence and investigation.

Without both an explicit review and full source, preserve the existing complete
inline display for older/custom results. Omit only verbatim duplicate openings;
never infer expendable content from headings, size, or skill identity. Never truncate
or rewrite substantive source text. Questions and required actions remain prominent
in every default and detailed view, even when repeated in the complete source.

When an assessment includes a continuation decision, show an **Auto mode decision**
card after the instruction card (or routing card when debug is off). Keep it visible
regardless of debug presentation. Use ▶️ for `work` and ⏸️ for `plan`, with the exact
code-formatted value in **Decision**. Use **Next** to distinguish automatic continuation
once runtime checks pass from waiting for the operator's direction before implementation.
Follow with bounded **Reason** rows. Escape reason text and withhold credential-shaped
content; do not present the decision as permission or replace the retained assessment.

The private routing card follows the recommendation (or a distinct assessment). Its values come from saved routing and
native readback, with requested selection distinct from effective execution. Preserve
the model, effort, selection rationale, and provenance; use readable Markdown rather
than assuming native card styling. By default, do not append the retained engineering source, structured evidence, or investigation when a human review is present. When explicitly requested,
place retained **Evidence** and **Investigation** under one **Reference material** section
after the complete source, questions, or setup action. Introduce it as supporting detail; nest **Completed** and **Remaining** beneath
Investigation. Omit empty subsections and omit Reference material when both are empty.
Keep consequential uncertainty, blocking questions, and required actions in the primary
assessment, questions, or action; the reference section must not be their only home.
The framing follows the structured result; prose headings never select state.

When debug presentation is enabled, follow Model routing with a quoted
**🔬 Debug** card with **Context: Assessment instructions**. Show the retained **Skill**, including the
default, linked to its resolved `SKILL.md`. Show file **Guidance** as a linked
workspace-relative label. For inline guidance, link “Inline guidance” to its
verified manifest source when available, then show the retained text in a literal
block preserving whitespace and Markdown characters. The source file may change;
the retained text records what the turn used. Keep these links and instructions
private. Selection metadata is not proof of compliance.

Reuse the same **🔬 Debug** component with **Implementation instructions** context
immediately after the PR card and **Feedback reply instructions** context after the public reply quote and
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
> Thanks for flagging this, @pirog. The notification flow now preserves the link.
>
> <br>
>
> _Reply draft from [@smutlord](https://github.com/smutlord)_
```

Quote the exact GitHub-facing text, not a paraphrase. Outgoing attribution names the
verified posting agent, never the recipient. Before publication use an unlinked
`Reply draft`, `Plan assessment draft`, or `PR announcement draft` footer. After
confirmed publication, replace it with the corresponding linked label above: this
footer is the publication receipt, so omit separate success cards. Older retained
receipts without verified author metadata say `author unavailable`; never guess
from the recipient or active chat, or resolve credentials just for presentation.

Assessment summaries retain the complete private assessment and plan separately.
PR announcements use this same renderer with the exact public announcement, including
its PR link, below the complete private **Pull request opened** card. Preserve native
PR attachment. Keep failed, withheld, pending, or uncertain publication visible in
separate warning callouts, with debug off too. Successful no-action recovery details,
such as verified issue linkage after retry, use **🔬 Debug** with delivery recovery
context only when debug is enabled. Historical missing archive/removal evidence
uses the same card with intake context, separate from actionable warnings. Omit
empty debug cards. Visibility changes are not cleanup recovery; unchanged debug
detail does not wake quiet intake or create repeated notifications.

## Private and Public Composition

Keep the complete incoming comment or review card at the top of the final response;
commentary alone is insufficient because clients may collapse it. Preserve the full
private response outside the public quote. Keep debug instruction cards private and
after the reply/footer or publication obstacle.

```markdown
> <complete incoming comment>
>
> <br>
>
> _[Comment ↗](https://github.com/owner/repo/issues/123#issuecomment-456) from [@author](https://github.com/author)_

## Response

<complete private response>

> <complete GitHub-facing response>
>
> <br>
>
> _[Reply ↗](https://github.com/owner/repo/issues/123#issuecomment-789) from [@smutlord](https://github.com/smutlord)_
```

## Delivery Recovery Notices

Keep recovery private in the owning issue conversation, below the complete private
result and any exact public draft. Reuse one quoted outcome component for assessment
summaries, public replies and PR announcements. Name the affected step; a failed push
is not a failed comment. Show pending as information, and unconfirmed or blocked
publication as a warning, with the known destination, next supported action and safe
diagnostic. Distinguish deliberately withheld replies from failed delivery.

Do not describe recovery as running unless native execution establishes that fact.
Unconfirmed writes require observation before any new post. Preserve completed work
and drafts; do not tell the operator to reset the workflow. Unchanged polling must not
produce repeated notices. Confirmed publication uses the linked attribution footer
above, without a separate success card.
