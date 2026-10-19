import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import parseAgentManifest from '../manifest/parse.ts';

for (const id of ['openclaw-issue', 'openclaw-pr', 'openclaw-notifications']) {
  const scenario = { id };
  const issueOnly = id !== 'openclaw-pr';
  const owner = 'tanaabot';
  const ownerLogin = 'tanaabot';
  const actorFolder = 'emori';
  const actorLogin = 'emoriwan';
  describe(`examples/${id} fixture configuration`, () => {
    it('should declare native planning with feedback and unavailable reviews for capability isolation', async () => {
      const parsed = parseAgentManifest(
        await readFile(`examples/${scenario.id}/${owner}/agent.yaml`, 'utf8'),
      );
      assert.equal(parsed.status, 'valid');
      assert.equal(parsed.manifest?.github?.notifications?.schemaVersion, 2);
      assert.deepEqual(parsed.manifest?.github?.notifications?.runtimes, ['openclaw']);
      assert.equal(parsed.manifest?.github?.notifications?.issueAssignment?.mode, 'plan');
      assert.equal(parsed.manifest?.github?.notifications?.issueAssignment?.feedback, true);
      assert.equal(parsed.manifest?.github?.notifications?.reviewRequest?.enabled, true);
      assert.equal(parsed.manifest?.models?.default.model, 'aimock/gpt-5.5');
      assert.equal(parsed.manifest?.github?.username, ownerLogin);
      assert.equal(parsed.manifest?.github?.token, 'GH_TOKEN_TANAABOT');
      assert.deepEqual(
        parsed.manifest?.github?.notifications?.issueAssignment?.allowed?.map(
          ({ login, nodeId }) => ({ login, nodeId }),
        ),
        [
          { login: actorLogin, nodeId: '__ACTOR_NODE_ID__' },
          ...(id === 'openclaw-notifications'
            ? [{ login: ownerLogin, nodeId: '__RECEIVER_NODE_ID__' }]
            : []),
        ],
      );
      const actor = parseAgentManifest(
        await readFile(`examples/${scenario.id}/${actorFolder}/agent.yaml`, 'utf8'),
      );
      assert.equal(actor.status, 'valid');
      assert.equal(actor.manifest?.github?.username, actorLogin);
      assert.equal(actor.manifest?.github?.token, 'GH_TOKEN_EMORI');
      assert.equal(actor.manifest?.github?.notifications, undefined);
      assert.deepEqual(
        parsed.manifest?.github?.notifications?.issueAssignment?.pullRequest?.recipients ?? [],
        issueOnly
          ? []
          : [{ login: 'tanaabot', nodeId: '__ASSIGNEE_NODE_ID__', roles: ['assignee'] }],
      );
    });
  });
}
