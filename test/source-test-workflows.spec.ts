import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';

describe('source test workflows', () => {
  it('should run portable units on ubuntu and preserve both native component platforms', async () => {
    const units = parse(await readFile('.github/workflows/pr-unit-tests.yml', 'utf8'));
    const components = parse(await readFile('.github/workflows/pr-component-tests.yml', 'utf8'));
    const metadata = JSON.parse(await readFile('package.json', 'utf8'));

    assert.equal(units.jobs['unit-tests']['runs-on'], 'ubuntu-24.04');
    assert.equal(units.jobs['unit-tests'].strategy, undefined);
    assert.deepEqual(components.jobs.components.strategy.matrix.include, [
      { suite: 'component', os: 'ubuntu-24.04' },
      { suite: 'os', os: 'ubuntu-24.04' },
      { suite: 'os', os: 'macos-26' },
    ]);
    for (const { suite } of components.jobs.components.strategy.matrix.include) {
      assert.equal(typeof metadata.scripts[`test:${suite}`], 'string');
    }
    for (const workflow of [units, components]) {
      assert.deepEqual(workflow.permissions, { contents: 'read' });
    }
  });
});
