import assert from 'node:assert/strict';

import assertScheduledAutomationInput from '../scripts/assert-scheduled-automation-input.ts';

const occurrence = {
  jobId: 'job',
  sessionKey: 'coordinator',
  sessionId: 'incarnation',
  runAtMs: 1000,
  durationMs: 100,
};
const input = {
  role: 'user',
  timestamp: 1050,
  provenance: { kind: 'internal_system', sourceTool: 'cron' },
  content: '> Run scheduled automation: 📥 ISSUE ASSIGNMENTS.',
  __openclaw: { id: 'input' },
};

describe('scripts/assert-scheduled-automation-input', () => {
  it('should follow native history cursors past a full display page to the exact timer input', async () => {
    const evidence: unknown[] = [];
    await assertScheduledAutomationInput(
      occurrence,
      async (_method, params) => ({
        sessionId: occurrence.sessionId,
        messages: params.cursor
          ? [{ ...input, content: [{ type: 'text', text: input.content }] }]
          : Array.from({ length: 20 }, () => ({ role: 'assistant', content: 'tool work' })),
        ...(params.cursor ? {} : { olderCursor: 'older' }),
      }),
      (value) => evidence.push(value),
    );
    assert.ok(evidence.some((value) => (value as { pages: number }).pages === 2));
  });

  it('should not substitute an older compact request or a copied human input', async () => {
    let evidence: unknown;
    await assert.rejects(
      assertScheduledAutomationInput(
        occurrence,
        async () => ({
          sessionId: occurrence.sessionId,
          messages: [
            { ...input, timestamp: 999 },
            { ...input, timestamp: 1101 },
            { ...input, provenance: undefined },
          ],
        }),
        (value) => (evidence = value),
      ),
      /expected one cron input/,
    );
    assert.equal((evidence as { requestPresent: boolean }).requestPresent, false);
  });

  it('should distinguish missing compact text from leaked workflow instructions', async () => {
    for (const [content, present, clean] of [
      ['wrong request', false, true],
      [input.content + '\nTask-update authorization: full workflow', true, false],
    ] as const) {
      let evidence: unknown;
      await assert.rejects(
        assertScheduledAutomationInput(
          occurrence,
          async () => ({ sessionId: occurrence.sessionId, messages: [{ ...input, content }] }),
          (value) => (evidence = value),
        ),
      );
      assert.equal((evidence as { requestPresent: boolean }).requestPresent, present);
      assert.equal((evidence as { noWorkflowLeak: boolean }).noWorkflowLeak, clean);
    }
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

  it('should reject ambiguous occurrences and changed transcript identity', async () => {
    await assert.rejects(
      assertScheduledAutomationInput(
        occurrence,
        async () => ({ sessionId: occurrence.sessionId, messages: [input, input] }),
        () => {},
      ),
      /expected one cron input/,
    );
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
