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
> <one-sentence outcome summary>

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

When an assessment includes a continuation decision, show an **Auto mode decision**
card after the instruction card (or routing card when debug is off). Keep it visible
regardless of debug presentation. Use ▶️ for `work` and ⏸️ for `plan`, with the exact
code-formatted value in **Decision**. Use **Next** to distinguish automatic continuation
once runtime checks pass from waiting for the operator's direction before implementation.
Follow with bounded **Reason** rows. Escape reason text and withhold credential-shaped
content; do not present the decision as permission or replace the complete assessment.

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
such as verified issue linkage after retry, appear only with debug enabled.

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
