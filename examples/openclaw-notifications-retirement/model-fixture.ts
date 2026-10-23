import assert from 'node:assert/strict';

import {
  getTextContent,
  type ChatCompletionRequest,
  type FixtureResponse,
  type Fixture,
} from '@copilotkit/aimock';

import { issueExampleScenario } from '../openclaw-notifications-issue-journey/model-fixture.ts';
import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const prefix = 'call_retirement_';
const stages = ['preview', 'apply'];
function retirement(request: ChatCompletionRequest): FixtureResponse | undefined {
  const start = request.messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      !getTextContent(message.content)
        ?.trimStart()
        .startsWith('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>'),
  );
  const messages = request.messages.slice(start);
  const prompt = messages
    .filter((message) => message.role === 'user')
    .map((message) => getTextContent(message.content) ?? '')
    .join('\n');
  const id = /Retire this managed task now ([a-f0-9]{64})/u.exec(prompt)?.[1];
  if (!id) return;
  let digest: string | undefined;
  for (const stage of stages) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const callId = prefix + stage + '_' + attempt;
      const text = openClawAIMockToolResultText(messages, callId);
      if (text === undefined)
        return {
          toolCalls: [
            {
              id: callId,
              name: 'agent_system_dispatch',
              arguments: JSON.stringify({ action: 'retire', id, ...(digest ? { digest } : {}) }),
            },
          ],
        };
      let result = JSON.parse(text);
      while (typeof result === 'string') result = JSON.parse(result);
      if (
        ['private-state-file-lock-busy', 'private-state-snapshot-conflict'].includes(result.code)
      ) {
        assert.ok(attempt < 3, 'retirement contention exhausted');
        continue;
      }
      assert.equal(result.status, stage === 'preview' ? 'retire-available' : 'retirement-pending');
      assert.equal(result.id, id);
      if (stage === 'preview') {
        assert.equal(typeof result.digest, 'string');
        digest = result.digest;
      } else assert.equal(result.retirement.code, 'retirement-native-work-unresolved');
      break;
    }
  }
  return { content: 'Retirement is pending while this native turn is active.' };
}
const tools: Fixture = {
  match: {
    model: issueExampleScenario.model.match,
    systemMessage: ['Name: Notification Tanaabot'],
    predicate: (request) => 'toolCalls' in (retirement(request) ?? {}),
  },
  response: (request) => {
    const result = retirement(request);
    assert.ok(result && 'toolCalls' in result);
    return result;
  },
};
const final: Fixture = {
  match: {
    model: issueExampleScenario.model.match,
    systemMessage: ['Name: Notification Tanaabot'],
    predicate: (request) => 'content' in (retirement(request) ?? {}),
  },
  response: (request) => {
    const result = retirement(request);
    assert.ok(result && 'content' in result);
    return result;
  },
};
export const retirementExampleScenario: OpenClawAIMockScenario = {
  ...issueExampleScenario,
  id: 'openclaw-notifications-retirement',
  dynamicFinalResponseFixtures: [
    ...(issueExampleScenario.dynamicFinalResponseFixtures ?? []),
    final,
  ],
  toolCalls: [
    ...issueExampleScenario.toolCalls,
    ...stages.flatMap((stage) =>
      [0, 1, 2, 3].map((attempt) => ({
        id: prefix + stage + '_' + attempt,
        name: 'agent_system_dispatch',
      })),
    ),
  ],
  fixtures: [tools, final, ...issueExampleScenario.fixtures],
};
