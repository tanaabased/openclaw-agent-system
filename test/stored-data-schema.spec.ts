import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import storedDataSchema from '../core/stored-data-schema.ts';

describe('core/stored-data-schema', () => {
  it('should accept inert stored extensions without changing command or known-value contracts', () => {
    const command = Type.Object({ destination: Type.String() }, { additionalProperties: false });
    const receipt = Type.Object({ sent: Type.Boolean() }, { additionalProperties: false });
    const schema = Type.Object(
      {
        request: command,
        receipts: Type.Array(Type.Union([receipt, Type.Null()])),
      },
      { additionalProperties: false },
    );
    const stored = storedDataSchema(schema, ['request']);
    const value = {
      request: { destination: 'original' },
      receipts: [{ sent: true, unused: 'note' }, null],
      unused: { old: true },
    };
    assert.equal(Value.Check(stored, value), true);
    assert.equal(Value.Check(schema, value), false);
    assert.equal(Value.Check(stored, { ...value, receipts: [{ sent: 'yes' }] }), false);
    assert.equal(
      Value.Check(stored, { ...value, request: { destination: 'original', agentId: 'other' } }),
      false,
    );
    assert.equal(Value.Check(stored, { ...value, request: {} }), false);
    assert.equal(
      Value.Check(storedDataSchema(Type.Record(Type.String(), Type.Boolean())), { key: 'invalid' }),
      false,
    );
    const mapped = storedDataSchema(
      Type.Record(Type.String({ pattern: '^receipt-' }), receipt, { additionalProperties: false }),
    );
    assert.equal(Value.Check(mapped, { 'receipt-one': { sent: true, unused: 'note' } }), true);
    assert.equal(Value.Check(mapped, { 'receipt-one': { sent: 'invalid' } }), false);
    assert.equal(Value.Check(mapped, { foreign: { sent: true } }), false);
  });
});
