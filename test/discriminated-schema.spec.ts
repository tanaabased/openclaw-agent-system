import assert from 'node:assert/strict';

import { Type } from 'typebox';
import { Compile } from 'typebox/compile';
import { Value } from 'typebox/value';

import discriminatedSchema from '../utils/discriminated-schema.ts';

describe('utils/discriminated-schema', () => {
  it('should preserve the union contract through compilation and json projection', () => {
    const original = Type.Union([
      Type.Object(
        {
          outcome: Type.Union([Type.Literal('ready'), Type.Literal('complete')]),
          plan: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        { outcome: Type.Literal('blocked'), questions: Type.Array(Type.String(), { minItems: 1 }) },
        { additionalProperties: false },
      ),
    ]);
    const selected = discriminatedSchema('outcome', original);
    const projected = JSON.parse(JSON.stringify(selected));
    const compiled = Compile(projected);
    for (const [value, valid] of [
      [{ outcome: 'ready', plan: 'A complete plan.' }, true],
      [{ outcome: 'complete', plan: 'A complete plan.' }, true],
      [{ outcome: 'blocked', questions: ['Which caller?'] }, true],
      [{ outcome: 'ready' }, false],
      [{ outcome: 'ready', plan: '' }, false],
      [{ outcome: 'ready', plan: 'A plan.', questions: ['Unrelated.'] }, false],
      [{ outcome: 'ready', plan: 'A plan.', authorized: true }, false],
      [{ outcome: 'blocked', questions: [] }, false],
      [{ outcome: 'unknown', plan: 'A plan.' }, false],
      [{ outcome: 1, plan: 'A plan.' }, false],
      [{ plan: 'A plan.' }, false],
      [null, false],
      [[], false],
      ['ready', false],
    ] as const) {
      assert.equal(Value.Check(original, value), valid);
      assert.equal(Value.Check(selected, value), valid);
      assert.equal(Value.Check(projected, value), valid);
      assert.equal(compiled.Check(value), valid);
    }
  });
});
