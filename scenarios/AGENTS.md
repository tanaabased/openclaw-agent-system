# Leia Notification Scenario Guidance

## Scope

- Treat each `scenarios/<scenario>/README.md` as one executable GitHub notification acceptance contract and one CI matrix identity.
- Name notification scenarios from their supported lifecycle, mode, and event or bounded outcome; keep prerequisite setup separate from the behavior asserted by the scenario.
- Keep scenario setup, deterministic assertions, bounded disposable GitHub fixtures, and cleanup in the owning directory.
- Keep immediate child directories limited to lifecycle-mode-scenario names selectable through `.github/workflows/notification-tests.yml` or `.github/workflows/pr-notification-tests.yml`; keep other scenario-level files limited to `AGENTS.md` and `package.json`.
- Run focused notification scenarios through the manual workflow's scenario and runner choices. Keep `all` as the bounded way to run every currently supported scenario on one selected runner.
- Use the shared Leia command helpers from `scripts/`; do not recreate or wrap them inside a scenario.

## Runtime

- Use the fresh runner's default OpenClaw profile and Gateway directly, with the prepared Agent System package supplied by the workflow.
- Pass scenario-owned inputs to shared Leia helpers as command-line options. Reserve environment variables for the process or underlying runtime.
- Use `openclaw-notification-setup` for provider-specific profile preparation, mock evidence comparison, and model shutdown. Keep provider branches out of scenario README files.
- Register named agents explicitly, bind them to scenario-owned workspaces, and keep generated state beneath `TMPDIR`.
- Use `--yolo` only for unattended live-agent work in the isolated ephemeral runner.
- Keep model and provider credentials scoped to the final Leia execution step in `.github/workflows/reusable-notification-test.yml` and load account tokens from declared 1Password Environments.

## Assertions

- Assert stable publication envelopes, trusted lifecycle state, and durable provider or repository side effects; never derive deterministic control from model-authored wording, headings, or formatting.
- Start every executable block with one fully lowercase `# should ...` statement and keep one observable behavior per block.
- Keep scenario-specific expected values visible in the README or checked-in fixture and keep cleanup bounded to the generated resources.

## Boundaries

- Never run Leia notification scenarios locally. They are operational tests owned exclusively by `.github/workflows/notification-tests.yml` and `.github/workflows/pr-notification-tests.yml` on fresh GitHub Actions runners. Pull requests use Ubuntu; manual dispatch may select Ubuntu or macOS.
- Do not use literal backticks, braced shell expansions, or numeric backreferences inside executable Leia blocks.
