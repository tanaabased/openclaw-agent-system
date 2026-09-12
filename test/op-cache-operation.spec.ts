import assert from 'node:assert/strict';

import AgentSystemToolRuntime from '../api/runtime.ts';
import AgentSystemToolError from '../api/error.ts';
import AgentEnvironmentService from '../environment/service.ts';
import OpEnvironmentService from '../environment/op-service.ts';
import { createSemanticToolTestDefinition, loadedToolTestManifest } from './tool-test-fixture.ts';

describe('environment/op-cache operations', () => {
  it('should preserve fresh local configuration and authorization around cached provider values', async () => {
    let local = 'first';
    let credentials = 0;
    let reads = 0;
    let deny = false;
    let reject = false;
    const manifest = loadedToolTestManifest({
      schemaVersion: 1,
      agent: { id: 'data' },
      environment: { dotenv: ['.env'], set: { CURRENT: '$LOCAL' }, op: ['private-env'] },
    });
    const manifestService = {
      async loadForAgentId() {
        return manifest;
      },
      async loadForCommandDirectory() {
        return manifest;
      },
      async loadForWorkspace() {
        return manifest;
      },
    };
    const op = new OpEnvironmentService({
      integrationVersion: 'test',
      credentialService: {
        async resolveServiceAccountToken() {
          credentials += 1;
          return { status: 'resolved', token: 'private', source: { id: 'file', type: 'store' } };
        },
      },
      async createClient() {
        return {
          async resolveSecret() {
            throw new Error('not expected');
          },
          async getVariables() {
            reads += 1;
            return { variables: [{ name: 'KEY', masked: true, value: 'private-value' }] };
          },
        };
      },
    });
    const environmentService = new AgentEnvironmentService({
      manifestService,
      opEnvironmentService: op,
      hostEnvironment: {},
      logger: { info() {}, error() {} },
      async loadDotenv() {
        return {
          status: 'loaded',
          sources: [{ source: 'environment.dotenv[0]', values: { LOCAL: local } }],
        };
      },
    });
    const runtime = new AgentSystemToolRuntime({
      manifestService,
      environmentService,
      baseEnvironment: {},
      logger: { info() {}, error() {} },
      runCli: async () => {
        throw new Error('not expected');
      },
    });
    const definition = createSemanticToolTestDefinition({
      authorize: () => (deny ? { status: 'denied', reason: 'denied' } : { status: 'allowed' }),
      async execute() {
        if (reject)
          throw new AgentSystemToolError('execution_failed', 'Credential rejected.', true);
        return 'ok';
      },
    });
    const run = () =>
      runtime.executeSemantic(
        definition,
        { argument: 'status' },
        { agentId: 'data', source: 'command' },
      );
    await run();
    const first = await environmentService.loadForAgentId('data');
    local = 'second';
    const second = await environmentService.loadForAgentId('data');
    assert.equal(first.status, 'loaded');
    assert.equal(second.status, 'loaded');
    if (first.status !== 'loaded' || second.status !== 'loaded') return;
    assert.equal(first.environment.values.CURRENT, 'first');
    assert.equal(second.environment.values.CURRENT, 'second');
    assert.equal(Object.isFrozen(first.environment.values), true);
    assert.equal(reads, 1);
    deny = true;
    const before = credentials;
    await assert.rejects(run, /denied/);
    assert.equal(credentials, before);
    assert.equal(reads, 1);
    deny = false;
    reject = true;
    await assert.rejects(run, /Credential rejected/);
    assert.equal(op.status().entries.length, 0);
    reject = false;
    await run();
    assert.equal(reads, 2);
    manifest.manifest.environment!.op = [];
    await environmentService.loadForAgentId('data');
    assert.equal(op.status().entries.length, 0);
  });
});
