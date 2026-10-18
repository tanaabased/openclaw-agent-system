# Leia Example Guidance

## Scope

- Treat each `examples/<scenario>/README.md` as one executable, user-visible contract and one CI matrix identity.
- Keep Leia coverage on essential installed critical paths: prepare the declared state, perform the supported operation, and verify its meaningful result. Keep parsing permutations, optional branches, formatting variants, and exhaustive failure cases in unit or component tests unless the installed runtime or native OS boundary is necessary to detect the failure.
- Choose the driver from the contract rather than the folder: use direct assertions when state proves the behavior, strict AIMock when the real OpenClaw agent/tool loop matters without model judgment, and a live model only when provider transport, model interpretation, or Codex-native tool behavior is itself under test.
- Keep scenario setup, assertions, and any justified cleanup in the owning README.
- Keep scenario-owned model fixtures and expected evidence beside their README. Share only provider lifecycle machinery through `scripts/openclaw-aimock`.
- Keep examples in a flat list of scenario folders, with `os-`, `shared-`, `openclaw-`, or `codex-` prefixes as coverage is reorganized. Select active scenarios explicitly in the owning example workflow. Retire superseded examples and their fixture imports after preserving the critical installed contracts and their owning source assertions. Keep other examples-level files limited to `AGENTS.md` and `package.json`.
- Use one Leia execution step after setup in each example workflow, with all scenario environment variables in that step's `env` block. Unused values may be shared across matrix entries, including test credentials and model settings; do not split the invocation solely to narrow environment scope. Keep credentials off setup steps. Follow Leia with the same generic `failure()` diagnostics block in each example workflow; do not restrict it to selected matrix entries.
- Use the shared Leia command helpers from `scripts/`; do not recreate or wrap them inside an example.

## OpenClaw Runtime

- Follow the repository’s Tanaabot-only test assignment rule. Each GitHub-backed notification example must refresh only its own fixture by repository, kind, and number; observing one issue with `notifications wait --number` alone does not restrict discovery.

- Prefer `openclaw agent-system` subcommands for supported managed operations and observations, including installation, validation, Doctor, environment, credentials, automation list/sync/run/history, backup, and tool execution. This exercises the public Agent System boundary together with its underlying integration. Keep native OpenClaw commands when no equivalent exists, when creating deliberately unmanaged state or drift, or when independently observing native state or exercising the real agent/tool loop is the contract. Do not replace a managed-launcher or native-execution test with a different entrypoint.
- For managed tool coverage, exercise both the public `openclaw agent-system tool` route and packaged shims. Where setup or automation scripts use those shims, verify that their descendants retain the owning agent identity and credential boundary.
- Use the fresh runner's default OpenClaw profile and Gateway directly. Do not introduce DevGuard unless DevGuard integration is the behavior under test.
- Use `openclaw-setup` for the shared isolated profile and packed Agent System plugin setup. Pass the prepared pack through `--agent-system`, use `--needs-secret-service` when a scenario exercises the native credential backend, including session-dispatch enrollment, use `--needs-ssh-key` only when a scenario needs the shared SSH fixture, and use `--yolo` only when an unattended agent scenario requires tool execution. Omit `--model` for direct and AIMock scenarios; configure strict AIMock afterward through `openclaw-aimock`. Pass a complete provider/model reference only for a justified live-model scenario. Treat successful setup as proof that the resulting OpenClaw configuration is valid and any supplied Agent System pack is enabled and runtime-loadable; keep scenario assertions focused on behavior beyond those shared postconditions.
- Pass scenario-owned inputs to shared Leia helpers as command-line options. Reserve environment variables for the process or underlying runtime rather than using helper-specific environment aliases in scenario READMEs.
- Register named agents explicitly and bind them to scenario-owned workspaces; do not rely on OpenClaw's implicit `main` fallback as agent-context proof.
- Keep static agent workspaces and message inputs checked in beside their owning README and run them in place on fresh GitHub Actions runners. Writing receipts, initializing repositories, rendering provider pins, or changing a manifest does not justify copying the workspace; the checkout is disposable. Keep separate copies only when distinct paths, an independent baseline, or a restore target are part of the tested contract, and explain that reason in the scenario. Keep runtime evidence, external state, and shared generated secrets beneath `TMPDIR` or the isolated runtime home. Place generated keys or outputs in the disposable workspace only when the declared operation requires them; never commit generated state.
- Background `openclaw gateway run` with its PID and combined output beneath `TMPDIR`, use bounded readiness and shutdown polling, and preserve a diagnostic log tail when coordination fails.
- When an unattended OpenClaw CI scenario invokes tools, pass `--yolo` to `openclaw-setup`; use it only with isolated ephemeral state and never as routine local validation against a developer's normal profile.
- Make live 1Password requests only when the test verifies 1Password behavior. Use host environment variables with explicit manifest imports for ordinary test authentication.
- Keep workflow-provided model credentials optional for scenarios that do not invoke a live agent.
- Use strict AIMock for `os-execution`, `openclaw-agent`, `openclaw-automations`, `openclaw-credentials`, `openclaw-collaboration`, `openclaw-github`, `openclaw-worktree`, `openclaw-issue`, `openclaw-pr`, and both native OpenClaw and hosted Codex turns in `openclaw-runtimes`. Memory's embedding fixture uses strict AIMock with synthetic authentication and fixed vectors rather than a model turn. Keep the real runtime tool execution and native approvals when mocking model responses. Other examples use direct assertions; shared live-model credentials never select a scenario's driver.
- Give strict AIMock fixtures bounded recovery for recurring, explicitly recognized transient tool results, such as private-state contention. Retry the same operation with the same arguments and a distinct tool-call id; retain its real result and require the original durable outcome. After the retry budget, report the diagnostic and let the scenario fail. Do not silently repair permissions, stale authority, unknown failures, or uncertain external writes; use the operation's supported reconciliation for uncertain outcomes. Recovery belongs in the owning model fixture, not shell reruns that conceal a failed journey.
- Keep shared command success output stable, route diagnostics to standard error, and use `OPENCLAW_DEBUG`, `OPENCLAW_LOG_LEVEL=debug`, `DEBUG`, or runner debug mode for opt-in diagnostics.

## Assertions

- Start each executable block with one fully lowercase `# should ...` statement and keep one observable behavior per block. Preserve required casing only in commands, inputs, and expected contract values.
- Keep every command in a `# should ...` block directly tied to preparing, invoking, or asserting the behavior named by that statement; remove unrelated preflights, repeated assertions, and third-party re-tests.
- Prefer public commands and direct fixed-string assertions over repository-specific wrappers.
- Pipe command output directly into fixed-string assertions when possible; do not write output to a temporary file solely for a later grep.
- When multiple expected properties must occur on the same output line, chain fixed-string greps in one pipeline; do not assert formatter padding or alignment whitespace.
- Use multiple direct command-and-grep assertions in one test when expected properties occur on different output lines; do not reshape output solely to force one assertion pipeline.
- Do not add preflight checks when the immediately following product command validates the same requirement.
- Run required commands directly and let missing prerequisites, unexpected exit codes, and absent results fail the test. Do not skip required work behind availability guards, repair it with a fallback, or add tests that merely demonstrate shell conditionals. Keep expected-failure assertions only for critical protection boundaries that need installed-runtime proof.
- Use bounded polling only for asynchronous readiness or completion that the preceding command does not already await. Keep cleanup and diagnostic branches tied to scenario-owned resources; they must not turn failed work into success.
- Prefer one command per line; avoid `command && next-command` when ordinary newline sequencing expresses the same fail-fast flow.
- Treat blank-line-separated blocks as separate scripts; do not rely on variables, shell options, functions, or working directories persisting between them.
- Keep runtime evidence beneath the scenario's `TMPDIR`; keep scenario-owned outputs in the disposable workspace when the operation requires them. Never commit generated state.
- Keep scenario-specific expected values visible in the README or checked-in fixture; use helpers only for bounded process coordination or structured validation.

## Boundaries

- Do not use literal backticks, braced shell expansions, or numeric backreferences inside executable Leia blocks.
- Never run Leia examples locally. They are operational tests owned exclusively by the example workflows under `.github/workflows/` on fresh GitHub Actions runners.
