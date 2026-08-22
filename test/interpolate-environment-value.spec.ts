import assert from 'node:assert/strict';

import interpolateEnvironmentValue from '../environment/interpolate.ts';

describe('environment/interpolate', () => {
  it('should resolve bare and braced uppercase references in one pass', () => {
    assert.deepEqual(
      interpolateEnvironmentValue(
        '$AGENT_NAME:${AGENT_EMAIL}:$AGENT_NAME_SUFFIX:${AGENT_NAME}_bot',
        {
          AGENT_EMAIL: 'data@example.com',
          AGENT_NAME: 'Data',
          AGENT_NAME_SUFFIX: 'android',
        },
      ),
      {
        missing: [],
        references: ['AGENT_NAME', 'AGENT_EMAIL', 'AGENT_NAME_SUFFIX'],
        value: 'Data:data@example.com:android:Data_bot',
      },
    );
  });

  it('should preserve escaped dollars and report missing references without values', () => {
    assert.deepEqual(interpolateEnvironmentValue('$$HOME:$MISSING:${ALSO_MISSING}', {}), {
      missing: ['MISSING', 'ALSO_MISSING'],
      references: ['MISSING', 'ALSO_MISSING'],
      value: '$HOME:$MISSING:${ALSO_MISSING}',
    });
  });
});
