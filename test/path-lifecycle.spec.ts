import assert from 'node:assert/strict';

import createPathLifecycleContribution from '../lib/path-lifecycle.ts';
import { AgentSystemLifecycleError } from '../lib/lifecycle-registry.ts';

const context = {
  manifest: { schemaVersion: 1 as const, agent: { id: 'data', name: 'Data' } },
  workspaceDir: '/workspace',
};
const projection = { entries: [], path: '/usr/bin' };

describe('lib/path-lifecycle', () => {
  it('should validate the foundational path declaration', () => {
    const contribution = createPathLifecycleContribution({
      pathService: {
        async inspect() {
          throw new Error('not used');
        },
        async reconcile() {
          throw new Error('not used');
        },
      },
    });

    assert.deepEqual(contribution.validate?.(context), {
      code: 'path-projection-valid',
      summary: 'Executable path projection',
    });
  });

  it('should report healthy managed path state', async () => {
    const contribution = createPathLifecycleContribution({
      pathService: {
        async inspect() {
          return {
            codex: {
              gitignored: true,
              loginShellDisabled: true,
              ownership: 'managed',
              pathMatches: true,
            },
            openClawMatches: true,
            projection,
          };
        },
        async reconcile() {
          throw new Error('not used');
        },
      },
    });

    assert.deepEqual(
      (await contribution.inspect?.(context))?.map(({ code, status }) => ({ code, status })),
      [
        { code: 'openclaw-exec-path-ready', status: 'healthy' },
        { code: 'codex-path-ready', status: 'healthy' },
        { code: 'codex-login-shell-disabled', status: 'healthy' },
        { code: 'codex-config-gitignored', status: 'healthy' },
      ],
    );
  });

  it('should keep user-managed codex configuration outside automatic repair', async () => {
    const contribution = createPathLifecycleContribution({
      pathService: {
        async inspect() {
          return {
            codex: {
              gitignored: false,
              loginShellDisabled: false,
              ownership: 'manual',
              pathMatches: false,
            },
            openClawMatches: true,
            projection,
          };
        },
        async reconcile() {
          throw new Error('not used');
        },
      },
    });

    assert.deepEqual(
      (await contribution.inspect?.(context))?.map(({ code, status }) => ({ code, status })),
      [
        { code: 'openclaw-exec-path-ready', status: 'healthy' },
        { code: 'codex-config-manual', status: 'manual' },
        { code: 'codex-login-shell-enabled', status: 'warning' },
        { code: 'codex-config-not-gitignored', status: 'warning' },
      ],
    );
  });

  it('should report managed login-shell drift as automatically repairable', async () => {
    const contribution = createPathLifecycleContribution({
      pathService: {
        async inspect() {
          return {
            codex: {
              gitignored: true,
              loginShellDisabled: false,
              ownership: 'managed',
              pathMatches: true,
            },
            openClawMatches: true,
            projection,
          };
        },
        async reconcile() {
          throw new Error('not used');
        },
      },
    });

    const finding = (await contribution.inspect?.(context))?.find(
      ({ code }) => code === 'codex-login-shell-enabled',
    );

    assert.equal(finding?.status, 'drift');
    assert.match(finding?.remediation ?? '', /agent-system install/u);
  });

  it('should convert an invalid path projection into drift', async () => {
    const contribution = createPathLifecycleContribution({
      pathService: {
        async inspect() {
          throw new Error('The declared path is missing.');
        },
        async reconcile() {
          throw new Error('not used');
        },
      },
    });

    const finding = (await contribution.inspect?.(context))?.[0];

    assert.equal(finding?.code, 'path-projection-invalid');
    assert.equal(finding?.status, 'drift');
  });

  it('should reconcile, verify, and translate path actions', async () => {
    let inspections = 0;
    const contribution = createPathLifecycleContribution({
      pathService: {
        async inspect() {
          inspections += 1;
          return {
            codex: {
              gitignored: true,
              loginShellDisabled: true,
              ownership: 'managed',
              pathMatches: true,
            },
            openClawMatches: true,
            projection,
          };
        },
        async reconcile() {
          return {
            actions: ['create-workspace-bin', 'set-exec-path', 'create-codex-config'],
            codexStatus: 'managed',
            projection,
            warnings: [],
          };
        },
      },
    });

    const result = await contribution.reconcile?.(context);

    assert.equal(inspections, 1);
    assert.deepEqual(
      result?.outcomes.map(({ code, status }) => ({ code, status })),
      [
        { code: 'create-workspace-bin', status: 'created' },
        { code: 'set-exec-path', status: 'updated' },
        { code: 'create-codex-config', status: 'created' },
      ],
    );
  });

  it('should report a verified no-op as an explicit unchanged outcome', async () => {
    const contribution = createPathLifecycleContribution({
      pathService: {
        async inspect() {
          return {
            codex: {
              gitignored: true,
              loginShellDisabled: true,
              ownership: 'managed',
              pathMatches: true,
            },
            openClawMatches: true,
            projection,
          };
        },
        async reconcile() {
          return { actions: [], codexStatus: 'managed', projection, warnings: [] };
        },
      },
    });

    assert.equal((await contribution.reconcile?.(context))?.outcomes[0]?.status, 'unchanged');
  });

  it('should fail when managed path state does not converge', async () => {
    const contribution = createPathLifecycleContribution({
      pathService: {
        async inspect() {
          return {
            codex: {
              gitignored: true,
              loginShellDisabled: true,
              ownership: 'managed',
              pathMatches: true,
            },
            openClawMatches: false,
            projection,
          };
        },
        async reconcile() {
          return { actions: [], codexStatus: 'managed', projection, warnings: [] };
        },
      },
    });

    await assert.rejects(
      () => contribution.reconcile!(context),
      (error: unknown) =>
        error instanceof AgentSystemLifecycleError &&
        error.code === 'openclaw-exec-path-verification-failed',
    );
  });
});
