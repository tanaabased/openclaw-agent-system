import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bindCodexWorkspace, unbindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import {
  createCodexSessionContext,
  projectCodexManifest,
  projectCodexModelRouting,
} from '../agent/codex-context.ts';
import type { AgentManifest } from '../manifest/types.ts';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-system-codex-context-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

function envelope(context: string): Record<string, unknown> {
  const start = context.indexOf('{');
  const end = context.lastIndexOf('}');
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return JSON.parse(context.slice(start, end + 1)) as Record<string, unknown>;
}

describe('agent/codex-context', () => {
  it('should report an unbound installation without inventing a workspace', async () => {
    const root = await temporaryRoot();
    const nodeExecutable = join(root, 'node');
    const pluginData = join(root, 'data');
    const pluginRoot = join(root, 'plugin');

    const context = await createCodexSessionContext({
      nodeExecutable,
      pluginData,
      pluginRoot,
      source: 'startup',
    });

    assert.match(context, /supersedes every earlier Agent System context/u);
    assert.doesNotMatch(context, /When creating a new Codex task with model routing/u);
    assert.deepEqual(envelope(context), {
      version: 1,
      source: 'startup',
      bindingRuntime: {
        argvPrefix: [nodeExecutable, join(pluginRoot, 'dist/codex/codex-runtime.js'), 'binding'],
        pluginData,
      },
      setupRuntime: {
        argvPrefix: [nodeExecutable, join(pluginRoot, 'dist/codex/codex-runtime.js'), 'setup'],
        pluginData,
      },
      binding: { status: 'unbound' },
    });
  });

  it('should project only supported non-secret manifest metadata', () => {
    const manifest: AgentManifest = {
      schemaVersion: 1,
      agent: {
        id: 'emori',
        name: { fromEnvironment: 'AGENT_NAME_SECRET' },
        email: 'emori@example.com',
        description: 'Repository caretaker',
        emoji: '🦉',
      },
      environment: {
        set: { PRIVATE_VALUE: { fromOp: 'op://vault/item/field' } },
      },
      git: {
        name: 'Emori Git',
        email: { fromEnvironment: 'GIT_EMAIL_SECRET' },
        policy: { forcePush: 'deny' },
        signing: { key: 'SIGNING_KEY_SECRET' },
        ssh: { privateKeys: [{ fromEnvironment: 'SSH_KEY_SECRET' }] },
      },
      github: {
        host: 'github.com',
        username: 'emoriwan',
        token: 'GITHUB_TOKEN_SECRET',
        policy: { releases: 'deny' },
        sshKeys: [{ source: 'PUBLIC_KEY_VALUE', type: 'key' }],
      },
    };

    const projection = projectCodexManifest(manifest);
    const serialized = JSON.stringify(projection);

    assert.deepEqual(projection, {
      identity: {
        id: 'emori',
        email: 'emori@example.com',
        description: 'Repository caretaker',
        emoji: '🦉',
      },
      git: { name: 'Emori Git', policy: { forcePush: 'deny' } },
      github: { host: 'github.com', username: 'emoriwan', policy: { releases: 'deny' } },
      capabilities: ['agent-system-doctor', 'agent-system-git-cli', 'agent-system-github-cli'],
    });
    for (const secret of [
      'AGENT_NAME_SECRET',
      'GIT_EMAIL_SECRET',
      'SIGNING_KEY_SECRET',
      'SSH_KEY_SECRET',
      'GITHUB_TOKEN_SECRET',
      'PRIVATE_VALUE',
      'PUBLIC_KEY_VALUE',
      'op://vault/item/field',
    ]) {
      assert.equal(serialized.includes(secret), false);
    }
  });

  it('should map openai model profiles and preserve unsupported providers', () => {
    assert.deepEqual(
      projectCodexModelRouting({
        default: { model: 'openai/gpt-6-astra', effort: 'high' },
        low: { model: 'openai/gpt-5.6-terra', effort: 'medium' },
        medium: { model: 'openai/gpt-5.6-sol', effort: 'high' },
        high: { model: 'anthropic/claude-opus', effort: 'xhigh' },
      }),
      {
        default: {
          status: 'mapped',
          sourceModel: 'openai/gpt-6-astra',
          model: 'gpt-6-astra',
          thinking: 'high',
        },
        low: {
          status: 'mapped',
          sourceModel: 'openai/gpt-5.6-terra',
          model: 'gpt-5.6-terra',
          thinking: 'medium',
        },
        medium: {
          status: 'mapped',
          sourceModel: 'openai/gpt-5.6-sol',
          model: 'gpt-5.6-sol',
          thinking: 'high',
        },
        high: {
          status: 'unsupported',
          code: 'codex-model-provider-unsupported',
          sourceModel: 'anthropic/claude-opus',
          thinking: 'xhigh',
          message: 'Standalone Codex model routing supports only openai provider references.',
        },
      },
    );
  });

  it('should advertise only standalone capabilities for configured integrations', () => {
    const base: AgentManifest = { schemaVersion: 1, agent: { id: 'emori' } };
    const cases: Array<[Partial<AgentManifest>, string[]]> = [
      [{}, ['agent-system-doctor']],
      [{ setup: { steps: [] } }, ['agent-system-doctor', 'agent-system-install']],
      [
        { models: { default: { model: 'openai/gpt-6-astra', effort: 'high' } } },
        ['agent-system-doctor', 'agent-system-model-routing'],
      ],
      [{ git: {} }, ['agent-system-doctor', 'agent-system-git-cli']],
      [{ github: {} }, ['agent-system-doctor', 'agent-system-github-cli']],
      [
        { git: {}, github: {} },
        ['agent-system-doctor', 'agent-system-git-cli', 'agent-system-github-cli'],
      ],
      [
        { setup: { steps: [] }, git: {}, github: {} },
        [
          'agent-system-doctor',
          'agent-system-install',
          'agent-system-git-cli',
          'agent-system-github-cli',
        ],
      ],
      [
        {
          git: { worktrees: { root: 'worktrees' } },
          github: {
            notifications: {
              assignmentTypes: ['issue'],
              approvedActors: [{ login: 'operator', nodeId: 'U_operator' }],
              intervalMinutes: 5,
              maxConcurrentIssues: 2,
            },
          },
        },
        ['agent-system-doctor', 'agent-system-git-cli', 'agent-system-github-cli'],
      ],
    ];

    for (const [configuration, capabilities] of cases) {
      assert.deepEqual(
        projectCodexManifest({ ...base, ...configuration }).capabilities,
        capabilities,
      );
    }
  });

  it('should put model selection guidance after an active routing projection', async () => {
    const root = await temporaryRoot();
    const nodeExecutable = join(root, 'node');
    const pluginData = join(root, 'data');
    const pluginRoot = join(root, 'plugin');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(
      join(workspace, 'agent.yaml'),
      [
        'schema-version: 1',
        'agent:',
        '  id: emori',
        'models:',
        '  default: { model: openai/gpt-6-astra, effort: high }',
        '  low: { model: openai/gpt-5.6-terra, effort: medium }',
        '  medium: { model: openai/gpt-5.6-sol, effort: high }',
        '  high: { model: openai/gpt-6-astra, effort: xhigh }',
        '',
      ].join('\n'),
    );
    await bindCodexWorkspace(pluginData, workspace);

    const context = await createCodexSessionContext({
      nodeExecutable,
      pluginData,
      pluginRoot,
      source: 'startup',
    });
    const projection = JSON.stringify(envelope(context));
    const guidance = 'When creating a new Codex task with model routing';

    assert.match(projection, /"agent-system-model-routing"/u);
    assert.match(projection, /"model":"gpt-5\.6-sol","thinking":"high"/u);
    assert.equal(context.indexOf(guidance) > context.lastIndexOf('}'), true);
    assert.match(context, /Honor explicit user model and effort overrides independently\./u);
    assert.match(context, /controls reject or do not expose the model, effort, or combination/u);
    assert.match(context, /report that result without substitution/u);
    assert.match(context, /do not claim prompt text changed the runtime/u);
  });

  it('should refresh valid, invalid, and revoked context on every session source', async () => {
    const root = await temporaryRoot();
    const nodeExecutable = join(root, 'node');
    const pluginData = join(root, 'data');
    const pluginRoot = join(root, 'plugin');
    const workspace = join(root, 'workspace');
    const manifestPath = join(workspace, 'agent.yaml');
    await mkdir(workspace);
    await writeFile(
      manifestPath,
      'schema-version: 1\nagent:\n  id: emori\n  name: Emori\ngit:\n  policy:\n    force-push: deny\n',
    );
    await bindCodexWorkspace(pluginData, workspace);

    for (const source of ['startup', 'resume', 'clear', 'compact'] as const) {
      const current = JSON.stringify(
        envelope(
          await createCodexSessionContext({ nodeExecutable, pluginData, pluginRoot, source }),
        ),
      );
      assert.match(current, /"status":"active"/u);
      assert.match(current, /"id":"emori"/u);
      assert.match(current, new RegExp(`"source":"${source}"`, 'u'));
    }

    await writeFile(manifestPath, 'agent: [broken\n');
    const invalid = JSON.stringify(
      envelope(
        await createCodexSessionContext({
          nodeExecutable,
          pluginData,
          pluginRoot,
          source: 'resume',
        }),
      ),
    );
    assert.match(invalid, /"status":"inactive"/u);
    assert.match(invalid, /yaml-parse-error/u);
    assert.doesNotMatch(invalid, /"context"/u);

    await unbindCodexWorkspace(pluginData);
    const revoked = JSON.stringify(
      envelope(
        await createCodexSessionContext({
          nodeExecutable,
          pluginData,
          pluginRoot,
          source: 'clear',
        }),
      ),
    );
    assert.match(revoked, /"status":"unbound"/u);
    assert.doesNotMatch(revoked, /"id":"emori"/u);
  });
});
