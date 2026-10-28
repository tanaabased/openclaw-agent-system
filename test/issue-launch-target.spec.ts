import assert from 'node:assert/strict';

import issueLaunchTarget from '../agent/issue-launch-target.ts';

describe('agent/issue-launch-target', () => {
  it('should resolve supported references to the same issue', () => {
    const expected = {
      repository: 'owner/repo',
      number: 3,
      url: 'https://github.com/owner/repo/issues/3',
    };
    assert.deepEqual(issueLaunchTarget('https://github.com/owner/repo/issues/3'), {
      ...expected,
      itemType: 'issue',
    });
    for (const input of ['owner/repo#3', 'owner/repo 3'])
      assert.deepEqual(issueLaunchTarget(input), expected);
    assert.deepEqual(issueLaunchTarget('#3', 'owner/repo'), expected);
  });
  it('should ask for absent repository context and reject conflicts and wrong kinds', () => {
    assert.equal(issueLaunchTarget('3'), undefined);
    assert.throws(() => issueLaunchTarget('owner/repo#3', 'another/repo'), /repository-conflict/);
    assert.deepEqual(issueLaunchTarget('https://github.com/owner/repo/pull/3'), {
      repository: 'owner/repo',
      number: 3,
      itemType: 'pull-request',
      url: 'https://github.com/owner/repo/pull/3',
    });
    assert.throws(() => issueLaunchTarget('https://github.com/owner/repo/pull/3#discussion_r123'));
    assert.throws(() => issueLaunchTarget('owner/repo#9007199254740992'), /number-invalid/);
  });
});
