import assert from 'node:assert/strict';

import projectPickupJobs from '../agent/project-pickup-jobs.ts';
import { automationThreadSelection } from '../agent/automation-threads.ts';
import { projectPickupPolicyDigest } from '../agent/project-pickup-authority.ts';
import parse from '../manifest/parse.ts';
import { pickupDeclaration } from './project-pickup-fixture.ts';

// synthetic names and native ids exercise the existing shared conversation selector.
describe('project pickup conversation selection', () => {
  for (const runtime of ['codex', 'openclaw'] as const) {
    for (const thread of [
      undefined,
      '  pickup watch  ',
      { name: ' pickup watch ', id: ' native-chat ' },
    ]) {
      it(`should project ${thread === undefined ? 'the default' : typeof thread === 'string' ? 'a name' : 'a name and id'} through the native conversation owner in ${runtime}`, () => {
        const parsed = parse(
          JSON.stringify({
            'schema-version': 1,
            agent: { id: 'receiver' },
            models: Object.fromEntries(
              ['default', 'low', 'medium', 'high'].map((tier) => [
                tier,
                { model: 'openai/gpt-6-luna', effort: 'medium' },
              ]),
            ),
            github: {
              username: 'receiver',
              runtimes: [runtime],
              'allowed-repository-owners': [{ login: 'owner', 'node-id': 'O_owner' }],
              'issue-assignment': { allowed: [{ login: 'operator', 'node-id': 'U_operator' }] },
              'project-pickup': {
                ...pickupDeclaration,
                coordinator: { runtime, 'instance-id': '11111111-1111-4111-8111-111111111111' },
                thread,
              },
            },
          }),
        );
        assert.equal(parsed.status, 'valid', JSON.stringify(parsed));
        if (parsed.status !== 'valid') return;
        const job = projectPickupJobs(parsed.manifest, runtime)[0]!;
        assert.deepEqual(
          job.thread,
          thread === undefined
            ? { name: 'PROJECT PICKUP' }
            : typeof thread === 'string'
              ? { name: 'pickup watch' }
              : { name: 'pickup watch', id: 'native-chat' },
        );
        const selected = automationThreadSelection(job, runtime)!;
        assert.equal(selected.name, thread === undefined ? 'PROJECT PICKUP' : 'pickup watch');
        assert.equal(selected.exact, typeof thread === 'object' ? 'native-chat' : undefined);
        assert.equal(selected.managed, true);
        const policy = parsed.manifest.github!.notifications!;
        const digest = projectPickupPolicyDigest(policy);
        policy.projectPickup!.thread = { name: 'renamed' };
        assert.equal(projectPickupPolicyDigest(policy), digest);
      });
    }
  }
});
