# Concurrent assignment regression baseline

The first source change for issue 75 was
`test/github-notification-concurrent-assignment.spec.ts`.
It uses the production candidate store, coordinator, and dispatcher, with only
the OpenClaw host boundary replaced by a deterministic file-backed session recorder.
Two store instances exchange candidates through private state files.

Baseline: `2fe15db` (notification intake, pull request 73).
Node: `26.7.0`; dependencies: the frozen repository lockfile.
The candidate store, coordinator, and dispatcher were temporarily restored from
that commit in the prepared worktree, the regression was run, and those files
were restored to the working base before implementation.

Command:

```sh
node --import tsx node_modules/mocha/bin/mocha.js test/github-notification-concurrent-assignment.spec.ts
```

Observed result (exit 1):

```text
0 passing (77ms)
1 failing
Error: second assignment rejected: reply-turn-already-active; session-2 missing
Caused by: GitHubNotificationReplyCandidateStoreError: The GitHub notification reply candidate turn is unavailable.
```

The first assignment had recorded its session and was held behind an explicit
promise barrier. The second failed before reaching the session recorder; its
session file was independently asserted absent. Releasing the barrier let the
first turn finish. This is not a timeout or a mocked store conflict.

The final regression also replays against those historical production files:
its test-only staging adapter retains the old call shape when no host binding
exists. A second replay reproduced the same conflict; the fixed code passes.

## Local verification

- Bun `1.3.14`, Node `26.7.0`.
- Lint (including formatting and ShellCheck), type checks, build, and plugin
  contract checks passed; the unit suite passed all 946 tests.
- All 17 release-package assertions passed with source inventory supplied by
  native Agent System Git and ClawHub's supported local OpenClaw target
  (`--openclaw node_modules/openclaw`). The ordinary subprocess Git launcher
  stalled and the latest-version registry lookup did not complete in this
  environment; neither was reported as a successful standard release run.
- The installed concurrency scenario is registered in the Ubuntu pull-request
  matrix and the manually selectable Ubuntu/macOS matrix. Installed examples
  and notification scenarios are CI-only and remain unverified until delivery.
