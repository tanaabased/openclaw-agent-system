import assert from 'node:assert/strict';

import codexWorkContext from '../agent/codex-work-context.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';

// Only the model-facing projection is under test; checkout and provider boundaries are injected.
describe('agent/codex-work-context', () => {
  it('should use current issue evidence and implementation guidance without replaying assessment guidance', async () => {
    const implementation = {
      version: 1 as const,
      requestedSkill: 'implementation',
      defaultSkill: false,
      observedAt: 2,
      skill: { name: 'implementation', path: '/skill', scope: 'user', digest: 'a'.repeat(64) },
      guidance: { source: 'inline' as const, content: 'CURRENT GUIDANCE', digest: 'b'.repeat(64) },
    };
    const record = {
      id: 'issue',
      worktree: '/checkout',
      context: JSON.stringify({ source: 'https://github.com/owner/repo/issues/3' }),
      assessment: {
        ...implementation,
        guidance: { ...implementation.guidance, content: 'OLD GUIDANCE' },
      },
      continuation: { scope: 'local' },
    } as DispatchRecord;
    const output = await codexWorkContext(
      record,
      {
        signal: new AbortController().signal,
        records: [record],
        current: {} as never,
        git: async () => {
          throw new Error('unexpected checkout mutation');
        },
        save: async () => {
          throw new Error('unexpected save');
        },
        deps: { now: () => 2 } as never,
      },
      {
        repo: { owner: { login: 'owner' }, name: 'repo' },
        admitted: { issue: { number: 3 } },
        selection: implementation,
        client: {
          getItemContext: async () => {
            throw new Error('unexpected issue prefetch');
          },
        },
      } as never,
      true,
    );
    assert.deepEqual(output.currentIssue, { source: 'https://github.com/owner/repo/issues/3' });
    assert.deepEqual(output.implementation, implementation);
    assert.equal('assessmentSelection' in output, false);
    assert.doesNotMatch(JSON.stringify(output), /OLD GUIDANCE/);
  });
});
