import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import parseAgentManifest from '../manifest/parse.ts';

for (const id of [
  'openclaw-issue',
  'openclaw-pr',
  'openclaw-intake',
  'openclaw-lifecycle',
  'openclaw-progression',
]) {
  describe(`examples/${id} fixture configuration`, () => {
    it('should accept the prepared fixture and route its supported workflow to the owning runtime', async () => {
      const source = (await readFile(`examples/${id}/tanaabot/agent.yaml`, 'utf8'))
        .replaceAll('__OWNER_NODE_ID__', 'O_owner')
        .replaceAll('__ACTOR_NODE_ID__', 'U_actor')
        .replaceAll('__RECEIVER_NODE_ID__', 'U_receiver');
      const parsed = parseAgentManifest(source);
      assert.equal(parsed.status, 'valid', JSON.stringify(parsed.diagnostics));
      const policy = parsed.manifest?.github?.notifications;
      assert.equal(policy?.schemaVersion, 3);
      assert.deepEqual(policy?.runtimes, ['openclaw']);
      assert.equal(policy?.issueAssignment?.mode, 'plan');
      assert.deepEqual(policy?.issueAssignment?.pullRequest?.recipients, [
        { source: 'assignment-actor', roles: ['assignee'] },
      ]);
    });
  });
}
