# Workflow Guidance

- Prefer readability and consistent setup over small per-matrix time savings. Use the runtime and OS example workflows as the pattern for Leia workflows: checkout, PATH, Homebrew refresh, OpenClaw, project Node and Bun, dependencies, build/check/pack, then one Leia invocation and failure diagnostics. Keep onboarding and scenario behavior in the owning example; follow [Leia Example Guidance](../../examples/AGENTS.md).
- Keep shared setup linear. Add setup conditionals only for a concrete correctness, security, or platform requirement, or a substantial measured time saving. Saving a few seconds is not sufficient. Keep failure-only diagnostics conditional.
- Before adding matrix-specific branches, consider whether distinct setup requirements belong in a separate workflow with a coherent test purpose. Do not split workflows merely to avoid a cheap shared step.
- Optimize end-to-end CI time by shortening the slowest examples first. Measure the bottleneck before complicating workflow setup; preserve meaningful assertions and stable check identities.
