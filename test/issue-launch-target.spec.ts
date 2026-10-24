import assert from 'node:assert/strict';

import issueLaunchTarget from '../agent/issue-launch-target.ts';

describe('agent/issue-launch-target', () => {
  it('should resolve supported references to the same issue', () => {
    const expected = {
      repository: 'owner/repo',
      number: 3,
      url: 'https://github.com/owner/repo/issues/3',
    };
    for (const input of ['https://github.com/owner/repo/issues/3', 'owner/repo#3', 'owner/repo 3'])
      assert.deepEqual(issueLaunchTarget(input), expected);
    assert.deepEqual(issueLaunchTarget('#3', 'owner/repo'), expected);
  });
  it('should ask for absent repository context and reject conflicts and wrong kinds', () => {
    assert.equal(issueLaunchTarget('3'), undefined);
    assert.throws(() => issueLaunchTarget('owner/repo#3', 'another/repo'), /repository-conflict/);
    assert.throws(
      () => issueLaunchTarget('https://github.com/owner/repo/pull/3'),
      /issue-required/,
    );
    assert.throws(() => issueLaunchTarget('owner/repo#9007199254740992'), /number-invalid/);
  });
});
