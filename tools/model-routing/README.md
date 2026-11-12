# Agent System Model Routing Tool

<a id="model-routing"></a>

<p align="center">
  <img src="../../skills/model-routing/assets/icon-large.svg" alt="Agent System Model Routing" width="180" />
</p>

Use [Model Routing](../../skills/model-routing/SKILL.md) to choose a model and reasoning
effort from the workspace's [profiles](../../MANIFEST.md#models). The calling model
assesses the task; the helper checks that assessment against the profiles. It does
not call another classifier, create a task, or change a chat.

- [Requirements](#requirements)
- [Configuration](#configuration)
- [`agent_system_model_routing`](#agent_system_model_routing)
  - [Parameters](#parameters)
  - [Usage](#usage)

## Requirements

Use the active OpenClaw agent's trusted tool context. In standalone Codex, use the
[Model Routing skill](../../skills/model-routing/SKILL.md) with a trusted workspace binding.
Model availability and supported effort remain subject to the owning runtime.

## Configuration

Configure [model profiles and routing guidance](../../MANIFEST.md#models) in the
workspace manifest. There is no separate tool configuration or dispatch enrollment
requirement.

## `agent_system_model_routing`

Inspect the active agent's profiles or use an assessment to select a model and effort.
OpenClaw-hosted Codex uses this tool too. The runtime supplies the agent and workspace;
callers cannot choose another workspace. The tool reads only non-secret manifest data
and configured routing guidance.

### Parameters

| Parameter                | Type             | Required                                     | Default             | Description                                                                                                                                                                       |
| ------------------------ | ---------------- | -------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`                 | string           | yes                                          | none                | `inspect` or `resolve`.                                                                                                                                                           |
| `assessment.complexity`  | string           | for `resolve`                                | none                | `low`, `medium`, `high`, or `unset`.                                                                                                                                              |
| `assessment.reason`      | string           | for `resolve`                                | none                | Nonempty single-line explanation, at most 400 characters.                                                                                                                         |
| `assessment.xhighReason` | string           | when overriding a non-xhigh profile to xhigh | none                | Concrete justification, at most 400 characters. Configured xhigh profiles need no additional justification.                                                                       |
| `context`                | string or object | for `resolve`                                | none                | Task evidence as text or `{title, body}`. Title must be nonempty and body must be text; combined text, including two separating newlines, is limited to 18,000 characters.        |
| `evidence`               | object           | no                                           | content assessment  | `{complexity, source}` for explicit/verified Complexity. Source is `user`, `native`, or `body fallback`. The assessment must agree.                                               |
| `fallback`               | string           | no                                           | default for `unset` | `default` selects the configured default when work tiers are omitted. Unset complexity uses the default automatically.                                                            |
| `overrides.effort`       | string           | no                                           | profile effort      | Explicit `none`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `adaptive`, `max`, or `ultra`; Codex does not map `off` or `adaptive`. Native controls remain authoritative. |
| `overrides.model`        | string           | no                                           | profile model       | Explicit provider-qualified model; standalone Codex also accepts native model ids.                                                                                                |

`inspect` accepts only `action`. Unknown fields are rejected. Partial work-tier declarations are invalid; a classified tier absent from a default-only workspace requires `fallback: "default"`.

### Usage

Inspect the configured profiles and routing instructions:

```json
{ "action": "inspect" }
```

Resolve unset complexity using the configured default:

```json
{
  "action": "resolve",
  "context": "The task does not yet identify the affected component.",
  "assessment": { "complexity": "unset", "reason": "Insufficient scope to select a tier." }
}
```

Inspection returns the profiles, routing instructions, and digests identifying their
current versions. Do not pass digests to `resolve`; the runtime reads the bound configuration.
Missing profiles or a missing workspace binding report
unavailable; invalid inputs and unsupported selections return errors without a substitute.

Resolution returns `resolved` or `unresolved`, the selected profile, reasoning, and
any native candidate. Unset complexity automatically selects the configured default
with any explicit model or effort overrides. Its status remains `unresolved` to
preserve uncertainty about complexity; this does not prevent applying the candidate.

The returned candidate does not change your chat or confirm that the model is available.
Apply it through your runtime's model controls and verify the resulting settings. See [routing precedence](../../MANIFEST.md#models).
