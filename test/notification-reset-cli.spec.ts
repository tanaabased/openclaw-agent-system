import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import reset, { type ResetNotificationsOptions } from '../channels/github/cli/reset.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import type { NotificationResetPreview } from '../agent/notification-reset.ts';

describe('channels/github/cli/reset', () => {
  function fixture() {
    const calls: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    let code = 0;
    const loaded = (id: string): AgentManifestLoadResult => ({
      status: 'loaded',
      scope: { workspaceDir: `/workspace/${id}` },
      path: `/workspace/${id}/agent.yaml`,
      digest: 'manifest',
      manifest: { schemaVersion: 1, agent: { id } },
      diagnostics: [],
      validationChecks: [],
    });
    const preview = (id: string): NotificationResetPreview => ({
      runtime: 'openclaw',
      agentId: id,
      workspace: `/workspace/${id}`,
      scope: 'a'.repeat(64),
      automation: '{}',
      inventory: '{}',
      resources: [],
      purge: false,
      continuing: true,
      operationId: 'operation',
      fingerprint: 'snapshot',
    });
    const options: ResetNotificationsOptions = {
      agents: ['one', 'two'],
      all: false,
      yes: true,
      purge: false,
      json: true,
      workspaceDir: '/workspace',
      environment: {},
      input: new Readable({ read() {} }),
      listAgents: async () => ['one', 'two'],
      manifestService: {
        loadForAgentId: async (id) => loaded(id),
        loadForCommandDirectory: async () => loaded('one'),
      },
      service: {
        preview: async (manifest, _workspace, purge, fresh) => {
          calls.push(`preview:${manifest.agent.id}`);
          return { ...preview(manifest.agent.id), purge, fresh };
        },
        run: async (manifest) => {
          calls.push(`run:${manifest.agent.id}`);
          return {
            status: 'complete',
            operationId: 'operation',
            agentId: manifest.agent.id,
            workspace: `/workspace/${manifest.agent.id}`,
            resources: [],
            automationRestored: true,
          };
        },
      },
      output: {
        writeStdout: (text) => stdout.push(text),
        writeStderr: (text) => stderr.push(text),
      },
      setExitCode: (value) => {
        code = value;
      },
    };
    return { options, calls, stdout, stderr, code: () => code };
  }
  it('should require explicit scope and yes for unattended execution before any effect', async () => {
    for (const change of [{ agents: [] }, { yes: false }, { all: true }]) {
      const f = fixture();
      await assert.rejects(reset({ ...f.options, ...change }), /notification-reset-/u);
      assert.deepEqual(f.calls, []);
    }
  });

  it('should preview explicit targets without prompting or running reset and reject changed confirmation', async () => {
    const f = fixture();
    f.options.preview = true;
    f.options.yes = false;
    await reset(f.options);
    assert.deepEqual(f.calls, ['preview:one', 'preview:two']);
    const result = JSON.parse(f.stdout.join(''));
    assert.equal(result.status, 'confirmation-required');
    assert.equal(result.targets.length, 2);
    const original = f.options.service.preview;
    f.options.service.preview = async (...args) => ({
      ...(await original(...args)),
      continuing: false,
      fingerprint: 'changed',
    });
    f.options.preview = false;
    f.options.yes = true;
    f.options.confirmation = result.confirmation;
    await assert.rejects(reset(f.options), /notification-reset-preview-changed/u);
    assert.ok(f.calls.every((call) => call.startsWith('preview:')));
  });

  it('should return an empty structured result when there are no managed agents', async () => {
    const f = fixture();
    f.options.all = true;
    f.options.agents = [];
    f.options.listAgents = async () => [];
    await reset(f.options);
    assert.deepEqual(JSON.parse(f.stdout.join('')), { results: [] });
    assert.deepEqual(f.calls, []);
  });
  it('should offer fresh recovery interactively and pass the selected preview to execution', async () => {
    const f = fixture();
    f.options.json = false;
    f.options.yes = false;
    f.options.input = Object.assign(new Readable({ read() {} }), { isTTY: true });
    let confirmations = 0;
    f.options.prompt = {
      multiselect: async (input) =>
        input.options.filter(({ value }) => value === 'one').map(({ value }) => value),
      confirm: async () => ++confirmations !== 1,
    };
    const run = f.options.service.run;
    f.options.service.run = async (...args) => {
      assert.equal(args[2].fresh, true);
      return run(...args);
    };
    await reset(f.options);
    assert.equal(confirmations, 2);
    assert.deepEqual(f.calls, ['preview:one', 'preview:one', 'run:one']);
  });
  it('should reset selected agents independently and preserve machine-readable failures', async () => {
    const f = fixture();
    f.options.service.run = async (manifest) => {
      f.calls.push(`run:${manifest.agent.id}`);
      if (manifest.agent.id === 'one') throw new Error('notification-reset-automation-changed');
      return {
        status: 'complete',
        operationId: 'operation',
        agentId: 'two',
        workspace: '/workspace/two',
        resources: [],
        automationRestored: true,
      };
    };
    await reset(f.options);
    assert.deepEqual(f.calls, ['preview:one', 'preview:two', 'run:one', 'run:two']);
    assert.deepEqual(
      JSON.parse(f.stdout.join('')).results.map((row: { status: string }) => row.status),
      ['incomplete', 'complete'],
    );
    assert.equal(f.code(), 1);
  });
  it('should prepopulate interactive selection and stop when confirmation is declined', async () => {
    const f = fixture();
    f.options.input = Object.assign(new Readable({ read() {} }), { isTTY: true });
    f.options.json = false;
    f.options.yes = false;
    f.options.purge = true;
    f.options.prompt = {
      multiselect: async (input) => {
        assert.deepEqual(input.initialValues, ['one', 'two']);
        return input.options.filter(({ value }) => value === 'one').map(({ value }) => value);
      },
      confirm: async () => false,
    };
    await reset(f.options);
    assert.deepEqual(f.calls, ['preview:one', 'preview:one']);
  });
  it('should wait for turns and continue without another confirmation', async () => {
    const f = fixture();
    f.options.agents = ['one'];
    let running = true;
    f.options.service.run = async () =>
      running
        ? {
            status: 'waiting',
            operationId: 'operation',
            agentId: 'one',
            workspace: '/workspace/one',
            phase: 'drain',
            intakePaused: true,
            resources: [],
            code: 'notification-reset-turns-active',
          }
        : {
            status: 'complete',
            operationId: 'operation',
            agentId: 'one',
            workspace: '/workspace/one',
            resources: [],
            automationRestored: true,
          };
    f.options.sleep = async () => {
      running = false;
    };
    await reset(f.options);
    assert.equal(JSON.parse(f.stdout.join('')).results[0].status, 'complete');
  });

  it('should not start a fresh reset when another process finishes the pending operation', async () => {
    const f = fixture();
    f.options.agents = ['one'];
    let runs = 0;
    const original = f.options.service.preview;
    f.options.service.preview = async (...args) => ({
      ...(await original(...args)),
      operationId: undefined,
    });
    f.options.service.run = async () => {
      runs++;
      return {
        status: 'waiting',
        operationId: 'operation',
        agentId: 'one',
        workspace: '/workspace/one',
        phase: 'drain',
        intakePaused: true,
        resources: [],
      };
    };
    f.options.sleep = async () => {};
    await reset(f.options);
    assert.equal(runs, 1);
    assert.equal(
      JSON.parse(f.stdout.join('')).results[0].code,
      'notification-reset-operation-changed',
    );
    assert.equal(f.code(), 1);
  });
});
