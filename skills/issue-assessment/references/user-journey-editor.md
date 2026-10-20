# User Journey Editor

The assessor has finished investigating and planning. A separate editor now explains
the proposed experience to the person deciding whether to approve it. The full plan
keeps its engineering detail; this pass only supplies the opening.

## Assessor handoff

Use the host's native helper/subagent facility with conversation inheritance disabled
(for example, `fork_turns: "none"` when that option is exposed). Inherit the selected
model and effort; do not choose a cheaper or different model. Supply the **Editor
instructions** below verbatim and a brief containing only:

- Who is trying to do what, and why.
- What they do today, what happens, and the concrete difficulty.
- Under the proposal, what they would do first, what would happen next, and what
  they would see or receive. Name real controls or product concepts when known;
  explicitly mark proposed behavior and unknown interaction details.
- Relevant failure cases, the explanation the user would receive, and what they
  could do next, where established by the plan.
- Only choices, limits, and unresolved questions that change what the person would
  do, receive, or need to decide. State whether this is a plan or clarification.

Use factual notes, not a drafted summary. Keep requirements, observations, and
proposals distinct. This is not a checklist of everything the plan guarantees.
For each detail ask: would leaving it out mislead the person about their action,
expected result, or decision? Omit implementation constraints such as encodings,
byte limits, symlink rules, schema validation, and compatibility bookkeeping unless
that constraint is itself the user's problem or changes a consequential choice.
Keep those details in the full plan. Never conceal costs, data loss, access changes,
blocking questions, or other consequences the person needs to approve knowingly.
Omit code structure, file inventories, internal phase names, test matrices, routing
metadata, raw provider prose, and the earlier opening. Never send the whole plan as
a shortcut. This brief is working context, not a new persisted schema or visible section.

The helper may edit wording only. It must not use tools, investigate, write files,
contact the user, invoke other agents, or publish a result. The assessor remains the
only caller of the result runtime. Inspect the actual helper invocation during pilots:
an instruction to imagine a fresh reader is not evidence of context isolation.

## Editor instructions

You are explaining a proposed change to the person who will use it. Work only from
the supplied factual brief. Do not use tools or perform further investigation.

Write the experience in time order: what the person wants to accomplish, what they
do now and where that fails, then what they would do and receive after the change.
Use the person as the subject and concrete verbs: choose, assign, open, read, change,
retry. Where relevant, explain what happens when something is missing or fails and
what the person can do about it. Do not invent a button, command, promise, or benefit
to make the story easier to tell. Preserve uncertainty and conditional behavior.

Return only these fields as text for the assessor:

- **summary:** one sentence explaining the useful change or the blocked decision.
- **assessment:** a short explanation of the person's goal and current difficulty.
- **planSummary:** for a plan, the proposed sequence of user actions and observable
  results, plus the choices and limits needed to approve it. Omit this field for a
  clarification or setup-blocker outcome; keep the blocked decision visible in the
  other fields.

Tell one concrete before-and-after story, not a condensed specification or instruction
manual. Follow the main sequence instead of enumerating every option combination and
failure condition. You may omit supplied notes that do not change the person's actions,
results, or consequential decisions; the brief is evidence, not a checklist to repeat.
There is no word quota. Stop when the person can picture using the change and make
the relevant decision. Do not pad the opening with validation plans, architectural
reassurance, permission catalogues, or a list of implementation components.

Treat words such as contract, pathway, surface, dispatch, provenance, lifecycle,
adapter, and orchestration as warning signs in this opening. Translate the action or
consequence they stand for. Do not merely replace them with equally abstract synonyms
such as mechanism or procedure. This is not a ban on necessary product names or
technical terms: retain GitHub, pull request, skill, or another term the reader needs
to recognize, and explain an unfamiliar term through its use.

For example, "add a trusted assessment selection contract with retained provenance"
does not describe a user journey. If supported by the brief, explain: "You could
give your agent extra instructions or choose another assessment skill. When you
assign an issue, it would follow that choice and return its assessment and plan in
the usual chat. If it cannot find the chosen skill, it would tell you what to fix."
Use the example's concrete sequence, not its subject matter, for other tasks.

Before returning, read the opening as someone who has not seen the engineering plan.
Every sentence should explain a goal, action, visible result, obstacle, or decision.
Remove sentences that merely announce parts being built. If the brief lacks a fact
needed for an accurate explanation, flag that gap to the assessor instead of guessing.
