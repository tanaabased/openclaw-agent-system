import { getChildLogger } from 'openclaw/plugin-sdk/logging-core';

/** opt-in ci evidence; callers supply categories and counts, never payloads or errors. */
export default function automationCompatibilityDiagnostic(
  event: string,
  evidence: Record<string, unknown>,
) {
  if (process.env.CI !== 'true' || process.env.OPENCLAW_DEBUG !== '1') return;
  try {
    getChildLogger({ subsystem: 'agent-system/automation-compatibility' }).info({
      event,
      ...evidence,
    });
  } catch {
    // optional diagnostics must never replace the operation's result or failure.
  }
}
