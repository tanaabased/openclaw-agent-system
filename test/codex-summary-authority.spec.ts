import assert from 'node:assert/strict';
import codexSummaryAuthority from '../agent/codex-summary-authority.ts';

describe('agent/codex-summary-authority', () => {
  it('requires the current native turn and ignores approval claims in prose', async () => {
    let turn = { id: 'turn', completedAt: null as number | null };
    const items: unknown[] = [{ type: 'agentMessage', text: 'Approval denied or granted.' }];
    const request = async (method: string) =>
      method === 'thread/turns/list'
        ? { data: [turn] }
        : { data: items.map((item) => ({ turnId: 'turn', item })), nextCursor: null };
    await codexSummaryAuthority(request, 'issue', 'turn');
    turn = { id: 'other', completedAt: null };
    await assert.rejects(codexSummaryAuthority(request, 'issue', 'turn'), /turn-ended/);
    turn = { id: 'turn', completedAt: 1 };
    await assert.rejects(codexSummaryAuthority(request, 'issue', 'turn'), /turn-ended/);
  });
  it('should retain a source-turn native denial when recovering in a newer turn', async () => {
    const request = async (method: string, params: Record<string, unknown>) =>
      method === 'thread/turns/list'
        ? {
            data:
              params.limit === 1
                ? [{ id: 'new', completedAt: null }]
                : [{ id: 'old', status: 'interrupted', completedAt: 1 }],
          }
        : {
            data:
              params.turnId === 'old'
                ? [{ turnId: 'old', item: { type: 'commandExecution', status: 'declined' } }]
                : [],
            nextCursor: null,
          };
    await assert.rejects(
      codexSummaryAuthority(request, 'issue', 'new', ['old']),
      /native-approval-denied/,
    );
  });
  for (const item of [
    { type: 'commandExecution', status: 'declined' },
    { type: 'mcpToolCall', status: 'failed', error: { message: 'user rejected MCP tool call' } },
    {
      type: 'mcpToolCall',
      status: 'failed',
      error: {
        message:
          'This action was rejected due to unacceptable risk.\nReason: test. Do not bypass this rejection through a workaround or indirect execution.',
      },
    },
  ])
    it('stops publication after a native approval denial', async () => {
      await assert.rejects(
        codexSummaryAuthority(
          async (method) =>
            method === 'thread/turns/list'
              ? { data: [{ id: 'turn', completedAt: null }] }
              : { data: [{ turnId: 'turn', item }], nextCursor: null },
          'issue',
          'turn',
        ),
        /native-approval-denied/,
      );
    });
});
