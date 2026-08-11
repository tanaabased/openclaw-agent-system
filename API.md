# Tool API

This guide records the planned public tool integration contract for OpenClaw
plugins that want to add tools compatible with [Agent System](./README.md).

> [!IMPORTANT]
> The public Tool API is not available in the current release. Agent System's
> first-party tools use an internal contract while a supported typed
> cross-plugin registration and runtime boundary is designed with OpenClaw.

## Goal

The public API will let another OpenClaw plugin register a compatible tool
without reproducing Agent System's agent binding, environment and credential
resolution, policy enforcement, execution safety, redaction, auditing, or
diagnostics.

Agent System will own:

- trusted binding between a tool call and an installed agent workspace
- operation-policy and approval sequencing
- scoped environment and credential resolution
- safe execution, redaction, auditing, and common diagnostics

Each compatible tool will own:

- a stable tool id, model-input schema, and optional manifest schema
- command or API behavior and operation classification
- configuration projection and supplemental redaction
- lifecycle checks and focused user guidance when the capability needs them

## Policy Boundary

A compatible request will follow one shared sequence:

1. bind the request to a trusted agent workspace
2. validate and classify the requested operation
3. apply the configured `allow`, `ask`, or `deny` policy and any required approval
4. resolve only the credentials and resources needed for the approved operation
5. execute, redact, audit, and dispose of temporary material

Compatible tools will not receive a general raw-secret interface. Tool schemas
and implementations will be statically supplied by installed plugin code,
never loaded from a workspace manifest.

## Planned Tool Integration Contract

The eventual versioned contract is expected to cover:

| Surface                  | Purpose                                                   |
| ------------------------ | --------------------------------------------------------- |
| API version              | Declare compatibility with the Agent System Tool API.     |
| Tool id                  | Give the tool a stable diagnostic and ownership key.      |
| Tool definitions         | Supply static model schemas and operation behavior.       |
| Configuration projection | Validate and resolve the tool's manifest section.         |
| Lifecycle contributions  | Add optional validation, doctor, and install behavior.    |
| Runtime handle           | Request approved execution and narrowly scoped resources. |

The concrete TypeScript imports and registration call are intentionally not
documented yet: no supported public package export or OpenClaw cross-plugin
runtime capability currently exists. Publishing example code before those
boundaries are real would create an API that Agent System cannot support.

## Security Requirements

A public tool integration must preserve these boundaries:

- policy and approval happen before credential resolution
- tool input cannot select executable code, schemas, or modules
- secrets never enter model input, provenance, logs, diagnostics, or errors
- temporary credentials have the smallest practical action scope and lifetime
- remote-service permissions remain the final authorization boundary

## First-Party References

The current [`git`](./tools/git/README.md) and
[`gh`](./tools/github/README.md) wrappers exercise the internal contract. Their
guides document tool-specific configuration, policy, invocation, lifecycle, and
security behavior without defining the future public registration API.
