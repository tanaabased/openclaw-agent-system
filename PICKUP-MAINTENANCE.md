# project pickup maintenance

repair checklist for `pirog-project-pickup-maintenance`, started 2026-11-03
from `main` at `5eb440f2`. repairs are grouped into local commits;
no push, installation or live scheduled pilot has been performed.

## completed source repairs

- [x] allow live pickup repository, milestone and selection changes without Install.
      timing changes reconcile the native schedule through Install. preserve original
      assignment scope and receipts, reconcile uncertain effects
      without another write, and cancel obsolete unattempted selections.
- [x] keep native activation stable across live target edits; still detect actual
      native automation drift and installation identity changes.
- [x] reuse an unused current window after a target edit, retaining explicit cancellation
      and attempted-assignment allowance.
- [x] defer unreadable individual candidates while checking other candidates; stop the
      scan on account, throttle or transport failures. share item-error classification with intake.
- [x] admit complete grouped reviews without an aggregate body/diff cap, retain them in
      the journal, and page context through both authorized native adapters.
- [x] verify OpenClaw pickup authority through the existing enrolled read transport,
      without depending on a service-start scheduler handle. add specific denial diagnostics
      and CI-only hosted Codex adapter coverage. the reported live failure's cause remains
      unproven until that path is exercised.
- [x] reconsider pre-assignment failures and empty scans within an open window. retain
      cancellation and uncertain-assignment protections.
- [x] release pickup's extra reservation when ordinary intake takes ownership. native
      capacity governs subsequent work without charging the same issue twice.
- [x] enforce the pickup deadline before assignment starts. accept verified delayed
      completion, including a lost response, without issuing another assignment.
- [x] preserve full candidate descriptions and guidance through shared material paging;
      remove the 128 KiB candidate rejection. keep history cards out of intermediate output.
- [x] use the shared 32,768-byte guidance limit. make discovery resumable within pages,
      remove ten-page/1,000-candidate ceilings, and follow dependency pagination.
- [x] match standalone Codex capture to the measured native 1 MiB per-stream default
      in Codex 0.164.0 and 0.165.0, retaining explicit overrides and loss accounting.
      OpenClaw keeps its native capture defaults.
- [x] restrict the work-mode exception to verified pickup receipts. ordinary assignments
      in the configured milestone keep their configured mode; no global settings change.
- [x] let admitted pickup issues use ordinary assignment checks. closing or changing their
      milestone and adding collaborators no longer blocks dispatch. exact identity,
      assignment continuity, ownership receipts and duplicate prevention remain enforced.

## current repair and scheduling pass

- [x] retain the verified self-assignment/work exception before intake even if pickup
      configuration is removed or a collaborator is added. removal of the receiver,
      stale assignment events and missing receipts still prevent admission.
- [x] let later native scans select more work after ordinary intake takes custody,
      under its normal capacity limit. retain one successful assignment per native scan.
- [x] replace all-day model wakeups with daily native scan slots. defaults: 03:00 local,
      two hours, eight scans. accept clock variants, window/duration units and closing-time
      alternatives; reject conflicting values. remove the former schedule/window-minutes
      input fields. schedule edits require Install; target and selection edits stay live.
- [x] remove pickup’s pre-assignment election. new receipts
      use ordinary assignment routing and claim election. preserve verified self-assignment
      and Work exceptions, uncertain-write recovery and previously retained claim owners.
      controlled sequential and overlapping scans exercise the shared intake handoff.
- [x] reuse shared routing eligibility for pickup and ordinary intake before selection and
      assignment. excluded installations leave the issue unassigned for an eligible participant;
      uncertain writes retain their original recovery path.
- [x] stop reserving capacity for discovery or selection. reserve only an assignment attempt
      awaiting ordinary intake, with a fresh capacity check before the write.
- [x] remove the retired interval-window path and unused candidate type; selection fixtures
      use the same daily clock schedule as production.

## validation and rollout

- [x] focused boundary regressions: 107 checks passed across shared behavior and both
      native intake adapters. the preceding maintenance snapshot passed 4,393 tests,
      lint, typecheck, build and plugin checks.
- [x] preceding `bun run validate`: 4,422 tests passed, plus lint, typecheck, build and
      plugin checks. `git diff --check` passed.
- [x] receipt and lost-claim repairs: 109 focused checks plus 34 native intake checks;
      final `bun run validate` passed 4,430 tests, lint, typecheck, build and plugin checks.
- [x] daily scheduling and thin pickup handoff: full validation passed 4,426 checks.
      the final resumed-scan accounting fix passed 192 focused checks, lint, typecheck,
      build and plugin checks; sequential and overlapping scans use ordinary intake ownership.
- [x] routing eligibility and capacity cleanup: 196 focused checks passed; final
      `bun run validate` passed 4,433 checks, lint, typecheck, build and plugin checks.
      the subsequent read-only optimizer found no further actionable defects in the
      maintenance scope. retain uncertain-write recovery and prior ownership receipts;
      installed and live scheduled behavior remains unverified below.
- [ ] CI exercises the affected installed boundaries; never run Leia examples locally.
- [ ] approved installation reconciles Me's selected milestone and Doctor confirms readiness.
- [ ] record real scheduled selection, one self-assignment, ordinary intake and delivery
      for both runtimes under [#529](https://github.com/tanaabased/openclaw-agent-system/issues/529).
      controlled fixtures do not establish live scheduled success.

## boundaries

pickup owns selection, its window, the assignment attempt and its verified receipt.
ordinary issue assignment owns assessment, chats, worktrees, implementation and PR delivery.
no new routing configuration, scheduler or execution pipeline. no issue or PR created yet.
