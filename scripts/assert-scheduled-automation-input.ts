import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { completeOpenClawMessage, openClawHistoryPages } from '../agent/openclaw-history.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';

interface ScheduledOccurrence {
  jobId: string;
  sessionKey: string;
  sessionId: string;
}

/** Check the visible history of the exact timer session, even if the host hides its input. */
export default async function assertScheduledAutomationInput(
  occurrence: ScheduledOccurrence,
  request: DispatchRequest,
  report: (evidence: unknown) => void,
) {
  assert.ok(occurrence.sessionKey && occurrence.sessionId && occurrence.jobId);
  const scope = { sessionKey: occurrence.sessionKey, sessionId: occurrence.sessionId };
  let pages = 0;
  let visibleMessages = 0;
  let leaks = 0;
  for await (const messages of openClawHistoryPages(request, scope)) {
    pages++;
    for (const message of messages) {
      visibleMessages++;
      const meta = message.__openclaw as { truncated?: boolean } | undefined;
      const { content } = meta?.truncated
        ? await completeOpenClawMessage(request, scope, message)
        : message;
      const visibleText =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((part) => part?.text ?? '').join('')
            : '';
      if (visibleText.includes('Task-update authorization:')) leaks++;
    }
  }
  report({ jobId: occurrence.jobId, sessionId: scope.sessionId, pages, visibleMessages, leaks });
  assert.equal(leaks, 0, 'the visible timer history exposes workflow instructions');
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
