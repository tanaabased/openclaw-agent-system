# Lifecycle tools

`agent_system_install` and `agent_system_doctor` run Agent System lifecycle
operations for the active OpenClaw agent after explicit chat approval. Both the
default OpenClaw harness and OpenClaw-hosted Codex use these native tools;
standalone Codex does not acquire an OpenClaw approval route by installing skills.

Call Doctor with `{}`. Call install with `{}`, `{"skipSetup": true}` to omit
setup checks and applies, or `{"rebuildCodexPath": true}` to replace the saved
Codex PATH baseline with the invoking environment. The tools accept no agent,
workspace, manifest, or approval overrides. Existing OpenClaw tool restrictions
still apply. Run the operator CLI install once when an existing agent needs the
new tool grants.

OpenClaw displays the operation, agent, workspace, manifest digest, and setup
scope before any lifecycle inspection, commands, or credential resolution. Select
**Allow once** or **Deny**. OpenClaw owns approval delivery and approver
authorization; Agent System adds no operator identity or persistent trust store.

Consent is valid for one matching tool call and expires after two minutes. A
changed manifest, workspace binding, operation, or option requires new approval.
The approval description names a requested Codex PATH rebuild before it can run.
Denial, timeout, cancellation while waiting, and an unavailable approval route
execute nothing. Missing hooks also prevent execution. Nested lifecycle consumers
cannot reload a different manifest under the approved operation.

Doctor runs declared checks and reports findings; it never applies repairs.
Install may run checks and applies, reconcile configuration, and resolve declared
credentials. Cancellation after execution begins stops subsequent lifecycle
steps and cancellable setup commands; completed external effects are not rolled
back. An approved script remains operator-authored code, including any files or
external services it reads.

The `openclaw agent-system install`, `doctor`, and `status` command routes remain
operator-only. Agents and setup descendants must not invoke them through shell
tools. `--yes`, a missing TTY, skill prose, and earlier approvals confer no native
tool approval. The operator CLI retains its existing explicit-install workflow.

## Compatibility and validation

The declared compatibility floor and installed acceptance target are OpenClaw
**2026.9.5**. Control UI chat is the initial acceptance surface. The
[GitHub Actions approval example](../../examples/approval/README.md) exercises
the Control UI protocol and installed approval routing with both harnesses,
covering allow, deny, cancellation, and unavailable approval. These operational
tests run only in GitHub Actions; local unit checks do not establish installed
chat compatibility. Other chat channels depend on their OpenClaw plugin approval
support and are outside this acceptance matrix.

The integration uses the public
[`before_tool_call.requireApproval` hook](https://docs.openclaw.ai/plugins/plugin-permission-requests).
It does not use protected Gateway runtime APIs, generic MCP approval restoration,
or changes to Git/GitHub authorization.
