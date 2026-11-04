import assert from 'node:assert/strict';
import {
  getTextContent,
  type ChatCompletionRequest,
  type Fixture,
  type FixtureResponse,
} from '@copilotkit/aimock';

import { createPRExampleScenario } from '../openclaw-pr-journey/model-fixture.ts';
import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const prefix = 'call_manual_launch_';
const stages = ['context', 'prepare'];
const issueExampleScenario = createPRExampleScenario('openclaw-issue-launch');

/** only the trigger is new; the child uses the existing managed assessment protocol. */
function respond(request: ChatCompletionRequest): FixtureResponse | undefined {
  const delegation = request.messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      /Delegate manual issue launch target:/u.test(getTextContent(message.content) ?? ''),
  );
  const latestLaunch = request.messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      /(?:Delegate manual|Manual) issue launch target:/u.test(
        getTextContent(message.content) ?? '',
      ),
  );
  if (delegation >= 0 && delegation === latestLaunch) {
    const messages = request.messages.slice(delegation);
    const target =
      /Delegate manual issue launch target: (https:\/\/github\.com\/tanaabased\/big-test-bucket\/issues\/[1-9][0-9]*)/u.exec(
        getTextContent(messages[0]!.content) ?? '',
      )?.[1];
    if (!target) return;
    const sent = openClawAIMockToolResultText(messages, prefix + 'delegate');
    if (sent === undefined)
      return {
        toolCalls: [
          {
            id: prefix + 'delegate',
            name: 'sessions_send',
            arguments: JSON.stringify({
              sessionKey: 'agent:issue-launch-tanaabot:manual-delegate',
              message: `Manual issue launch target: ${target}`,
              timeoutSeconds: 0,
            }),
          },
        ],
      };
    const result = JSON.parse(sent);
    assert.equal(result.status, 'accepted');
    return { content: 'manual-launch-delegated' };
  }
  const boundary = request.messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      /Manual issue launch target:/u.test(getTextContent(message.content) ?? ''),
  );
  if (boundary < 0) return;
  const messages = request.messages.slice(boundary);
  const target =
    /Manual issue launch target: (https:\/\/github\.com\/tanaabased\/big-test-bucket\/(?:issues|pull)\/[1-9][0-9]*)/u.exec(
      getTextContent(messages[0]!.content) ?? '',
    )?.[1];
  if (!target) return;
  const attempts = new Map<string, number>();
  const result = (stage: string) => {
    for (let attempt = 0; attempt <= 3; attempt++) {
      const text = openClawAIMockToolResultText(messages, prefix + stage + '_' + attempt);
      if (text === undefined) {
        attempts.set(stage, attempt);
        return;
      }
      let value = JSON.parse(text);
      while (typeof value === 'string') value = JSON.parse(value);
      if (
        !['private-state-file-lock-busy', 'private-state-snapshot-conflict'].includes(
          String(value.code),
        )
      )
        return value as Record<string, unknown>;
      assert.ok(attempt < 3, 'manual launch contention retry exhausted');
    }
  };
  const dispatch = (stage: string, args: object): FixtureResponse => ({
    toolCalls: [
      {
        id: prefix + stage + '_' + (attempts.get(stage) ?? 0),
        name: 'agent_system_dispatch',
        arguments: JSON.stringify(args),
      },
    ],
  });
  const context = result('context');
  if (!context)
    return dispatch('context', { action: 'launch', operation: 'context', target, mode: 'plan' });
  if (context.status === 'existing') return { content: 'manual-launch-existing' };
  assert.equal(context.status, 'routing-required');
  const prepared = result('prepare');
  if (!prepared)
    return dispatch('prepare', {
      action: 'launch',
      operation: 'prepare',
      target,
      id: context.id,
      digest: context.digest,
      assessment: { complexity: 'low', reason: 'A bounded disposable documentation plan.' },
      fallback: 'default',
      title: 'Document disposable test issue cleanup',
    });
  assert.ok(
    ['assessment-pending', 'assessment-completed'].includes(String(prepared.status)),
    JSON.stringify(prepared),
  );
  return { content: 'manual-launch-started' };
}

const fixture: Fixture = {
  match: {
    model: issueExampleScenario.model.match,
    systemMessage: [...issueExampleScenario.systemPromptSignals],
    predicate: (request) => !!respond(request),
  },
  response: (request) => {
    const response = respond(request);
    assert.ok(response);
    return response;
  },
};
const final: Fixture = {
  ...fixture,
  match: {
    ...fixture.match,
    predicate: (request) => !!respond(request) && 'content' in respond(request)!,
  },
};

export const issueLaunchExampleScenario: OpenClawAIMockScenario = {
  ...issueExampleScenario,
  id: 'openclaw-issue-launch',
  expectedInvalidToolCalls: [],
  finalResponses: ['manual-launch-started', 'manual-launch-existing', 'manual-launch-delegated'],
  dynamicFinalResponseFixtures: [
    final,
    ...(issueExampleScenario.dynamicFinalResponseFixtures ?? []),
  ],
  toolCalls: [
    { id: prefix + 'delegate', name: 'sessions_send' },
    ...issueExampleScenario.toolCalls,
    ...stages.flatMap((stage) =>
      [0, 1, 2, 3].map((attempt) => ({
        id: prefix + stage + '_' + attempt,
        name: 'agent_system_dispatch',
      })),
    ),
  ],
  fixtures: [fixture, ...issueExampleScenario.fixtures],
};
