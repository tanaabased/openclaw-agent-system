import assert from 'node:assert/strict';

import assertScheduledAutomationInput from '../scripts/assert-scheduled-automation-input.ts';

const occurrence = {
  jobId: 'job',
  sessionKey: 'coordinator',
  sessionId: 'incarnation',
};
const input = {
  role: 'user',
  timestamp: 1050,
  provenance: { kind: 'internal_system', sourceTool: 'cron' },
  content: '> Run scheduled automation: 📥 ISSUE ASSIGNMENTS.',
  __openclaw: { id: 'input' },
};

describe('scripts/assert-scheduled-automation-input', () => {
  it('should follow native history cursors through the exact session even when the timer input is hidden', async () => {
    const evidence: unknown[] = [];
    await assertScheduledAutomationInput(
      occurrence,
      async (_method, params) => ({
        sessionId: occurrence.sessionId,
        messages: params.cursor
          ? [{ role: 'assistant', content: 'finished' }]
          : Array.from({ length: 20 }, () => ({ role: 'assistant', content: 'tool work' })),
        ...(params.cursor ? {} : { olderCursor: 'older' }),
      }),
      (value) => evidence.push(value),
    );
    assert.ok(evidence.some((value) => (value as { pages: number }).pages === 2));
  });

  it('should reject instructions leaked by an assistant on an older page', async () => {
    await assert.rejects(
      assertScheduledAutomationInput(
        occurrence,
        async (_method, params) => ({
          sessionId: occurrence.sessionId,
          messages: params.cursor
            ? [{ role: 'assistant', content: 'Task-update authorization: private' }]
            : [{ role: 'assistant', content: 'clean' }],
          ...(params.cursor ? {} : { olderCursor: 'older' }),
        }),
        () => {},
      ),
      /exposes workflow instructions/,
    );
  });

  it('should hydrate a truncated timer input before asserting that no instructions leaked', async () => {
    await assert.rejects(
      assertScheduledAutomationInput(
        occurrence,
        async (method) =>
          method === 'chat.message.get'
            ? {
                ok: true,
                message: { ...input, content: input.content + '\nTask-update authorization:' },
              }
            : {
                sessionId: occurrence.sessionId,
                messages: [{ ...input, __openclaw: { ...input.__openclaw, truncated: true } }],
              },
        () => {},
      ),
      /exposes workflow instructions/,
    );
  });

  it('should reject a changed transcript identity', async () => {
    await assert.rejects(
      assertScheduledAutomationInput(
        occurrence,
        async () => ({ sessionId: 'replacement', messages: [input] }),
        () => {},
      ),
      /workflow-evidence-conflicting/,
    );
  });
});
