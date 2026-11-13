import assert from 'node:assert/strict';

import automationModels from '../agent/automations/automation-models.ts';
import automationModelAuth from '../agent/automations/automation-model-auth.ts';
import normalizeAutomations, { type ResolvedAutomation } from '../manifest/automation-schema.ts';

describe('agent/automation-model-auth', () => {
  it('should require explicit native missing-auth evidence for the selected model', async () => {
    const normalized = normalizeAutomations([
      { id: 'prompt', schedule: 'every 5 minutes', prompt: 'inspect', model: 'openai/selected' },
      { id: 'command', schedule: 'every 5 minutes', run: ['echo', 'ok'] },
    ]);
    assert.equal(normalized.status, 'valid');
    if (normalized.status !== 'valid') throw new Error('invalid fixture');
    const jobs = automationModels(
      normalized.automations as ResolvedAutomation[],
      undefined,
      'openclaw',
    );
    for (const reason of ['missing-auth', 'auth-failed', 'cooldown', undefined]) {
      const result = await automationModelAuth(
        async (method, params) => {
          assert.equal(method, 'models.list');
          assert.deepEqual(params, {
            agentId: 'a',
            view: 'all',
            preparedOnly: true,
            includeDefaultModels: false,
          });
          return {
            models: [
              { provider: 'openai', id: 'other', available: true },
              { provider: 'openai', id: 'selected', available: false, unavailableReason: reason },
            ],
          };
        },
        'a',
        jobs,
      );
      assert.deepEqual([...result], reason === 'missing-auth' ? ['prompt'] : []);
    }
    assert.deepEqual([...(await automationModelAuth(async () => ({ models: [] }), 'a', jobs))], []);
    await assert.rejects(
      automationModelAuth(async () => ({}), 'a', jobs),
      { code: 'automation-model-evidence-unavailable' },
    );
    await automationModelAuth(
      async () => assert.fail('commands must not inspect model authentication'),
      'a',
      jobs.filter(({ id }) => id === 'command'),
    );
  });
});
