# API reference

Use [Command report output](#command-report-output) to produce automation reports.
The separate [Tool API](#tool-api) below remains planned, not available.

## Tool API

This guide describes the planned public Tool API for OpenClaw plugins that want to add
tools compatible with [Agent System](./README.md).

> [!IMPORTANT]
> The public Tool API is not available in the current release. Agent System's
> first-party tools use an internal contract while a supported typed
> cross-plugin registration and runtime boundary is designed with OpenClaw.

The repository's `api/` directory contains the internal contract and runtime used by
Agent System's own tools. These modules ship for the plugin entrypoint; they are not
declared package exports and do not support third-party imports.

### Goal

The public API will let another OpenClaw plugin register a compatible tool
without reproducing Agent System's agent binding, environment and credential
resolution, policy enforcement, execution safety, redaction, auditing, or
diagnostics.

Agent System will own:

- trusted binding between a tool call and an installed agent workspace
- operation-policy sequencing
- scoped environment and credential resolution
- safe execution, redaction, auditing, and common diagnostics

Each compatible tool will own:

- a stable tool id, model-input schema, and optional manifest schema
- command or API behavior and operation classification
- configuration projection and supplemental redaction
- lifecycle checks and focused user guidance when the capability needs them

### Policy Boundary

A compatible request will follow one shared sequence:

1. bind the request to a trusted agent workspace
2. validate and classify the requested operation
3. apply the configured `allow` or `deny` policy
4. resolve only the credentials and resources needed for the authorized operation
5. execute, redact, audit, and dispose of temporary material

Compatible tools will not receive a general raw-secret interface. Tool schemas
and implementations will be statically supplied by installed plugin code,
never loaded from a workspace manifest.

### Planned Tool Integration Contract

The eventual versioned contract is expected to cover:

| Surface                  | Purpose                                                     |
| ------------------------ | ----------------------------------------------------------- |
| API version              | Declare compatibility with the Agent System Tool API.       |
| Configuration projection | Validate and resolve the tool's manifest section.           |
| Lifecycle contributions  | Add optional validation, doctor, and install behavior.      |
| Runtime handle           | Request authorized execution and narrowly scoped resources. |
| Tool definitions         | Supply static model schemas and operation behavior.         |
| Tool id                  | Give the tool a stable diagnostic and ownership key.        |

No supported public import or registration call exists yet.

### Security Requirements

A public tool integration must preserve these boundaries:

- policy enforcement happens before credential resolution
- tool input cannot select executable code, schemas, or modules
- secrets never enter model input, provenance, logs, diagnostics, or errors
- temporary credentials have the smallest practical action scope and lifetime
- remote-service permissions remain the final authorization boundary

### First-Party References

The current [`git`](./tools/git/README.md) and
[`gh`](./tools/github/README.md) wrappers exercise the internal contract. Their
guides document tool-specific configuration, policy, invocation, lifecycle, and
security behavior without defining the future public registration API.

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
| `title`          | nonblank single-line string              | yes      | Card title, rendered as plain text.                  |
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

For multiple cards, use the same envelope. Entries can mix both formats:

```json
{
  "schema": "agent-system.report",
  "version": 1,
  "cards": [
    {
      "id": "a",
      "format": "structured",
      "title": "Source A",
      "status": "success",
      "summary": "Already current."
    },
    {
      "id": "b",
      "format": "markdown",
      "body": "## Source B\n\n- Saved archive\n- Activation unverified"
    }
  ]
}
```

Cards are joined with two newline characters, preserving any newlines in authored
bodies. They appear in one final assistant response, not separate native sends.
There is no extra summary card. One labelled **Runner result** footer follows the
whole sequence, outside the card bodies, with the automation, run time/duration,
execution identity, process outcome, capture notices, and bounded stderr diagnostics.

Runner outcome and application claims remain separate. Exit zero does not hide an
application warning. A failed, timed-out, cancelled, signalled, or unknown runner
result remains visible in that footer without rewriting completed individual claims.
Stderr can be ordinary progress; its presence alone is not failure.

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

Unknown fields, empty IDs, and contradictory formats are invalid. Correct the producer
output when a reporting diagnostic appears; a diagnostic is not application success.
Only actual top-level schema properties establish a claim, not words inside logs or
nested data. An unrecognized malformed document remains fallback with capture notices.
Captured prefixes are never treated as complete reports.

The complete preferred stdout document must fit the existing 16 KiB per-stream chat
disclosure boundary. Oversized/incomplete claimed stdout yields a diagnostic, not a
partial card batch. Complete stdout can still produce cards when stderr is truncated;
the footer discloses that loss. Terminal/bidi control characters are removed and
credential-like content is redacted or withheld before reaching the posting model.
Sanitation can change or withhold an entire Markdown body or structured field.

The existing atomic private record limit is 256 KiB, checked before posting. Request
validation and host transport limits still apply; Agent System does not increase them
or silently split a report to fit. Full permitted capture remains in native run history.

### Posting and recovery

Preferred card construction needs no model interpretation, but **posting still uses
the existing model-assisted turn**, with the configured model/effort, cost, and latency.
The model must copy the prepared response unchanged. Validation checks exact preferred
text and permits one bounded correction; nonconforming final output is a reporting
failure. This does not guarantee that the model never emits altered text or that an
invalid response cannot already be present in native history.

The existing execution identity and one native response receipt cover the entire
report. A pending or uncertain attempt is reconciled without blindly resending cards,
launching another formatter, or rerunning the command. There are no separate per-card
acknowledgments or partial-prefix retries, and no exactly-once guarantee. Missing,
archived, or replaced destinations retain the existing delivery failure behavior.

This narrow command-reporting path works with either the native OpenClaw harness or
the Codex harness hosted inside OpenClaw, using existing permissions. Standalone Codex command jobs remain unsupported; its native prompt
automations are unchanged. See [runtime automation support](./MANIFEST.md#automations).
