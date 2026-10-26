import { withNotificationResetDiagnostic } from '../agent/notification-reset-diagnostic.ts';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import ansis from 'ansis';
import stringWidth from 'fast-string-width';
import { createCliStyles } from '../cli/output.ts';
import reset, { type ResetNotificationsOptions } from '../channels/github/cli/reset.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import type { NotificationResetPreview } from '../agent/notification-reset.ts';

describe('channels/github/cli/reset', () => {
  function fixture() {
    const calls: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const events: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
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
        writeStdout: (text) => {
          stdout.push(text);
          events.push({ stream: 'stdout', text });
        },
        writeStderr: (text) => {
          stderr.push(text);
          events.push({ stream: 'stderr', text });
        },
      },
      setExitCode: (value) => {
        code = value;
      },
    };
    return { options, calls, stdout, stderr, events, code: () => code };
  }
  it('should retain preview consent, masked destinations and recovery across widths and color modes', async () => {
    async function capture(columns: number, color = false, json = false, decline = false) {
      const f = fixture();
      Object.assign(f.options, {
        json,
        yes: false,
        purge: true,
        terminalColumns: columns,
        styles: createCliStyles(color ? { FORCE_COLOR: '3' } : { NO_COLOR: '1', FORCE_COLOR: '3' }),
        input: Object.assign(new Readable({ read() {} }), { isTTY: true }),
      });
      const preview = f.options.service.preview;
      f.options.service.preview = async (...args) => ({
        ...(await preview(...args)),
        fresh: true,
        continuing: false,
        resources: [
          {
            id: 'chat-fixture',
            identity: 'chat-fixture',
            state: 'pending',
            kind: 'chat',
            description: 'Chat-Private-9c31',
            details: ['MixedCase retained detail'],
          },
          {
            id: 'worktree-fixture',
            identity: 'worktree-fixture',
            state: 'pending',
            kind: 'worktree',
            description: '/Workspace/Mixed/Retained',
            details: [],
          },
        ],
      });
      f.options.prompt = {
        multiselect: async (input) =>
          input.options.filter(({ value }) => value === 'one').map(({ value }) => value),
        confirm: async () => {
          if (!json) {
            const text = ansis.strip(f.stdout.join('')).replace(/\s/gu, '');
            for (const signal of [
              'purge',
              'pauseintake',
              'baseline',
              'restore',
              'one',
              '/Workspace/Mixed/Retained',
              '***9c31',
              'MixedCaseretaineddetail',
              'freshreset',
            ])
              assert.ok(text.includes(signal));
            assert.ok(!text.includes('Chat-Private-9c31'));
          }
          assert.ok(!f.calls.some((call) => call.startsWith('run:')));
          return !decline;
        },
      };
      f.options.service.run = async (manifest) => {
        f.calls.push(`run:${manifest.agent.id}`);
        throw new Error('notification-reset-automation-changed');
      };
      if (json) {
        f.options.yes = true;
        f.options.agents = ['one'];
      }
      await reset(f.options);
      return f;
    }
    const wide = await capture(120);
    for (const columns of [32, 80]) {
      const plain = await capture(columns);
      const colored = await capture(columns, true);
      assert.deepEqual(
        colored.events.map((e) => ({ ...e, text: ansis.strip(e.text) })),
        plain.events,
      );
      assert.deepEqual(plain.calls, ['preview:one', 'run:one']);
      assert.equal(plain.code(), 1);
      assert.ok(plain.events.slice(0, -1).every((e) => e.stream === 'stdout'));
      assert.equal(plain.events.at(-1)?.stream, 'stderr');
      assert.equal(plain.stderr.join('').match(/\nmessages\n/gu)?.length, 1);
      assert.ok(
        plain.events.every((e) => e.text.split('\n').every((line) => stringWidth(line) <= columns)),
      );
      assert.equal(
        plain.events
          .map((e) => e.text)
          .join('')
          .replace(/\s/gu, ''),
        wide.events
          .map((e) => e.text)
          .join('')
          .replace(/\s/gu, ''),
      );
    }
    const declined = await capture(80, false, false, true);
    assert.deepEqual(declined.calls, ['preview:one']);
    assert.equal(declined.code(), 0);
    const machine = await capture(32, true, true);
    assert.equal(
      JSON.parse(machine.stdout.join('')).results[0].code,
      'notification-reset-automation-changed',
    );
    assert.ok(
      !machine.events.some((e) => e.text.includes('messages') || e.text.includes('\u001b')),
    );
  });
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

  it('should use explicit single and repeated targets without asking for target selection', async () => {
    for (const agents of [['one'], ['two', 'one', 'two']]) {
      const f = fixture();
      const originalPreview = f.options.service.preview;
      f.options.service.preview = async (...args) => ({
        ...(await originalPreview(...args)),
        continuing: false,
      });
      f.options.agents = agents;
      f.options.yes = false;
      f.options.json = false;
      f.options.input = Object.assign(new Readable({ read() {} }), { isTTY: true });
      let selections = 0;
      let confirmations = 0;
      f.options.prompt = {
        multiselect: async () => {
          selections++;
          return [];
        },
        confirm: async () => {
          confirmations++;
          return true;
        },
      };
      await reset(f.options);
      assert.equal(selections, 0);
      assert.equal(confirmations, 1);
      assert.deepEqual(
        f.calls.filter((call) => call.startsWith('preview:')),
        [...new Set(agents)].map((id) => `preview:${id}`),
      );
    }
  });

  it('should use all available agents without asking for target selection', async () => {
    const f = fixture();
    f.options.agents = [];
    f.options.all = true;
    const originalPreview = f.options.service.preview;
    f.options.service.preview = async (...args) => ({
      ...(await originalPreview(...args)),
      continuing: false,
    });
    f.options.yes = false;
    f.options.json = false;
    f.options.input = Object.assign(new Readable({ read() {} }), { isTTY: true });
    let selections = 0;
    let confirmations = 0;
    f.options.prompt = {
      multiselect: async () => {
        selections++;
        return [];
      },
      confirm: async () => {
        confirmations++;
        return true;
      },
    };
    await reset(f.options);
    assert.equal(selections, 0);
    assert.equal(confirmations, 1);
    assert.deepEqual(
      f.calls.filter((call) => call.startsWith('preview:')),
      ['preview:one', 'preview:two'],
    );
  });

  it('should offer only individual agents and normalize selecting all to the complete target list', async () => {
    const f = fixture();
    f.options.agents = [];
    f.options.yes = false;
    f.options.json = false;
    f.options.input = Object.assign(new Readable({ read() {} }), { isTTY: true });
    f.options.prompt = {
      multiselect: async (input) => {
        assert.deepEqual(input.options, [
          { value: 'one', label: 'one' },
          { value: 'two', label: 'two' },
        ]);
        return input.options.map(({ value }) => value);
      },
      confirm: async () => true,
    };
    await reset(f.options);
    assert.deepEqual(
      f.calls.filter((call) => call.startsWith('preview:')),
      ['preview:one', 'preview:two'],
    );
  });

  it('should preserve explicit-target conflict and unknown-agent errors', async () => {
    const conflict = fixture();
    conflict.options.all = true;
    await assert.rejects(reset(conflict.options), /notification-reset-target-conflict/u);
    assert.deepEqual(conflict.calls, []);

    const unknown = fixture();
    unknown.options.agents = ['missing'];
    await assert.rejects(reset(unknown.options), /notification-reset-agent-unknown/u);
    assert.deepEqual(unknown.calls, []);
  });

  it('should offer fresh recovery interactively and pass the selected preview to execution', async () => {
    const f = fixture();
    f.options.agents = [];
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
  it('should keep final confirmation separate from explicit target selection', async () => {
    const f = fixture();
    const originalPreview = f.options.service.preview;
    f.options.service.preview = async (...args) => ({
      ...(await originalPreview(...args)),
      continuing: false,
    });
    f.options.input = Object.assign(new Readable({ read() {} }), { isTTY: true });
    f.options.json = false;
    f.options.yes = false;
    let selections = 0;
    let confirmationMessage = '';
    f.options.prompt = {
      multiselect: async () => {
        selections++;
        return [];
      },
      confirm: async ({ message }) => {
        confirmationMessage = message;
        return false;
      },
    };
    await reset(f.options);
    assert.equal(selections, 0);
    assert.equal(confirmationMessage, 'reset notifications for these agents?');
    assert.deepEqual(f.calls, ['preview:one', 'preview:two']);
  });
  it('should wait for turns and continue without another confirmation', async () => {
    for (const json of [false, true]) {
      const f = fixture();
      f.options.json = json;
      f.options.styles = createCliStyles({ FORCE_COLOR: '3' });
      f.options.agents = ['one'];
      const instruction = 'MixedCase managed turn remains active; no turns will be aborted';
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
              instruction,
            }
          : {
              status: 'complete',
              operationId: 'operation',
              agentId: 'one',
              workspace: '/workspace/one',
              resources: [],
              automationRestored: true,
              warnings: ['MixedCase reset warning'],
            };
      f.options.sleep = async () => {
        if (!json) {
          const text = f.stdout.join('');
          assert.match(ansis.strip(text), /waiting\s+MixedCase managed turn/u);
          assert.ok(!text.includes(f.options.styles!.notice(instruction)));
        }
        running = false;
      };
      await reset(f.options);
      assert.equal(f.code(), 0);
      if (json) assert.equal(JSON.parse(f.stdout.join('')).results[0].status, 'complete');
      else assert.match(ansis.strip(f.stdout.join('')), /one\s+complete/u);
      assert.equal(f.events.at(-1)?.stream, 'stderr');
      assert.ok(f.stderr.join('').includes('MixedCase reset warning'));
    }
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
  it('should report the failed phase and operation, masking chat ids only in human diagnostics', async () => {
    const f = fixture();
    f.options.agents = ['one'];
    f.options.service.run = async () =>
      withNotificationResetDiagnostic(
        {
          phase: 'drain',
          operation: 'sessions.describe',
          resource: { kind: 'chat', description: 'agent:emori:12345678' },
        },
        async () => {
          throw new Error('session-dispatch-describe-forbidden');
        },
      );
    await reset(f.options);
    const result = JSON.parse(f.stdout.join('')).results[0];
    assert.equal(result.code, 'session-dispatch-describe-forbidden');
    assert.equal(result.phase, 'drain');
    assert.equal(result.operation, 'sessions.describe');
    assert.equal(result.resource.description, 'agent:emori:12345678');
    assert.match(f.stderr.join(''), /chat: \*\*\*5678/u);
    assert.ok(!f.stderr.join('').includes('agent:emori:12345678'));
    assert.equal(f.code(), 1);
  });

  it('should withhold unknown upstream messages from both output streams', async () => {
    const f = fixture();
    f.options.agents = ['one'];
    f.options.service.run = async () => {
      throw new Error('token=private');
    };
    await reset(f.options);
    assert.equal(JSON.parse(f.stdout.join('')).results[0].code, 'notification-reset-failed');
    assert.ok(![...f.stdout, ...f.stderr].join('').includes('token=private'));
    assert.equal(f.code(), 1);
  });
});
