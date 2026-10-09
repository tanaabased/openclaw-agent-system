import assert from 'node:assert/strict';

import credentialsCache from '../cli/credentials-cache.ts';
import automationOperation from '../cli/automation-output.ts';
import statusNotifications from '../channels/github/cli/status.ts';
import waitNotifications from '../channels/github/cli/wait.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';
import { createCliStyles } from '../cli/output.ts';
import { loadedToolTestManifest } from './tool-test-fixture.ts';

function fixture(json: boolean) {
  const events: Array<{ stream: string; text: string }> = [];
  const codes: number[] = [];
  const loaded = {
    ...loadedToolTestManifest(),
    diagnostics: [
      { code: 'fixture-warning', severity: 'warning' as const, message: 'fixture warning' },
    ],
  };
  return {
    json,
    events,
    codes,
    workspaceDir: '/workspace/data',
    manifestService: {
      loadForAgentId: async () => loaded,
      loadForCommandDirectory: async () => loaded,
    },
    output: {
      writeStdout: (text: string) => events.push({ stream: 'stdout', text }),
      writeStderr: (text: string) => events.push({ stream: 'stderr', text }),
    },
    styles: createCliStyles({ NO_COLOR: '1' }),
    setExitCode: (code: number) => codes.push(code),
  };
}

describe('cli/failure-evidence', () => {
  it('should preserve cache protocol causes without leaking upstream connection details', async () => {
    for (const json of [false, true]) {
      const f = fixture(json);
      await credentialsCache({
        ...f,
        action: 'flush',
        agentId: 'data',
        request: async () => {
          throw Object.assign(new Error('private-token private-value private-command'), {
            name: 'GatewayTransportError',
            kind: 'closed',
            code: 1006,
            requestDispatched: true,
            connectionDetails: { token: 'private-token' },
          });
        },
      });
      assert.deepEqual(f.codes, [1]);
      assert.equal(f.events.length, 1);
      const text = f.events[0]!.text.replace(/\s+/gu, '');
      assert.equal(f.events[0]!.stream, 'stderr');
      assert.match(text, /code=credentials-cache-request-failed/u);
      assert.match(text, /category.*closed/u);
      assert.match(text, /closeCode.*1006/u);
      assert.match(text, /requestDispatched.*true/u);
      assert.doesNotMatch(text, /private-/u);
      assert.ok(!text.includes('\u001b'));
      if (json) assert.doesNotMatch(text, /messages/u);
    }
  });

  it('should show bounded partial automation progress after primary output in one diagnostic section', async () => {
    const progress = {
      outcomes: [
        {
          component: 'automations',
          code: 'automation-created',
          status: 'created' as const,
          message: 'private notification prose',
        },
      ],
      warnings: [
        {
          component: 'automations',
          code: 'fixture-warning',
          message: 'private notification prose',
        },
      ],
      unattempted: [{ component: 'automations', stepId: 'later' }],
    };
    for (const json of [false, true]) {
      const f = fixture(json);
      await automationOperation({ ...f, automations: {} as never }, async () => {
        throw new AgentSystemLifecycleError(
          'automations',
          'automation-gateway-unavailable',
          'private-token',
          undefined,
          undefined,
          'blocked',
          progress,
        );
      });
      assert.deepEqual(f.codes, [1]);
      const stderr = f.events
        .filter(({ stream }) => stream === 'stderr')
        .map(({ text }) => text)
        .join('');
      assert.match(stderr, /completed=1.*warnings=1.*unattempted=1/u);
      assert.doesNotMatch(stderr, /private/u);
      if (json) {
        assert.deepEqual(JSON.parse(f.events[0]!.text).progress, progress);
        assert.deepEqual(
          f.events.map(({ stream }) => stream),
          ['stdout', 'stderr'],
        );
        assert.doesNotMatch(stderr, /messages/u);
        assert.ok(!stderr.includes('\u001b'));
      } else {
        assert.equal(stderr.match(/messages/gu)?.length, 1);
        assert.match(
          stderr,
          /error[\s\S]*automation-gateway-unavailable[\s\S]*warning[\s\S]*fixture warning/u,
        );
      }
    }
  });

  it('should report notification state failures once without private prose in either mode', async () => {
    for (const command of ['status', 'wait'] as const) {
      for (const json of [false, true]) {
        const f = fixture(json);
        const fail = async (): Promise<never> => {
          throw Object.assign(new Error('private notification prose'), { code: 'EACCES' });
        };
        if (command === 'status')
          await statusNotifications({ ...f, statusService: { inspect: fail } });
        else
          await waitNotifications({
            ...f,
            refresh: false,
            target: 'baseline-ready',
            statusService: { wait: fail },
          });
        assert.deepEqual(f.codes, [1]);
        assert.equal(f.events.length, 1);
        const text = f.events[0]!.text;
        assert.match(text, new RegExp(`code=github-notification-${command}-failed`, 'u'));
        assert.match(text, /cause=EACCES/u);
        assert.doesNotMatch(text, /private/u);
        if (!json) assert.equal(text.match(/messages/gu)?.length, 1);
        else {
          assert.doesNotMatch(text, /messages/u);
          assert.ok(!text.includes('\u001b'));
        }
      }
    }
  });
});
