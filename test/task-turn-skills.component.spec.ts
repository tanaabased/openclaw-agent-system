import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { codexSkillResolver } from '../agent/tasks/assessment/codex-assessment-skill.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import { openClawSkillResolver } from '../agent/openclaw-skill.ts';
import taskTurnContext from '../agent/task-turn-context.ts';
import type { AgentManifest } from '../manifest/types.ts';

describe('agent/task-turn-skills', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'turn-skills-')));
    for (const name of ['implement', 'reply']) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, 'SKILL.md'), `# ${name}`);
    }
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const runtime of ['codex', 'openclaw'] as const) {
    function fixture() {
      let reads = 0;
      let unavailable = false;
      let names = ['implement', 'reply'];
      const request = async (method: string, params: Record<string, unknown>) => {
        reads++;
        assert.equal(method, runtime === 'codex' ? 'skills/list' : 'skills.status');
        assert.deepEqual(
          params,
          runtime === 'codex'
            ? { cwds: [root], forceReload: true }
            : { agentId: 'agent', sessionKey: 'session' },
        );
        if (unavailable) {
          unavailable = false;
          throw new Error('dispatch-assessment-skill-discovery-invalid');
        }
        const skills = names.map((name) => ({
          name: `custom:${name}`,
          path: join(root, name, 'SKILL.md'),
          filePath: join(root, name, 'SKILL.md'),
          scope: 'user',
          source: 'user',
          enabled: true,
          eligible: true,
          modelVisible: true,
        }));
        return runtime === 'codex' ? { data: [{ cwd: root, skills, errors: [] }] } : { skills };
      };
      const resolver = () =>
        runtime === 'codex'
          ? codexSkillResolver(request, root)
          : openClawSkillResolver(request, { agentId: 'agent', key: 'session' });
      const context = () =>
        taskTurnContext({
          runtime,
          workspace: root,
          target: 'https://github.com/owner/repo/issues/1',
          stage: 'feedback',
          record: {
            id: 'owner',
            progression: { stage: 'implementation', via: 'work' },
          } as SharedDispatchRecord,
          manifest: {
            agent: { id: 'agent' },
            github: {
              notifications: {
                issueAssignment: {
                  implementation: { skill: 'custom:implement' },
                  feedback: { skill: 'custom:reply' },
                },
              },
            },
          } as AgentManifest,
          feedback: {
            replyTarget: 'https://github.com/owner/repo/issues/1#issuecomment-2',
          } as NonNullable<Parameters<typeof taskTurnContext>[0]['feedback']>,
          resolveSkill: resolver(),
        });
      return {
        context,
        resolver,
        reads: () => reads,
        removeImplementation: () => (names = ['reply']),
        failDiscovery: () => (unavailable = true),
      };
    }

    it(`should share ${runtime} discovery within context and refresh it on the next request`, async () => {
      const test = fixture();
      const first = await test.context();
      assert.equal(first.implementation?.skill.path, join(root, 'implement', 'SKILL.md'));
      assert.equal(first.reply?.skill.path, join(root, 'reply', 'SKILL.md'));
      assert.equal(test.reads(), 1);
      test.removeImplementation();
      const second = await test.context();
      assert.equal(test.reads(), 2);
      assert.equal(second.implementation, undefined);
      assert.equal(second.reply?.skill.path, join(root, 'reply', 'SKILL.md'));
      assert.equal(second.status, 'verified');
      assert.deepEqual(second.contextLimitations, [
        { scope: 'implementation', code: 'dispatch-assessment-skill-unavailable' },
      ]);
    });

    it(`should let another ${runtime} selection recover after discovery fails`, async () => {
      const test = fixture();
      test.failDiscovery();
      const context = await test.context();
      assert.equal(test.reads(), 2);
      assert.equal(context.implementation, undefined);
      assert.equal(context.reply?.skill.path, join(root, 'reply', 'SKILL.md'));
      assert.deepEqual(context.contextLimitations, [
        { scope: 'implementation', code: 'dispatch-assessment-skill-discovery-invalid' },
      ]);
    });

    it(`should keep ${runtime} selected file reads fresh while reusing discovery`, async () => {
      const test = fixture();
      const resolve = test.resolver();
      const first = await resolve('custom:implement');
      await writeFile(first.path, '# revised implementation instructions');
      const second = await resolve('custom:implement');
      assert.notEqual(first.digest, second.digest);
      assert.equal(test.reads(), 1);
    });
  }
});
