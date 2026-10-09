# Issue 249 handoff

Updated 2026-10-09, America/New_York. This is a resumption note, not authorization
to implement assessed issues or restart automation.

## Where the work stands

Repository: `tanaabased/openclaw-agent-system`. Branch: `codex-workflows`.
The implementation and readability guidance are pushed through `454d7c5`.
`origin/main` at `a02afc3` was merged in `dfd4cb1`; the checkout was clean before
adding this handoff. The user's existing `package.json` changes were preserved.

Relevant commits:

- `dc2d084`: assessment presentation, complete result retention, dispatch repairs,
  and explicit reassessment reset.
- `dfd4cb1`: merge main; preserve both Codex example additions and adapt the new
  manifest-overlay test to the existing legacy-notification helper.
- `0fd55f6`: add the reader-focused review pass.
- `454d7c5`: require an actual user-facing rewrite and add a short translation example.

No implementation of #250 or #285 was performed. Both remain open. No pull request
was created for this work, and no issue was closed.

## What #249 now does

Assessment results appear in this order: assessment, model-routing card, concise
plan summary, then the full plan inline. There is no accordion or separate plan
document to open. The full plan has no word-count or bullet-count target.

The existing version 1 result has a separate `planSummary`. It is optional in the
schema for old saved results, but required by the skill for new plan-ready results.
The runtime renders the saved result and verified routing information. Model prose
does not select lifecycle state or grant permission to implement anything.

The full plan retains applicable Code, Documentation, Tests, Operations, and Other
sections, expected file changes, justified documentation and test work, dependencies,
and engineering detail. Empty sections are omitted. Investigation must inspect the
repository and existing helpers rather than merely paraphrase the issue.

The opening is for the person deciding what to approve. After completing the
engineering plan, the assessor rewrites the opening around the user's task, current
friction, proposed change, and consequential choices or limits. Technical detail
stays in the full plan unless the reader needs it for a decision. The rewrite must
preserve facts, uncertainty, and the distinction between requirements and proposals.

Primary owners:

- `skills/issue-assessment/SKILL.md`: investigation and final rewrite workflow.
- `channels/github/PRESENTATION.md`: audience, layout, and review criteria.
- `agent/assessment-result.ts`: saved result schema.
- `channels/github/conversation/presentation/assessment-result.ts`: renderer.
- `agent/codex-dispatch.ts`, `agent/codex-dispatch-native.ts`, and
  `agent/codex-dispatch-state.ts`: dispatch, recovery, and retained state.
- `examples/codex/README.md`: installed acceptance guidance; execution remains CI-owned.

## Dispatch repairs and limits

- Native creation receives the exact prepared title. Recovery searches all model
  providers, retains verified child identity before later failures, and corrects a
  changed title only after identity, worktree, and model verification.
- A separate app-server can report an active desktop turn as `notLoaded` and
  `interrupted`. That caused a false missing-result notice during the #250 pilot.
  Polling now requires positively idle native state and a terminal turn before
  declaring a missing result. Unloaded history leaves the work pending; an abandoned
  chat without live status needs operator inspection.
- Reassignment alone does not create another chat for an already dispatched issue.
  An operator-only `reset` action previews an exact receipt and applies with its
  digest. It preserves the completed assessment and requires a new assignment event
  after reset before normal intake may create one fresh assessment. Reset requires
  native confirmation that the recorded result turn completed with no later turn.
  Do not delete journals or repeat uncertain native creation calls to rerun a pilot.

## Pilot evidence and readability finding

#250 was tested through a fresh scheduled assignment after explicit reset. It created
a separate chat and worktree with the correct title and verified model settings.
The result contained a summary and full inline plan. The false polling blocker was
fixed; the following scheduled poll reported the completed result.

Its prose nevertheless failed the user-facing readability requirement. It described
internal mechanisms instead of explaining the problem and proposed fix. Formatting,
concision, and technically grounded content did not establish readability.

#285 was then assigned through normal intake as a fresh assessment-only pilot. The
first version improved the opening but still used unexplained implementation terms.
The guidance was strengthened and the same chat regenerated its assessment after
rereading the installed skill and presentation contract. Its revised assessment was:

> You use the same profile on two machines and want to decide which one handles issue
> assignments, review requests, or feedback. Today, there is no separate off switch
> for each workflow: suppressing one means changing its list of allowed people.
> That makes a machine preference look like a change in whom you trust. You need to
> turn a workflow off on one machine, leave those people listed, and turn it back on
> later without starting over.

The revised summary explained the on/off controls, installation steps, preserved
work, unsupported features, and verification in user terms. The engineering plan
changed only to refresh its branch reference. This is positive evidence from a
revision on a different issue, not proof that every future first attempt will pass.
A fresh-chat readability trial with the final guidance is a useful next check when
the user authorizes more pilots. Do not use word counts or banned-word tests as a
substitute for reading the actual result.

## Paused state and cleanup

The native automation `issue-assignments` (display name `📥 ISSUE ASSIGNMENTS`) was
paused through `automation_update`, and saved status was verified as `PAUSED`.
Its prompt, cadence, and owning intake chat were preserved. Keep it paused until
the user explicitly asks to resume; do not infer activation from pulling this branch.

The #250 and #285 pilot chats were archived. The earlier #250 pilot was already
archived. Their worktrees were clean before archival; the temporary #250 and #285
checkout paths are no longer present after archiving. Completed dispatch results
remain retained. Do not assume an archived chat still has a usable checkout.
The user's GitHub assignments were removed from both issues; read-back confirmed
that #250 and #285 remain open with no assignees.
The control chat `ISSUE ASSIGNMENTS` remains available for later authorized resumption.
Native automation state, plugin binding, private dispatch records, and archived
chats are host state; pulling Git does not migrate them to another computer.

## Validation and resumption

The merged implementation passed lint, typecheck, 1,973 unit tests, build, plugin
validation, and 24 release checks. Lint retained one existing `no-console` warning
in `examples/automations/model-fixture.ts`. Skill validation and formatting passed.
After the prose-only refinements, skill/format checks and all 24 release checks
passed again. `codex:sync` and `codex:check` verified the installed source cache.
No local Leia scenarios or live OpenClaw operational tests were run.

On the other computer:

1. Fetch and update `codex-workflows`, preserving any local work. Use the repository's
   pinned Bun and Node versions from `.bun-version` and `.node-version`.
2. Read this handoff and the applicable repository instructions. Inspect the current
   plugin installation and explicit workspace binding before relying on them.
3. If this is already an installed source checkout, run `bun run codex:sync` followed
   by `bun run codex:check`; otherwise follow the supported install/binding workflow.
   Use a fresh chat to verify discovery of the updated assessment skill.
4. Keep issue intake paused. Any activation on the new computer needs explicit user
   authorization and native saved-state verification. Do not copy scheduler files,
   impersonate old chat IDs, or treat old private receipts as portable authority.
5. Review #249's acceptance criteria and the reader-facing output before deciding
   whether to deliver it or run another assessment-only pilot. #250 and #285 still
   require separate implementation authorization.
