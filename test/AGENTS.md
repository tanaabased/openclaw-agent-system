# Test Admission and Retention

Apply this gate to new tests and existing tests under review. A passing test, unique
case, or coverage increase does not establish value. Reject a proposed test, or
recommend removing an existing one, unless all of these hold:

- It rejects a plausible, consequential error in owned behavior. Name the wrong
  decision, output, or effect and its consequence; "this could break" is insufficient.
- Its expectation is independent of the implementation and injected answers. Explain
  why a plausible wrong implementation would fail the assertion. Replaying a mock's
  script does not prove that the product behaves correctly.
- It adds worthwhile protection beyond existing checks. A distinct edge case is not
  automatically worth testing; assess its consequence as well as its uniqueness.
- It uses the smallest faithful boundary and earns its setup, readability, coupling,
  runtime, and maintenance costs. Fast tests still have maintenance costs.

Use judgment in the change or review explanation, not a per-test registry, required
annotation, scoring scheme, deletion quota, or mandatory mutation-testing tool.

## Reject Low-Value Patterns

- Do not freeze incidental prose, source text, file layout, declaration order, or
  occurrence counts. Moving these assertions into static validation does not rescue them.
- Do not test internal call choreography, third-party guarantees, or every permutation
  of an already-covered decision. A new helper, file, or refactor does not itself need
  a new test.
- Do not duplicate a renderer's width/color matrix in every command or repeat shared
  fixture behavior through every wrapper. Keep command wiring and wrapper-specific
  behavior where they can fail independently.
- Keep tests of test machinery only where a defect could falsely pass or invalidate
  meaningful product evidence. Do not rehearse every branch of a scripted model.

Exact assertions remain appropriate for owned schema, protocol, security, and rendering
contracts. Boundary calls and call counts can prove meaningful effects or their absence;
they are not forbidden merely because they use mocks. Name the protected contract.

## Choose the Boundary

- Unit tests exercise owned decisions and transformations with controlled inputs and
  observable outputs or effects. Fake incidental process, network, clock, and host state.
- Component tests exercise real cooperation among owned units, with external boundaries
  injected. A process or filesystem fixture is justified only when that boundary matters;
  it is not required to qualify as a component test.
- Keep parser rejection and formatting cases with their existing unit owners. Do not run
  admission, dispatch, or native installation just to reach a pure validation assertion.
- Keep necessary native filesystem/process guarantees in OS components and installed
  runtime behavior in hosted Leia. Preserve both runtime adapters where each can fail
  independently. Follow the root validation guidance for focused local selections.

## Review and Remove

Review coherent groups against the gate, including passing tests and their fixture cost.
Recommend concrete removal, consolidation, or a cheaper faithful test; do not limit the
review to failures, timing, or missing coverage. For removals, identify retained meaningful
protection, an obsolete requirement, or a deliberate decision to leave low-consequence
detail untested because its cost exceeds its protection. Replacement is not automatic.

Preserve meaningful identity, authorization, destination, resource-loss, and uncertain or
duplicate-effect protection. Verify the retained assertions actually reject the relevant
wrong behavior; test names and existing coverage counts are not evidence. Do not retain
incidental checks merely because they share a spec with a critical one.
