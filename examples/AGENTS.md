# Leia Example Guidance

## Scope

- Treat each `examples/<scenario>/README.md` as one executable, user-visible contract and one CI matrix identity.
- Keep scenario setup, assertions, and any justified cleanup in the owning README.
- Keep scenario-owned fixtures beside their README and hoist only after two live scenarios share the same contract.
- Keep immediate child directories limited to scenario names represented in `.github/workflows/pr-examples-tests.yml`; `AGENTS.md` and `package.json` are the examples-level boundary files.

## OpenClaw Runtime

- Use the fresh runner's default OpenClaw profile and Gateway directly. Do not introduce DevGuard unless DevGuard integration is the behavior under test.
- Register named agents explicitly and bind them to scenario-owned workspaces; do not rely on OpenClaw's implicit `main` fallback as agent-context proof.
- Keep static agent workspaces and message inputs checked in beside their owning README and use them in place on fresh GitHub Actions runners. Copy a fixture only when isolation from a tested mutation is part of the scenario contract.
- Background `openclaw gateway run` with its PID and combined output beneath `TMPDIR`, use bounded readiness and shutdown polling, and preserve a diagnostic log tail when coordination fails.
- When an unattended OpenClaw CI scenario invokes tools, run `openclaw exec-policy preset yolo` in that scenario's setup; use it only with isolated ephemeral state and never as routine local validation against a developer's normal profile.
- Keep workflow-provided model credentials optional for scenarios that do not invoke a live agent.

## Assertions

- Start each executable block with one lowercase `# should ...` statement and keep one observable behavior per block.
- Keep every command in a `# should ...` block directly tied to preparing, invoking, or asserting the behavior named by that statement; remove unrelated preflights, repeated assertions, and third-party re-tests.
- Prefer public commands and direct fixed-string assertions over repository-specific wrappers.
- Pipe command output directly into fixed-string assertions when possible; do not write output to a temporary file solely for a later grep.
- Use multiple direct command-and-grep assertions in one test when expected properties occur on different output lines; do not reshape output solely to force one assertion pipeline.
- Do not add preflight checks when the immediately following product command validates the same requirement.
- Prefer one command per line; avoid `command && next-command` when ordinary newline sequencing expresses the same fail-fast flow.
- Treat blank-line-separated blocks as separate scripts; do not rely on variables, shell options, functions, or working directories persisting between them.
- Keep runtime-derived state beneath the scenario's `TMPDIR` and keep generated state out of version control.
- Keep scenario-specific expected values visible in the README or checked-in fixture; use helpers only for bounded process coordination or structured validation.

## Boundaries

- Do not use literal backticks, braced shell expansions, or numeric backreferences inside executable Leia blocks.
- Never run Leia scenarios locally. They are operational tests owned exclusively by `.github/workflows/pr-examples-tests.yml` on fresh GitHub Actions runners.
