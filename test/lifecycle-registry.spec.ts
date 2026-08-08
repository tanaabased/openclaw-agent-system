import assert from 'node:assert/strict';

import AgentSystemLifecycleRegistry, {
  AgentSystemLifecycleError,
} from '../lib/lifecycle-registry.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';

const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'data' },
  github: {},
};
const context = { manifest, workspaceDir: '/workspace' };

describe('lib/lifecycle-registry', () => {
  it('should collect configured validation, inspection, and reconciliation results', async () => {
    const registry = new AgentSystemLifecycleRegistry([
      {
        id: 'github',
        isConfigured: (candidate) => candidate.github !== undefined,
        validate: () => ({
          diagnostics: [
            {
              code: 'github-config-warning',
              message: 'The GitHub configuration uses a fallback.',
              severity: 'warning',
            },
          ],
          summary: 'GitHub tool configuration',
        }),
        async inspect() {
          return [
            {
              code: 'github-config-ready',
              message: 'Generated GitHub CLI config matches.',
              status: 'healthy',
            },
          ];
        },
        async reconcile() {
          return {
            outcomes: [
              {
                code: 'create-github-config',
                message: 'private GitHub CLI config',
                status: 'created',
              },
            ],
            warnings: [
              {
                code: 'github-config-warning',
                message: 'The GitHub configuration uses a fallback.',
              },
            ],
          };
        },
      },
      {
        id: 'unused',
        isConfigured: () => false,
        validate() {
          throw new Error('unconfigured contribution should not run');
        },
      },
    ]);

    assert.deepEqual(registry.validate(context), {
      checks: [{ component: 'github', message: 'GitHub tool configuration', status: 'valid' }],
      diagnostics: [
        {
          code: 'github-config-warning',
          component: 'github',
          message: 'The GitHub configuration uses a fallback.',
          severity: 'warning',
        },
      ],
    });
    assert.deepEqual(await registry.inspect(context), [
      {
        code: 'github-config-ready',
        component: 'github',
        message: 'Generated GitHub CLI config matches.',
        status: 'healthy',
      },
    ]);
    assert.deepEqual(await registry.reconcile(context), {
      outcomes: [
        {
          code: 'create-github-config',
          component: 'github',
          message: 'private GitHub CLI config',
          status: 'created',
        },
      ],
      warnings: [
        {
          code: 'github-config-warning',
          component: 'github',
          message: 'The GitHub configuration uses a fallback.',
        },
      ],
    });
  });

  it('should reject duplicate contribution ids', () => {
    const contribution = { id: 'github', isConfigured: () => true };

    assert.throws(
      () => new AgentSystemLifecycleRegistry([contribution, contribution]),
      /Duplicate Agent System lifecycle contribution id: github/u,
    );
  });

  it('should preserve registration order across lifecycle phases', async () => {
    const events: string[] = [];
    const contribution = (id: string) => ({
      id,
      isConfigured: () => true,
      validate() {
        events.push(`validate:${id}`);
        return { summary: id };
      },
      async inspect() {
        events.push(`inspect:${id}`);
        return [];
      },
      async reconcile() {
        events.push(`reconcile:${id}`);
        return { outcomes: [] };
      },
    });
    const registry = new AgentSystemLifecycleRegistry([
      contribution('agent'),
      contribution('path'),
      contribution('github'),
    ]);

    registry.validate(context);
    await registry.inspect(context);
    await registry.reconcile(context);

    assert.deepEqual(events, [
      'validate:agent',
      'validate:path',
      'validate:github',
      'inspect:agent',
      'inspect:path',
      'inspect:github',
      'reconcile:agent',
      'reconcile:path',
      'reconcile:github',
    ]);
  });

  it('should fail closed with component-attributed lifecycle failures', async () => {
    const registry = new AgentSystemLifecycleRegistry([
      {
        id: 'github',
        isConfigured: () => true,
        validate() {
          throw new Error('private validation details');
        },
        async inspect() {
          throw new Error('private inspection details');
        },
        async reconcile() {
          throw new Error('private reconciliation details');
        },
      },
    ]);

    assert.deepEqual(registry.validate(context), {
      checks: [],
      diagnostics: [
        {
          code: 'github-validation-failed',
          component: 'github',
          message: 'The github lifecycle declaration could not be validated.',
          severity: 'error',
        },
      ],
    });
    assert.deepEqual(await registry.inspect(context), [
      {
        code: 'github-inspection-failed',
        component: 'github',
        message: 'The github lifecycle state could not be inspected.',
        status: 'blocked',
      },
    ]);
    await assert.rejects(registry.reconcile(context), (error: unknown) => {
      assert.equal(error instanceof AgentSystemLifecycleError, true);
      if (error instanceof AgentSystemLifecycleError) {
        assert.equal(error.code, 'github-reconcile-failed');
        assert.equal(error.component, 'github');
        assert.equal(error.message, 'The github lifecycle state could not be reconciled.');
      }
      return true;
    });
  });
});
