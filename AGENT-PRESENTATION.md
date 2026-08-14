# Agent Session Presentation

Agent System treats notification prompts and agent responses as user-facing
product surfaces. Each turn must remain compact and readable without weakening
the trust boundary between visible conversation, model-facing provider context,
private agent output, and explicitly authorized public publication.

## Surface boundaries

| Surface                         | Contract                                                                 |
| ------------------------------- | ------------------------------------------------------------------------ |
| Visible inbound message         | Compact Markdown containing the minimum safe context needed to act       |
| Current-turn structured context | Bounded untrusted provider data supplied to the model for that turn      |
| Private agent response          | Complete operator-facing Markdown retained in the OpenClaw session       |
| Public publication candidate    | Separately labeled, validated content that alone may enter a public path |

Current-turn structured context is not a synonym for secret or disposable
data. Supply it through OpenClaw's `UntrustedStructuredContext` boundary so the
model can use it without printing raw provider payloads in the visible message.
Under normal OpenClaw retention it remains available in the raw session
transcript, while sanitized chat display and later model-turn replay omit it.
Preserve a provider source link and stable identifiers so authorized consumers
can re-fetch the source when the transcript is unavailable, expired, truncated,
or no longer sufficient. Do not promise indefinite retention or preservation of
provider content after it is edited or deleted.

## Inbound turns

- Start with one descriptive Markdown heading and a modest, mode-relevant
  emoji.
- Identify the relevant provider target with a clickable link and include only
  the minimum safe actor, content, action, and mode needed to understand the
  turn.
- Keep detailed provider payloads, status evidence, revisions, local paths, and
  hidden metadata out of the visible message. Put bounded data needed by the
  current turn in untrusted structured context with provenance.
- End the visible request after its `Mode` line. Supply trusted turn-specific
  safety and response-format instructions through the per-run system prompt,
  not as additional chat copy or untrusted provider context.
- Treat provider titles, comments, and other external values as untrusted data
  even when they appear in links, quotations, or structured context.
- Keep the literal Markdown readable as plain text. Do not require HTML,
  accordions, attachments, or renderer-specific extensions.

Use assignment receipt and planning request presentation as the baseline, not
as a planning-only template. Shared helpers should own provider links, escaping,
and stable presentation semantics; each notification mode should supply its own
heading, requested action, mode, and response contract.

## Agent responses

- Use stable Markdown headings and lists when they improve scanning. Relevant
  emphasis, links, spacing, and modest emoji are welcome in private output.
- Keep the complete private response separate from every public publication
  candidate. A public adapter may extract only one explicitly labeled and
  validated candidate for its declared intent.
- Put the canonical public candidate after the private sections as a Markdown
  quote, so it is visually distinct while remaining readable in plaintext.
- Apply the public intent's own formatting and safety constraints. Never copy
  private sections, structured context, prohibited links, local paths, tool
  output, or hidden metadata merely to fill a public response.
- Preserve a readable plaintext fallback wherever a presentation path does not
  support the documented Markdown subset.

## Compatibility and extension

Existing plaintext response formats may remain accepted during a documented
transition, but mixed or ambiguous contracts must fail deterministically. New
planning, comment-response, work, automatic, or other modes should extend the
shared surface boundaries instead of duplicating provider-link, escaping,
context, or publication logic.

## Verification

- Test stable extraction, required-section, link, provenance, escaping, and
  public-isolation contracts exactly.
- For human-facing wording and ornamentation, assert semantic signal rather than
  complete message text unless exact wording is itself the public contract.
- Cover Markdown rendering and literal plaintext readability, visible message
  redaction, current-turn context availability, raw-transcript and sanitized
  history boundaries, compatibility behavior, and public publication isolation.
- Use executable OpenClaw examples when behavior crosses the installed plugin,
  channel, session, or Gateway boundary; keep those examples in GitHub Actions.
