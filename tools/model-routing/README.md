# Model Routing

[Agent System Model Routing](../../skills/model-routing/SKILL.md) assesses bounded task evidence and validates model and effort selections from the active workspace's [model profiles](../../MANIFEST.md#models). The calling model supplies judgment; the helper neither calls a classifier nor creates tasks or changes sessions.

## `agent_system_model_routing`

Inspect the active OpenClaw agent's profiles or resolve an assessment. OpenClaw-hosted Codex uses this native tool too. The active agent and workspace come from trusted tool context; parameters cannot select another workspace. Only non-secret manifest data is read.

### Parameters

| Field                    | Required             | Default                    | Description                                                                                                                                                                       |
| ------------------------ | -------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`                 | yes                  | none                       | `inspect` or `resolve`.                                                                                                                                                           |
| `manifestDigest`         | for `resolve`        | none                       | Digest returned by inspection; stale profiles are rejected.                                                                                                                       |
| `context`                | for `resolve`        | none                       | Bounded task evidence, 1–18,000 characters.                                                                                                                                       |
| `assessment.complexity`  | for `resolve`        | none                       | `low`, `medium`, `high`, or `unset`.                                                                                                                                              |
| `assessment.reason`      | for `resolve`        | none                       | Nonempty single-line explanation, at most 400 characters.                                                                                                                         |
| `assessment.xhighReason` | when selecting xhigh | none                       | Concrete justification, at most 400 characters.                                                                                                                                   |
| `evidence`               | no                   | content assessment         | `{complexity, source}` for explicit/verified Complexity. Source is `user`, `native`, or `body fallback`. The assessment must agree.                                               |
| `overrides.model`        | no                   | profile model              | Explicit provider-qualified model; standalone Codex also accepts native model ids.                                                                                                |
| `overrides.effort`       | no                   | profile effort             | Explicit `none`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `adaptive`, `max`, or `ultra`; Codex does not map `off` or `adaptive`. Native controls remain authoritative. |
| `fallback`               | no                   | no selection on unresolved | `default` explicitly selects the configured default when complexity is `unset` or work tiers are omitted.                                                                         |

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

Inspection returns `status`, `manifestDigest`, `profiles`, `rubric`, and `reportGuidance`. Each profile contains `sourceModel`, native `model`, and `thinking`, or an explicit unsupported diagnostic. Configuration generators consume `profiles.default`; no model or effort values are built in.

Resolution returns `status` (`resolved` or `unresolved`), `profile`, `complexity`, `source`, `reason`, optional `xhighReason`, `recommendation`, `selection`, and `overrides`. An unresolved result has a null profile and no recommendation or selection unless the caller explicitly requests default fallback or supplies both override values. Partial overrides remain in the result for the caller to complete. The result retains unresolved status and reasoning even when default is selected.

Mapped selections include a native `candidate`. `application: "not-requested"` and `execution: "unverified"` make the evidence boundary explicit. The caller must apply and verify the candidate through supported native controls. Unknown models or unsupported model/effort combinations can still be rejected there; profile mapping is not runtime discovery.

Missing profiles or binding report unavailable. Invalid profiles, malformed requests, changed manifests, evidence conflicts, unsupported mappings/selections, and unjustified xhigh report errors without substitution. These outcomes never grant permission to launch work or change an existing session.

## Standalone Codex Adapter

Use the newest trusted hook's `routingRuntime.argvPrefix`, append `--plugin-data` and `routingRuntime.pluginData`, and supply the same request JSON on standard input. The packaged entry is `dist/codex/codex-runtime.js model-routing`. It reads only the persisted binding and manifest; cwd and `CODEX_HOME` do not select profiles. See [Codex routing](../../CODEX.md#model-routing).

## Reporting and Continuation

Pass the inspection's `reportGuidance` with the saved decision to routed work. Its first assessment includes a short **Model routing** blockquote with model, effort, complexity, evidence source, reason, and overrides. Label unresolved default use. Keep recommendations, requested application, and verified execution separate. Ordinary follow-ups, resume, and compaction preserve the saved selection.

GitHub intake uses the same resolver with its existing bounded classifier and durable conversation state. It explicitly selects its frozen default for unresolved complexity, retains the reason, and permits later manual selection. Its routing block remains private; see [GitHub routing](../../channels/github/ADVANCED.md#model-routing).
