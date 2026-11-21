# API reference

Use [Manifest definitions](#manifest-definitions) to load workspace definitions without a runtime.
Use [Command report output](#command-report-output) to produce automation reports.

## Manifest definitions

Import the supported `@tanaab/openclaw-agent-system/manifest` subpath from Node.js
ES modules or TypeScript. Load definitions without OpenClaw, a Gateway, or an
Agent System binding. No credentials are resolved, setup commands run, or schedules activated.
This reads shared definitions for both OpenClaw and standalone Codex; it does not
check whether a runtime can execute them.

```ts
import { loadManifest } from '@tanaab/openclaw-agent-system/manifest';

const result = await loadManifest({
  workspaceDir: '/path/to/agent',
  // optional; relative to workspaceDir or absolute, bypassing discovery.
  // manifestPath: '.agent-system/agent.yaml',
});

if (result.status === 'loaded') {
  const { agent, debug, automations = [] } = result.manifest;
  for (const job of automations) {
    console.log(agent.id, debug, job.id, job.schedule, job.payload);
  }
} else {
  console.error(result.status, result.diagnostics);
}
```

`workspaceDir` is required. Without `manifestPath`, discovery prefers
`.agent-system/agent.yaml` over root `agent.yaml`. The selected file's sibling
`agent.local.yaml` overlay applies. An explicit missing file does not fall back
to workspace discovery.

The exported `LoadManifestResult` is a discriminated union:

| `status`    | Data                                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loaded`    | `manifest`, `path`, `scope.workspaceDir`, `digest`, `diagnostics`, `validationChecks`, and optional source/dependency metadata. `validationChecks` is empty: runtime readiness is not checked. |
| `unmanaged` | `scope` and empty `diagnostics`; no workspace manifest was found.                                                                                                                              |
| `invalid`   | `scope`, `diagnostics`, and the selected `path` when available; no usable manifest.                                                                                                            |

`manifest` uses normalized camelCase fields. Automation entries retain stable `id`,
`displayName`, `enabled`, `runtimes`, normalized `schedule`, optional model/effort and
other declared metadata. `payload` is either `{ kind: 'prompt', prompt: string }` or
a normalized command payload. Inline automations and `automations: { file: ./automations.yaml }`
use the same parser; prompt-file references resolve relative to their containing YAML.
References must remain within the workspace, including through symlinks.

Malformed declarations, invalid YAML, missing/unreadable files and unsafe references
return `invalid`, not an empty automation list. Diagnostics include `code`, `severity`,
`message`, and optional `fieldPath`/`sourcePath`; correct the definition or reference and retry.
Full manifest declaration validation still applies, but installed runtime readiness and
unresolved credential references do not gate loading. Unexpected programming errors can
reject the promise. `AgentManifest`, `ManifestDiagnostic`, `CodexEnvironmentSelector`, `ResolvedAutomation`,
`LoadManifestOptions` and `LoadManifestResult` types ship with this subpath.
The package root remains the plugin entrypoint; private source imports are unsupported.

## Command report output

Deterministic OpenClaw command automations reporting into a saved chat can opt into
a versioned JSON document. This format does not apply to ordinary agent replies,
issue/PR cards, prompt automations, or commands without a reporting chat.
Write one final object to stdout; send progress and diagnostics to stderr. Stdout
chunks, headings, bare arrays, concatenated objects, and NDJSON do not define cards.
Configure the saved chat through the [command automation guidance](./MANIFEST.md#automations).

The authoritative machine-readable schema ships at
[`agent/automations/automation-report.schema.json`](./agent/automations/automation-report.schema.json) in
`@tanaab/openclaw-agent-system`. It is generated from the same definition used for
validation. This is a data format, not a supported TypeScript module import.

### Envelope and card fields

| Field     | Type                    | Required | Description                                |
| --------- | ----------------------- | -------- | ------------------------------------------ |
| `schema`  | string                  | yes      | Exactly `agent-system.report`.             |
| `version` | integer                 | yes      | Exactly `1`.                               |
| `cards`   | nonempty array of cards | yes      | One or more cards in their intended order. |

Every card has a nonblank string `id`, unique by exact comparison within the document,
and a `format` of `structured` or `markdown`. IDs identify producer entries, not
separately posted native messages. Unknown fields are rejected on every owned object.

| Structured field | Type                                     | Required | Description                                          |
| ---------------- | ---------------------------------------- | -------- | ---------------------------------------------------- |
| `title`          | nonblank single-line string              | yes      | Card title, rendered in all caps as plain text.      |
| `status`         | `success`, `warning`, `error`, `unknown` | yes      | Producer's application outcome; see below.           |
| `summary`        | nonblank string                          | yes      | What happened and what it means, as plain text.      |
| `facts`          | array of `{label, value}` objects        | no       | Nonblank plain-text strings; labels are single-line. |
| `findings`       | array of nonblank strings                | no       | Evidence or observations.                            |
| `actions`        | array of nonblank strings                | no       | Suggested next actions, never executed by reporting. |

`success` reports the intended application outcome completed; `warning` reports a
degraded result or something needing attention; `error` reports a failed intended
outcome; `unknown` means the producer cannot establish it. These are producer claims,
not independent verification. Empty optional arrays produce no section.

A `markdown` card instead requires a nonblank string `body`. It cannot contain
`title`, `status`, `summary`, `facts`, `findings`, or `actions`; a structured card
cannot contain `body`. Selection is explicit, never inferred from the text.

### Presentation and examples

Structured entries use one standard Markdown card: a quoted status icon and title,
summary, then optional **Facts**, **Findings**, and **Suggested next actions** sections.
Plain-text values are escaped to prevent accidental Markdown structure.

```json
{
  "schema": "agent-system.report",
  "version": 1,
  "cards": [
    {
      "id": "archive",
      "format": "structured",
      "title": "Archive",
      "status": "warning",
      "summary": "Saved; activation remains unverified.",
      "facts": [{ "label": "Source", "value": "Already current" }],
      "actions": ["Review activation evidence."]
    }
  ]
}
```

Markdown entries bypass that template. Their body keeps its headings, whitespace,
lists, tables, links, fences, and existing quotations, except for privacy sanitation.
No extra title, summary, nested stdout excerpt, or outer blockquote is added. Include
your own blockquote if you want one.

```json
{
  "schema": "agent-system.report",
  "version": 1,
  "cards": [
    {
      "id": "activation",
      "format": "markdown",
      "body": "## ⚠️ Activation\n\nBuilt successfully; activation unverified."
    }
  ]
}
```

Include additional cards in the same array to show them in order. The runner appends
a footer with the process outcome and any capture warnings. A command can exit
successfully and still report an application warning or error.

### Fallback, validation, and limits

Other commands need no migration or output-format setting. Arbitrary JSON, raw
Markdown, plain/mixed text, and empty output receive best-effort model interpretation
into the **same standard Markdown card presentation** used by structured entries.
Fallback produces one card, not guessed multi-card boundaries. Raw Markdown outside
the preferred envelope is not guaranteed pass-through.

A document explicitly claiming `agent-system.report` must validate; invalid content
does not silently enter fallback. Reporting diagnostics include:

| Code                         | Meaning                                                  |
| ---------------------------- | -------------------------------------------------------- |
| `report-json-invalid`        | A recognized claim occurs in malformed JSON.             |
| `report-incomplete`          | The claimed document's capture is incomplete.            |
| `report-too-large`           | The complete stdout document exceeds 16 KiB.             |
| `report-version-unsupported` | The claimed version is unsupported.                      |
| `report-schema-invalid`      | Fields, variants, types, or required values are invalid. |
| `report-card-id-duplicate`   | Two cards have the same ID.                              |
| `report-content-invalid`     | Privacy sanitation leaves invalid or empty content.      |

Correct the producer output when a reporting diagnostic appears. Keep the complete
report within 16 KiB of stdout. Send diagnostics to stderr. Reports omit sensitive
content and indicate truncated output.

### Posting and recovery

Posting a report to a chat uses a model turn with the configured model and effort.
If delivery is uncertain, check the chat and [run history](./CLI.md#openclaw-agent-system-automations-runs)
before retrying the command. Command reporting is available in OpenClaw, including
OpenClaw-hosted Codex. Standalone Codex supports prompt automations only.
