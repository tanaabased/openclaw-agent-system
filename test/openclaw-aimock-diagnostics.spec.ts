import assert from 'node:assert/strict';

import diagnostics from '../scripts/aimock-diagnostics.ts';
import resolveScenario from '../scripts/example-model-scenarios.ts';

type Entry = Parameters<typeof diagnostics>[1][number];

describe('scripts/aimock-diagnostics', () => {
  it('should stay concise when the mock has no failures', () => {
    assert.deepEqual(diagnostics(resolveScenario('os-execution'), []), {
      scenario: 'os-execution',
      failed: false,
    });
  });

  it('should retain bounded owned failure results without prompts or unrelated tool output', () => {
    const scenario = resolveScenario('os-execution');
    const entry: Entry = {
      method: 'POST',
      path: '/responses',
      response: { fixture: null, status: 503 },
      body: {
        model: 'gpt-5.5',
        messages: [
          { role: 'system', content: 'private-system-prompt' },
          { role: 'user', content: 'private-user-prompt' },
          { role: 'tool', tool_call_id: 'unrelated', content: 'unrelated-private-result' },
          {
            role: 'tool',
            tool_call_id: 'call_os_execution_pipe_fc-123',
            content: 'x'.repeat(5000) + 'Command timed out.',
          },
        ],
      },
    };
    const original = structuredClone(entry);
    const result = diagnostics(
      scenario,
      Array.from({ length: 20 }, () => entry),
    );
    assert.equal(result.failed, true);
    assert.equal(result.requests?.length, 6);
    assert.equal(result.requests?.[0]?.results.length, 1);
    const content = result.requests?.[0]?.results[0]?.content;
    assert.equal(content?.length, 4096);
    assert.ok(content?.endsWith('Command timed out.'));
    assert.doesNotMatch(JSON.stringify(result), /private|prompt|unrelated/u);
    assert.deepEqual(entry, original);
  });

  it('should report evidence projection errors with the offending owned result', () => {
    const scenario = resolveScenario('openclaw-runtimes');
    const result = diagnostics(scenario, [
      {
        method: 'POST',
        path: '/responses',
        response: { fixture: {}, status: 200 },
        body: {
          tools: ['tool_search', 'tool_call'].map((name) => ({ function: { name } })),
          messages: [
            { role: 'tool', tool_call_id: 'call_aimock_discover_1', content: 'invalid catalog' },
            { role: 'tool', tool_call_id: 'call_runtime_install', content: 'owned denial result' },
          ],
        },
      },
    ]);
    assert.equal(result.failed, true);
    assert.ok(result.error);
    assert.equal(result.requests?.[0]?.results[0]?.content, 'owned denial result');
  });
});
