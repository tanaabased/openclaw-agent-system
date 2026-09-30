# Repository Automation Contract

Research and proposed implementation contract for [#193](https://github.com/tanaabased/openclaw-agent-system/issues/193)
under [#192](https://github.com/tanaabased/openclaw-agent-system/issues/192).
This repository-only document is not shipped configuration documentation. The
shared declaration parser is implemented in #194 and documented in
[MANIFEST.md](../MANIFEST.md#automations). Native scheduling and adapters remain
implementation work for #195–#197.

## Recommended First Delivery

Useful automation is feasible without runtime parity or a new scheduler:

- **OpenClaw:** reconcile through its authenticated operator CLI transport, then
  let its native scheduler run commands or agent turns. Command jobs should enter
  a narrow Agent System runner that supplies setup-style managed launchers and
  fresh agent authority, so scripts can use plain `git` and `gh`.
- **Codex:** compute a deterministic desired/observed plan, have a Codex skill apply
  that plan through the native automation tool, then verify saved settings. Me
  already implements this pattern. Direct synchronization from a headless CLI is
  not a prerequisite for this first delivery.
- Accept native retry, same-job concurrency, catch-up, and DST behavior initially.
  Add no Agent System retry loop. Report differences instead of inventing a common
  scheduler or promising unsupported controls.
- Codex jobs initially run prompts. A prompt may explicitly invoke a fixed script,
  but that costs a model turn and must be declared as a prompt. Zero-model commands
  remain an OpenClaw capability until a native Codex scheduled-command path exists.

This contract permits operator-command execution, native retry behavior, and
model-mediated Codex sync. Native concurrency and the narrower schedule/timeout
support below are recommended first-delivery tradeoffs for review. The original
parent acceptance criteria are not all satisfied by this slice.

## OpenClaw: Management and Execution Are Separate

### Native job management

`api.runtime.gateway.request` is an in-process API restricted to trusted/bundled
plugins. That restriction does **not** prohibit an authenticated operator from
managing jobs through the public CLI transport. The pinned SDK exports
`callGatewayFromCli` from `openclaw/plugin-sdk/gateway-runtime`; this repository
already uses it in [cli/credentials-cache.ts](../cli/credentials-cache.ts).
OpenClaw's own automation CLI uses the same helper for `cron.*` requests.

| Operation                           | Native request / relevant fields                                |
| ----------------------------------- | --------------------------------------------------------------- |
| Create / declarative reconciliation | `cron.add`, including `declarationKey`                          |
| Read                                | `cron.get`                                                      |
| Update / disable                    | `cron.update`, `patch.enabled: false`, `expectedConfigRevision` |
| List                                | `cron.list`, including disabled jobs and pagination             |
| Run now                             | `cron.run`, with returned run identity                          |
| Read run results                    | `cron.runs`                                                     |

Implement this in the **operator CLI** install/sync/Doctor path, following the
existing cache command's dependency injection. Mutations require native
`operator.admin`; inspection requests use the scope required by the native method
and read-only shared-state mode where supported. Native authentication remains
authoritative. No credentials in `agent.yaml`, private-store writes, internal
imports, or spawned Gateway CLI workaround are needed.

Do not call the operator helper from model tools, passive hooks, or arbitrary
Gateway plugin callbacks merely to obtain operator authority. The first delivery
can return an actionable operator-sync requirement from those contexts. Keep
`install`'s existing operator admission gate and reuse one reconciliation owner;
Doctor inspects without executing jobs. This deliberately separates operator
reconciliation from the more limited in-process plugin API.

### Deterministic command jobs

The native `command` payload calls a process runner directly, without a model.
It is an operator-authored host job, not a model's `tools.exec` invocation. It does
not automatically receive Agent System's descendant authority or launchers.

**Use a plugin-owned command runner for the first delivery.** The native scheduler
launches one fixed Agent System CLI entrypoint with the owned job identity and
expected effective hash. That runner validates the installed agent, workspace,
enabled declaration, and synchronized command before issuing temporary authority
and running the payload. Missing ownership, disabled/removed jobs, or changed
effective content require sync; do not execute newly discovered content through
an old scheduler entry. The CLI spelling remains implementation work in #195/#197.

The existing [agent/setup-command-service.ts](../agent/setup-command-service.ts)
already owns the useful mechanism: it validates the installed workspace, creates
an `AgentCommandAuthority`, supplies an invocation-scoped command executor, issues
a bounded capability, and runs with the packaged launchers first on PATH. The
launchers route supported plain commands through the existing tool runtime.
Credentials stay with each managed tool invocation, not in the script environment.
Reuse this mechanism through a small shared command-execution owner; keep setup
checks, prerequisite probes, install reconciliation, and setup-specific mode
metadata in setup. Scheduled execution must not masquerade as a setup check or
run setup steps. Gateway conversation authorities remain binding-only.

The intended path is:

```text
native scheduled command
  -> Agent System owned-job runner
  -> fresh agent binding + managed launchers
  -> repository script using git / gh / registered command routes
  -> existing tool policy, identity, and invocation-scoped credentials
```

This needs no model turn and no conversational session. The runner is an explicit
operator entrypoint with the existing admission gate: a model descendant cannot
use it to select a new agent, and invalid inherited authority must fail rather
than be cleared. Fix the executable/profile/cwd at reconciliation; mint capability
only when execution begins, revoke it on completion/cancellation, and bound its
lifetime by the job deadline. Never persist a live capability or secret environment
in a scheduler record. The implementation must also prove cleanup when the native
scheduler terminates the runner and its process tree.

Plain commands receive setup's existing routing semantics, not a complete OS
sandbox: managed cwd and cross-agent checks still apply; contextual `git`/`gh`
may use sanitized host fallback outside admitted scope, while strict managed
launchers reject that fallback. Arbitrary executables and absolute host paths do
not become managed tools. Missing agent credentials must never fall back to the
operator's credentials for a managed invocation.

### Why a runner rather than a cron hook

The pinned native command runner invokes `runCommandWithTimeout` directly; it
does not call `resolve_exec_env`. That hook applies to model `exec` tool calls.
`cron_reconciled` and `cron_changed` observe state/lifecycle changes; their handler
contracts return `void`, not per-run environment or execution overrides. Do not
use a `started` notification to race-inject authority or modify global process
environment. The public plugin CLI registration surface supplies the required
entrypoint without patching OpenClaw or adding another scheduler. These findings
agree with the official [exec hook](https://docs.openclaw.ai/plugins/hooks/tool-policy)
and [cron hook](https://docs.openclaw.ai/plugins/hooks/reference) contracts.

Explicit operator tool calls remain useful for separately authored raw host jobs:

```sh
# raw operator job alternative, outside the bound runner above.
openclaw agent-system tool gh --agent tanaabot -- api user --jq .login
```

The code path is [cli/tool.ts](../cli/tool.ts) →
[api/manifest-binding.ts](../api/manifest-binding.ts) →
[api/runtime.ts](../api/runtime.ts) → [api/cli-execution.ts](../api/cli-execution.ts).
It resolves the installed agent, checks configured tool policy before environment
and credential resolution, and supplies credentials only to that tool invocation.
An active agent binding still prohibits selecting another agent.

Inside the proposed bound runner, use managed launchers instead; explicit `--agent`
selection remains rejected. The raw operator form is an available alternative,
not a requirement imposed on every repository command.

Installed acceptance must prove native scheduler → runner → plain `git`/`gh`,
intended identity, policy denial before credentials, containment, and authority
cleanup. Existing setup tests cover those mechanisms with real launcher subprocesses
and fake providers; that is useful reuse evidence, not scheduled execution proof.

Prompt jobs instead use native `agentTurn` with the owning agent and explicit
`isolated` targeting by default. Use native Agent System tools inside those turns;
do not instruct a model to impersonate an operator with `--agent`.

## Codex: Reuse Me's Reconciliation Pattern

At Me revision `69dd4515f189d9ab8d018bc623f883412e997e27`,
[`AUTOMATIONS.yaml`](https://github.com/pirog/me/blob/69dd4515f189d9ab8d018bc623f883412e997e27/AUTOMATIONS.yaml)
declares scheduled tasks and
[`skills/automation/SKILL.md`](https://github.com/pirog/me/blob/69dd4515f189d9ab8d018bc623f883412e997e27/skills/automation/SKILL.md)
owns synchronization. Its implementation separates:

1. Manifest/reference validation and deterministic schedule compilation.
2. Read-only inspection of saved native settings and current profile defaults.
3. A deterministic action plan, ownership marker, and SHA-256 plan digest.
4. Authorized sequential writes through the session's native `automation_update` tool.
5. Saved-state readback after each write and a final drift check.

The model operates the native tool; it does not invent desired state, ownership,
schedule parsing, or the diff. Keep that separation in Agent System. Expose a
deterministic plan/check result from the existing standalone lifecycle owner and
have its install/sync skill complete the native app operations under the user's
authorization. Headless CLI calls can report `requires-native-app-sync` with the
plan instead of claiming convergence. Doctor can report drift without model calls.
An unchanged plan needs no mutation. A passive SessionStart hook may advertise
non-secret drift, but must not schedule jobs or become a recurring scheduler.

Me's workflow is a reference, not a drop-in adapter:

- Its reader supports version-1 thread heartbeats and local **projectless** cron
  records. Its planner can select a local project, but saved project-record
  inspection must be extended before Agent System can claim workspace-bound sync.
- Me deletes absent managed jobs; Agent System must pause and retain them instead.
- Me's recurring compiler does not prove one-shot timestamp persistence, explicit
  timezone control, all cron expressions, or scheduler execution.
- Me uses a prompt ownership marker. Agent System should use its own scoped marker
  plus a non-secret native-ID ledger; do not adopt Me or unmarked jobs by name.
- The current create tool requires explicit model/effort for standalone cron jobs.
  Materialize defaults at sync time and compare them on later syncs; do not claim
  native inheritance. Existing-thread heartbeats retain that thread's settings.
- Native `view` may return only a rendered acknowledgment. Verify saved definitions
  with the bounded reader; never write TOML/SQLite directly. Unknown saved schemas
  are an inspection error, not an empty list.

Codex CLI `0.154.0` has no scheduler methods among the 159 generated experimental
App Server client request methods inspected. It does have immediate `command/exec`
without a model turn. Neither fact prevents the desktop-tool workflow above.
The desktop tool offers prompt-based create/update/view/delete and active/paused
state; this is sufficient to investigate reconciliation. A native run-now tool
was not established: #197 must distinguish an explicit equivalent manual task
from firing the saved scheduler occurrence, and report that limitation.

Use ambient Codex profile authorization. A narrow prompt that runs a repository
script is an explicit, model-backed execution option; it does not require a new
credential system. It also does not guarantee exactly-once execution, timeout,
or retries. Keep any necessary retry logic in bounded deterministic code, rather
than expecting prompt wording to guarantee it. Native scheduling continues to own
timing and history. [Official scheduled-task documentation](https://learn.chatgpt.com/docs/automations?surface=app)
supports skill-driven task creation; [hooks](https://learn.chatgpt.com/docs/hooks)
are lifecycle callbacks and do not establish a scheduler reconciliation API.

## Proposed Manifest Shape

Keep one shared declaration, with runtime-specific support reported per job.
The shared syntax is implemented by #194; runtime support remains adapter-owned.

| Field             | Type / default                        | Contract                                                                                                                                        |
| ----------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | required kebab-case string            | Unique stable job ID within the workspace.                                                                                                      |
| `enabled`         | boolean, `true`                       | Desired state; does not resurrect a consumed one-shot.                                                                                          |
| `runtimes`        | unique nonempty list, both runtimes   | `openclaw` / `codex`; unsupported applicable jobs are reported, never silently converted.                                                       |
| `schedule`        | required string or object             | Deterministic grammar below.                                                                                                                    |
| `run`             | command short form                    | Nonblank shell string, argv array, or `{ command, args? }`; zero-model execution, initially OpenClaw only.                                      |
| `prompt`          | prompt short form                     | Nonblank inline text or `{ file: relative-path }`.                                                                                              |
| `payload`         | long form                             | `{ kind: command, run: ..., shell?: ... }` or `{ kind: prompt, prompt: ... }`.                                                                  |
| `shell`           | shell-string short form, `sh`         | `sh`, `bash`, or `zsh`; reuse setup's shell flags.                                                                                              |
| `timeout-seconds` | optional positive integer, 1–3600     | OpenClaw proposed default 1800; Codex native default unless a supported limit is established. Explicit unsupported limits produce a diagnostic. |
| `overrides`       | optional `openclaw` / `codex` objects | Prompt `model`, `effort`, and `target` only; no arbitrary native JSON.                                                                          |

Exactly one short-form payload or one long-form payload is allowed. Reject mixed
forms, duplicate IDs, unknown keys, invalid references, empty argv, NULs, and unsafe
executable paths. Job-level timeout is the only timeout; do not inherit setup's
nested timeout field. Reuse command normalization without setup checks or steps.
Omitted `automations` and `[]` declare no jobs; an invalid or unreadable file must
never be interpreted as removal.

`automations` accepts a list or `{ file: ./automations.yaml }` naming a YAML list.
Each included path resolves relative to the file containing it; execution cwd
remains the workspace root. Reuse the existing size, UTF-8, strict YAML, regular-file,
and symlink/workspace containment checks. No recursive YAML inclusion in this slice.

```yaml
# .agent-system/agent.yaml
automations:
  file: ./automations.yaml
```

```yaml
# .agent-system/automations.yaml
- id: hourly-review
  schedule: every 1 hour
  prompt:
    file: ../automations/review.md
- id: github-check
  runtimes: [openclaw]
  schedule: every 1 hour
  timeout-seconds: 1800
  payload:
    kind: command
    run:
      command: gh
      args: [api, user, --jq, .login]
- id: codex-report
  runtimes: [codex]
  schedule: '0 9 * * 1-5'
  prompt: Run node scripts/report.mjs once from this workspace and report its exit status.
```

The command entry relies on the proposed bound runner; it is not a raw native
command job. The last entry intentionally incurs a model turn. The first defaults to an
independent workspace-bound native run. `overrides.<runtime>.target` may be
`independent` or `{ thread: existing-native-id }`; verify the exact existing local
target and ownership, never silently bind the installer conversation or create a
replacement. Omitted model/effort follows each adapter's documented default
resolution. Command jobs reject prompt-only overrides. Neither payload permits
arbitrary agent selectors, environment/credential injection, or cwd overrides as
manifest metadata; an operator-authored command's explicit CLI arguments remain
ordinary command content, with the tool's own binding and policy checks.

### Schedule and Execution Semantics

Normalize `every 1 hour` as recurring elapsed time and `in 1 hour` as a one-shot
delay. Accept positive integer durations in seconds, minutes, hours, or days with
matching singular/plural units; a day is 86,400 seconds. Normalize whitespace;
reject fractions, compound durations, overflow, and natural-language guesses.
Absolute one-shots use valid RFC 3339 timestamps with seconds and an explicit
offset; normalize to UTC. No leap seconds or precision beyond milliseconds.

Cron shorthand is five numeric fields (minute 0–59, hour 0–23, day 1–31, month
1–12, weekday 0–6), with `*`, numbers, ascending ranges, lists, and positive steps
on `*` or ranges. Day-of-month/day-of-week use OR when both are restricted. Reject
six-field cron, names/macros, wraparound ranges, special tokens, and impossible
schedules. Preserve day-field wildcard semantics in normalization.

Long form uses exactly one of `cron`, `every`, `in`, or `at`, plus optional
`timezone` and `missed-run`, for example:

```yaml
schedule:
  cron: '0 9 * * 1-5'
  timezone: America/New_York
  missed-run: native
```

`timezone` applies only to cron: an IANA zone or `native` (default). `missed-run`
initially accepts only `native`. Adapters report the effective native zone,
DST/catch-up behavior, and representability instead of imposing a new timing
engine. OpenClaw can set timezone and zero staggering explicitly; retain native
DST behavior. Codex starts with intervals and recurring daily/weekly/monthly
patterns demonstrably representable by its native recurrence tool. Compile common
cron patterns deterministically; reject expressions requiring multiple jobs or
unproven timezone features. Arbitrary cron and one-shots in Codex remain separate
capability checks, not blockers for recurring prompt jobs.

Use native same-job concurrency and retries in the first delivery. OpenClaw skips
admitting an active job and has recurring error backoff and interrupted-run
recovery. Agent System adds no retry or overlap emulation. A request for stricter
semantics must be rejected if the runtime cannot provide it. A narrow prompt does
not change the scheduler's retry policy. Evaluate the 1800-second default for
OpenClaw commands/agent turns; native code-mode scripts have a separate 900-second
cap and are not the shell-command mapping. Do not invent a hard Codex timeout by
putting a duration in prompt text.

### Reconciliation and One-Shot State

Scope ownership by runtime/profile, canonical workspace, trusted agent identity,
and manifest ID. Keep native ID and optional declaration key, normalized content
hash, schedule identity/generation, resolved anchor/time, observed native completion,
and pending reconciliation operation in Agent System-owned non-secret state.
Do not store credentials or output. A name match never establishes ownership.

Hash versioned canonical JSON of each effective job: materialize defaults, sort
object keys and set-valued fields, preserve argv order and prompt/script content,
load referenced Markdown, and apply only that runtime's overrides. YAML formatting
alone is not drift. Do not recursively hash arbitrary executable dependencies.

Resolve relative delays once at initial activation and persist the resolved time
before create, so recovering a failed sync does not move the deadline. Retain it
across unchanged sync, prompt edits, pause/resume, and removal/reintroduction.
Track trigger identity separately from execution policy; changing timeout or
missed-run settings does not rearm a one-shot. Only an explicit manifest trigger
change creates a new schedule generation. Completed native one-shots stay consumed
even if desired `enabled` remains true. Preserve native pending retries/recovery
rather than promising a stronger no-replay guarantee. If native state is ambiguous,
report it and do not recreate or explicitly run the job to settle it.

Removed jobs are paused/disabled with history and mapping retained; reintroduced
IDs reuse them. Native UI edits are drift restored by explicit sync. Unchanged
jobs receive no writes. Preserve native safety auto-disable and report it for
operator recovery. Missing native jobs or ownership records require recovery,
not blind recreation or name-based adoption. Keep successful one-shots retained
with OpenClaw `deleteAfterRun: false`; history otherwise follows native retention.

Validate the applicable plan before changing jobs. Recheck desired/observed state
before applying it, serialize owned reconciliation, journal pending operations,
and verify readback after each action. Use native revision preconditions where
available; Codex precheck/readback is not an atomic compare-and-swap guarantee.
Stop on divergence and report partial results. Native job creation succeeding
before ledger acknowledgement must recover by its exact ownership marker/ID;
never create a second job blindly. Saved configuration convergence is distinct
from a successful scheduled execution.

Keep execution and delivery results separate wherever native history exposes
them. A delivery failure must not cause Agent System to replay a successful
payload. Report unavailable native delivery telemetry as unavailable. Explicit
run-by-ID support must use the native occurrence interface or clearly identify
an equivalent manual execution and its history/one-shot differences.

## Evidence and Remaining Proof

Inspected on 2026-09-29. Agent System base `c68b66d` pins OpenClaw `2026.9.6` and
Codex CLI `0.154.0`; the separately installed desktop reports `26.623.141536`,
build `4753`. Me's source revision is recorded above and pins its own CLI version;
its workflow is not evidence of a scheduler API in Agent System's CLI pin.

| Evidence                                                                                                                                            | What it establishes / remaining proof                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openclaw/plugin-sdk/gateway-runtime` export and `gateway-rpc-JavFiplO.d.ts`; package `dist/cron-cli-Cymc7OJV.mjs`                                  | Supported CLI transport and native cron usage. `cli/credentials-cache.ts` proves an existing repository consumer. Still requires authenticated installed acceptance for scheduling.                  |
| Package `docs/plugins/sdk-runtime/gateway-and-nodes.md`                                                                                             | Restricted in-process plugin API; not a prohibition on the separate operator transport.                                                                                                              |
| Package `dist/cron-DcDJigA2.mjs`, `cronHandlers`                                                                                                    | Native read/create/update/run/history routes and update revision checks.                                                                                                                             |
| Package `dist/server-cron-Dd6AX5Mc.mjs`, `runCronCommandJob`                                                                                        | Direct process runner, no model dispatch. Actual scheduler-to-Agent-System invocation remains to be tested in GitHub Actions.                                                                        |
| Repository `cli/tool.ts`, `api/manifest-binding.ts`, `api/runtime.ts`, `api/cli-execution.ts`, and their focused tests                              | Operator tool selection, installed-agent binding, policy before credentials, per-invocation child environment. Source evidence, not a live scheduled identity proof.                                 |
| Package `dist/service-C-O17TZr.mjs` and `dist/jobs-scheduling-BuJ7Yxlw.mjs`                                                                         | `declarationKey` reconciliation, timeout policy, active-job exclusion, backoff, and native one-shot recovery.                                                                                        |
| Generated Codex `ClientRequest.json` including experimental methods                                                                                 | 159 client methods, no scheduler methods; immediate `command/exec` exists. Generation did not start a server or job.                                                                                 |
| Me `lib/automation-manifest.js`, `lib/automation-plan.js`, `utils/compile-automation-schedule.js`, `skills/automation/lib/read-automation-state.js` | Deterministic plan plus native-tool write workflow. The four focused suites passed: 29 tests.                                                                                                        |
| Read-only Me desired/saved comparison                                                                                                               | The workflow is present and inspectable. The snapshot had one unchanged job, one prompt drift, and one missing heartbeat requiring a target. No live changes were made; this is not execution proof. |

No live OpenClaw commands, scheduled payloads, or scheduler mutations were run in
this investigation. Schemas/source and Me's focused tests establish viable designs,
not installed end-to-end success. The pinned Node 26.10.0 is not installed locally;
Agent System tests were inspected, not rerun under a substituted Node version.

## Child-Issue Handoff

- **#194:** normalize this proposed shared syntax and referenced content. Test
  short/long equivalence, containment, effective hashes, recurring versus delayed
  schedules, malformed inputs, and adapter-specific support diagnostics.
- **#195:** build the OpenClaw operator transport adapter and inspect/reconcile
  owner, with a bounded owned-job runner reusing setup's command-binding mechanism.
  Keep setup-only behavior separate. Test supported RPC shapes, ownership, removal/reintroduction, partial
  failure, native revisions, one-shot persistence, timeout, and execution/delivery
  results. Add GitHub Actions-only installed proof for zero-model scripts using
  plain managed `git`/`gh`, stale/disabled job rejection, cross-agent denial,
  policy before credentials, missing-credential failure, and authority cleanup on
  timeout/cancellation, plus a prompt using the owning agent context. Model-facing
  install must not acquire CLI operator authority as an implicit fallback.
- **#196:** adapt Me's deterministic planner/native-tool workflow to the shared
  lifecycle. First prove workspace/project saved-state readback; implement pause
  on removal and stable owned mappings. Start with recurring prompt jobs, native
  concurrency/timeouts, and explicit targets. Report CLI-only sync, zero-model
  commands, unsupported schedules and unproven one-shot persistence honestly.
- **#197:** expose list/check/sync through those owners, preserve headless versus
  app-assisted results, and distinguish native run-now from equivalent manual
  execution. Demonstrate each supported runtime slice without claiming universal
  parity or closing #192 while its deferred requirements remain unmet.
