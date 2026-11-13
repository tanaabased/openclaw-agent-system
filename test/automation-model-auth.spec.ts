import assert from 'node:assert/strict';

import automationModels from '../agent/automations/automation-models.ts';
import automationModelAuth from '../agent/automations/automation-model-auth.ts';
import normalizeAutomations, { type ResolvedAutomation } from '../manifest/automation-schema.ts';

describe('agent/automation-model-auth', () => {
  it('should acquire unknown evidence only during reconciliation and leave unresolved readiness to the scheduler', async () => {
    const normalized = normalizeAutomations([
      { id: 'prompt', schedule: 'every 5 minutes', prompt: 'inspect' },
    ]);
    if (normalized.status !== 'valid') throw new Error('invalid fixture');
    const jobs = normalized.automations as ResolvedAutomation[];
    for (const mode of ['inspect', 'reconcile'] as const) {
      for (const availability of [undefined, true, false]) {
        for (const reason of ['missing-auth', 'auth-failed']) {
          const reads: Record<string, unknown>[] = [];
          const result = await automationModelAuth(
            async (_method, params) => {
              reads.push(params);
              return {
                models: [
                  {
                    provider: 'openai',
                    id: 'selected',
                    tags: ['default'],
                    available: params.refresh ? availability : undefined,
                    unavailableReason: params.refresh ? reason : undefined,
                  },
                ],
              };
            },
            'a',
            jobs,
            mode,
          );
          assert.deepEqual(
            [...result.keys()],
            mode === 'reconcile' && availability === false ? ['prompt'] : [],
          );
          assert.equal(reads.length, mode === 'inspect' ? 1 : 2);
          if (mode === 'reconcile')
            assert.deepEqual(reads[1], {
              agentId: 'a',
              view: 'all',
              includeDefaultModels: false,
              refresh: true,
            });
        }
      }
    }
    await assert.rejects(
      automationModelAuth(
        async (_method, params) => {
          if (params.refresh) throw new Error('catalog acquisition failed');
          return { models: [{ provider: 'openai', id: 'selected', tags: ['default'] }] };
        },
        'a',
        jobs,
        'reconcile',
      ),
      /catalog acquisition failed/,
    );
  });
  it('should preserve missing-auth separately from other definitive model unavailability', async () => {
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
        'reconcile',
      );
      assert.deepEqual([...result.keys()], ['prompt']);
      assert.equal(result.get('prompt'), reason ?? 'unavailable');
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
