import assert from 'node:assert/strict';
import deliverTaskInput from '../agent/task-input-delivery.ts';

describe('agent/task-input-delivery', () => {
  it('should retain exact input before a lost send and reconcile without preparing or sending again', async () => {
    let retained: { message: string } | undefined;
    let durable: typeof retained;
    let sends = 0;
    const input = {
      attempt: retained,
      prepare: async () => ({ message: 'exact admitted input' }),
      retain: (attempt: NonNullable<typeof retained>) => {
        retained = attempt;
      },
      save: async () => {
        durable = retained;
      },
      assertCurrent: async () => {},
      send: async (attempt: NonNullable<typeof retained>) => {
        assert.equal(durable, attempt);
        sends++;
        throw new Error('response lost');
      },
      reconcile: async () => ({ status: 'delivered' as const }),
    };
    await assert.rejects(deliverTaskInput(input), /response lost/);
    const unavailable = async (): Promise<never> => {
      throw new Error('source unavailable');
    };
    assert.deepEqual(
      await deliverTaskInput({
        ...input,
        attempt: durable,
        prepare: unavailable,
        assertCurrent: unavailable,
      }),
      { status: 'delivered' },
    );
    assert.equal(sends, 1);
  });

  for (const failure of ['save', 'authority'] as const) {
    it(`should not send when ${failure} fails after preparation`, async () => {
      let checks = 0;
      let sends = 0;
      let retained: string | undefined;
      await assert.rejects(
        deliverTaskInput({
          attempt: undefined,
          prepare: async () => 'exact input',
          retain: (attempt) => {
            retained = attempt;
          },
          assertCurrent: async () => {
            if (++checks === 2 && failure === 'authority') throw new Error('revoked');
          },
          save: async () => {
            if (failure === 'save') throw new Error('disk full');
          },
          send: async () => {
            sends++;
          },
        }),
        /revoked|disk full/,
      );
      assert.equal(retained, 'exact input');
      assert.equal(sends, 0);
    });
  }

  it('should retain a native handoff without claiming delivery or replacing an existing attempt', async () => {
    const request = { threadId: 'owner', prompt: 'exact input' };
    let retained: typeof request | undefined;
    let saves = 0;
    const input = {
      attempt: retained,
      prepare: async () => request,
      retain: (attempt: typeof request) => {
        retained = attempt;
      },
      assertCurrent: async () => {},
      save: async () => {
        saves++;
      },
    };
    assert.deepEqual(await deliverTaskInput(input), { status: 'pending' });
    assert.equal(retained, request);
    assert.deepEqual(
      await deliverTaskInput({
        ...input,
        attempt: retained,
        prepare: async () => {
          throw new Error('must reconcile original');
        },
      }),
      { status: 'pending' },
    );
    assert.equal(saves, 1);
  });
});
