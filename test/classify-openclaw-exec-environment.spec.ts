import assert from 'node:assert/strict';

import classifyOpenClawExecEnvironment from '../utils/classify-openclaw-exec-environment.ts';

describe('utils/classify-openclaw-exec-environment', () => {
  it('should identify documented protected names and prefixes', () => {
    assert.equal(classifyOpenClawExecEnvironment('GITHUB_TOKEN'), 'documented-filtered');
    assert.equal(classifyOpenClawExecEnvironment('path'), 'documented-filtered');
    assert.equal(classifyOpenClawExecEnvironment('DYLD_INSERT_LIBRARIES'), 'documented-filtered');
  });

  it('should call other names candidates rather than claiming runtime acceptance', () => {
    assert.equal(classifyOpenClawExecEnvironment('AGENT_COLOR'), 'exec-candidate');
  });
});
