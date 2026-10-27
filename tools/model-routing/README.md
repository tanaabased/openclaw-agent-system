# Model Routing

[Agent System Model Routing](../../skills/model-routing/SKILL.md) assesses bounded task
evidence and validates model and effort selections from the active workspace's
[model profiles](../../MANIFEST.md#models). The calling model assesses the task. The
helper validates that assessment without calling another classifier, creating tasks, or
changing sessions.

## `agent_system_model_routing`

Inspect the active OpenClaw agent's profiles or resolve an assessment. OpenClaw-hosted Codex uses this native tool too. The active agent and workspace come from trusted tool context; parameters cannot select another workspace. Only non-secret manifest data and configured routing guidance are read; no dispatch enrollment is required.

### Parameters

| Field                    | Required                 | Default                            | Description                                                                                                                                                                       |
| ------------------------ | ------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`                 | yes                      | none                               | `inspect` or `resolve`.                                                                                                                                                           |
| `assessment.complexity`  | for `resolve`            | none                               | `low`, `medium`, `high`, or `unset`.                                                                                                                                              |
| `assessment.reason`      | for `resolve`            | none                               | Nonempty single-line explanation, at most 400 characters.                                                                                                                         |
| `assessment.xhighReason` | when selecting xhigh     | none                               | Concrete justification, at most 400 characters.                                                                                                                                   |
| `context`                | for `resolve`            | none                               | Task evidence as text or `{title, body}`. Title must be nonempty and body must be text; combined text, including two separating newlines, is limited to 18,000 characters.        |
| `evidence`               | no                       | content assessment                 | `{complexity, source}` for explicit/verified Complexity. Source is `user`, `native`, or `body fallback`. The assessment must agree.                                               |
| `fallback`               | no                       | no selection on unresolved         | `default` explicitly selects the configured default when complexity is `unset` or work tiers are omitted.                                                                         |
| `instructionsDigest`     | for customized `resolve` | optional for the unchanged default | Digest returned by inspection; changed guidance requires reassessment. Pass it for every inspected selection.                                                                     |
| `manifestDigest`         | for `resolve`            | none                               | Digest returned by inspection; stale profiles are rejected.                                                                                                                       |
| `overrides.effort`       | no                       | profile effort                     | Explicit `none`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `adaptive`, `max`, or `ultra`; Codex does not map `off` or `adaptive`. Native controls remain authoritative. |
| `overrides.model`        | no                       | profile model                      | Explicit provider-qualified model; standalone Codex also accepts native model ids.                                                                                                |

`inspect` accepts only `action`. Unknown fields are rejected. Partial work-tier declarations are invalid; default-only profiles are supported by an explicit default policy.

### Usage

```json
{ "action": "inspect" }
```

```json
{
  "action": "resolve",
  "manifestDigest": "digest-from-inspect",
  "context": "The task does not yet identify the affected component.",
  "assessment": { "complexity": "unset", "reason": "Insufficient scope to select a tier." },
  "fallback": "default"
}
```

Inspection returns `status`, `manifestDigest`, `profiles`, `rubric`, `instructions`, `instructionsDigest`, `instructionsGuidance`, and `reportGuidance`. The instructions identify the selected method and any loaded guidance. Direct OpenClaw leaves custom skill discovery and reading to the host-native caller; it does not claim server-verified skill source evidence. Standalone Codex and scheduled owners resolve custom skills through their existing native catalogs and retain source digests. See [routing configuration and precedence](../../MANIFEST.md#models). Each profile contains `sourceModel`, native `model`, and `thinking`, or an explicit unsupported diagnostic. Configuration generators consume `profiles.default`; no model or effort values are built in.

Resolution returns `status` (`resolved` or `unresolved`), `profile`, `complexity`, `source`, `reason`, optional `xhighReason`, `recommendation`, `selection`, and `overrides`. An unresolved result has a null profile and no recommendation or selection unless the caller explicitly requests default fallback or supplies both override values. Partial overrides remain in the result for the caller to complete. The result retains unresolved status and reasoning even when default is selected.

Mapped selections include a native `candidate`. `application: "not-requested"` and
`execution: "unverified"` make the evidence boundary explicit. Use the runtime's
supported controls to apply the candidate and verify the result. Unknown models or
unsupported model/effort combinations can still be rejected there; profile mapping is
not runtime discovery.

Missing profiles or binding report unavailable. Invalid profiles, malformed requests, changed manifests, evidence conflicts, unsupported mappings/selections, and unjustified xhigh report errors without substitution. These outcomes never grant permission to launch work or change an existing session.

## Standalone Codex Adapter

Use the newest trusted hook's `routingRuntime.argvPrefix`, append `--plugin-data` and `routingRuntime.pluginData`, and supply the same request JSON on standard input. The packaged entry is `dist/codex/codex-runtime.js model-routing`. It reads the persisted binding, manifest, and configured guidance, and uses native `skills/list` for a custom skill; cwd and `CODEX_HOME` do not select profiles. See [Codex routing](../../CODEX.md#model-routing).

## Reporting and Continuation

Pass the inspection's `reportGuidance` with the saved decision to routed work. Its first assessment includes a short **Model routing** blockquote with model, effort, complexity, evidence source, reason, and overrides. Label unresolved default use. Keep recommendations, requested application, and verified execution separate. Ordinary follow-ups, resume, and compaction preserve the saved selection.

Native issue workflows use the same resolver with bounded routing evidence and durable workflow state. Their routing block remains private; see [Codex routing](../../CODEX.md#model-routing).
