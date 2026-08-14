import assert from 'node:assert/strict';
import { join } from 'node:path';

import isPathContained from '../utils/is-path-contained.ts';

describe('utils/is-path-contained', () => {
  it('should admit the root and its descendants', () => {
    const root = join('/workspace', 'agent');

    assert.equal(isPathContained(root, root), true);
    assert.equal(isPathContained(root, join(root, 'project')), true);
    assert.equal(isPathContained(root, join(root, '..cache')), true);
  });

  it('should reject parents and similarly prefixed siblings', () => {
    const root = join('/workspace', 'agent');

    assert.equal(isPathContained(root, join(root, '..')), false);
    assert.equal(isPathContained(root, join('/workspace', 'agent-other')), false);
  });
});
