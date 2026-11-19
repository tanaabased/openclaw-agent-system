import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { completeOpenClawMessage, openClawHistoryPages } from '../agent/openclaw-history.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';

interface ScheduledOccurrence {
  jobId: string;
  runId?: string;
  sessionKey: string;
  sessionId: string;
  runAtMs: number;
  durationMs: number;
}

/** inspect the exact timer occurrence, not whichever request remains in the latest display page. */
export default async function assertScheduledAutomationInput(
  occurrence: ScheduledOccurrence,
  request: DispatchRequest,
  report: (evidence: unknown) => void,
) {
  assert.ok(occurrence.sessionKey && occurrence.sessionId && occurrence.jobId);
  assert.ok(Number.isSafeInteger(occurrence.runAtMs) && occurrence.runAtMs > 0);
  assert.ok(Number.isSafeInteger(occurrence.durationMs) && occurrence.durationMs >= 0);
  const scope = { sessionKey: occurrence.sessionKey, sessionId: occurrence.sessionId };
  const candidates: Record<string, unknown>[] = [];
  const userInputs: { internal: boolean; cron: boolean; offsetMs: number | null }[] = [];
  let pages = 0;
  for await (const messages of openClawHistoryPages(request, scope)) {
    pages++;
    for (const message of messages) {
      const provenance = message.provenance as Record<string, unknown> | undefined;
      if (message.role === 'user' && userInputs.length < 12) {
        userInputs.push({
          internal: provenance?.kind === 'internal_system',
          cron: provenance?.sourceTool === 'cron',
          offsetMs:
            typeof message.timestamp === 'number' ? message.timestamp - occurrence.runAtMs : null,
        });
      }
      if (
        message.role === 'user' &&
        provenance?.kind === 'internal_system' &&
        provenance.sourceTool === 'cron' &&
        typeof message.timestamp === 'number' &&
        message.timestamp >= occurrence.runAtMs &&
        message.timestamp <= occurrence.runAtMs + occurrence.durationMs
      )
        candidates.push(await completeOpenClawMessage(request, scope, message));
    }
  }
  const texts = candidates.map((message) =>
    typeof message.content === 'string'
      ? message.content
      : (message.content as Array<{ type?: string; text?: string }>)
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n'),
  );
  const requestPresent = texts.length === 1 && texts[0]?.includes('Run scheduled automation:');
  const noWorkflowLeak =
    texts.length === 1 ? !texts[0]?.includes('Task-update authorization:') : null;
  report({
    jobId: occurrence.jobId,
    runId: occurrence.runId,
    sessionId: occurrence.sessionId,
    runAtMs: occurrence.runAtMs,
    durationMs: occurrence.durationMs,
    pages,
    candidates: candidates.length,
    ...(candidates.length !== 1 ? { userInputs } : {}),
    requestPresent,
    noWorkflowLeak,
    textLengths: texts.map((text) => text.length),
  });
  assert.equal(candidates.length, 1, 'expected one cron input for the retained timer occurrence');
  assert.equal(requestPresent, true, 'the exact timer input lacks the compact request');
  assert.equal(noWorkflowLeak, true, 'the exact timer input exposes workflow instructions');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions only.');
  const receiptPath = process.argv[2];
  assert.ok(receiptPath, 'the retained timer occurrence file is required');
  const occurrence = JSON.parse(readFileSync(receiptPath, 'utf8')) as ScheduledOccurrence;
  const { callGatewayFromCli } = await import('openclaw/plugin-sdk/gateway-runtime');
  const deadline = performance.now() + 180_000;
  await assertScheduledAutomationInput(
    occurrence,
    async (method, params) => {
      const remaining = Math.floor(deadline - performance.now());
      assert.ok(remaining > 0, 'timer input history observation deadline exhausted');
      return callGatewayFromCli(method, { json: true, timeout: String(remaining) }, params, {
        scopes: ['operator.read'],
        progress: false,
        sharedStateMode: 'read-only',
      });
    },
    (evidence) => process.stdout.write(JSON.stringify(evidence) + '\n'),
  );
}
