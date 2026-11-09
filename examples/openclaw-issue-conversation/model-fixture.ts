import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

import { getTextContent, type Fixture } from '@copilotkit/aimock';

import { issueExampleScenario } from '../openclaw-issue-journey/model-fixture.ts';
import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

const queueHold: Fixture = {
  match: {
    model: issueExampleScenario.model.match,
    systemMessage: ['Name: Notification Tanaabot'],
    predicate: (request) => {
      const latest = request.messages.findLast(
        ({ role, content }) =>
          role === 'user' &&
          !['<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>', 'OpenClaw runtime context:'].some((prefix) =>
            getTextContent(content)?.trimStart().startsWith(prefix),
          ),
      );
      return (
        getTextContent(latest?.content ?? null)?.includes(
          'Hold conversation queue until release',
        ) ?? false
      );
    },
  },
  response: async () => {
    const root = process.env.TMPDIR;
    assert.ok(root);
    await writeFile(join(root, 'conversation-queue-ready'), 'ready');
    const signal = AbortSignal.timeout(120_000);
    while (
      !(await access(join(root, 'conversation-queue-release')).then(
        () => true,
        () => false,
      ))
    )
      await setTimeout(100, undefined, { signal });
    return { content: 'Conversation queue hold released.' };
  },
};

export const conversationExampleScenario: OpenClawAIMockScenario = {
  ...issueExampleScenario,
  id: 'openclaw-issue-conversation',
  dynamicFinalResponseFixtures: [
    ...(issueExampleScenario.dynamicFinalResponseFixtures ?? []),
    queueHold,
  ],
  fixtures: [queueHold, ...issueExampleScenario.fixtures],
};
