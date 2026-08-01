# Leia Example Guidance

## Scope

- Treat each `examples/<scenario>/README.md` as one executable, user-visible contract and one CI matrix identity.
- Keep scenario setup, assertions, and any justified cleanup in the owning README.
- Keep scenario-owned fixtures beside their README and hoist only after two live scenarios share the same contract.

## Assertions

- Start each executable block with one lowercase `# should ...` statement and keep one observable behavior per block.
- Prefer public commands and direct fixed-string assertions over repository-specific wrappers.
- Treat blank-line-separated blocks as separate scripts; do not rely on variables, shell options, functions, or working directories persisting between them.
- Keep runtime-derived state beneath the scenario's `TMPDIR` and keep generated state out of version control.

## Boundaries

- Do not use literal backticks, braced shell expansions, or numeric backreferences inside executable Leia blocks.
- Never run Leia scenarios locally. They are operational tests owned exclusively by `.github/workflows/pr-examples-tests.yml` on fresh GitHub Actions runners.
