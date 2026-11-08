import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

import {
  getTextContent,
  type ChatCompletionRequest,
  type FixtureResponse,
  type Fixture,
} from '@copilotkit/aimock';

import { issueExampleScenario } from '../openclaw-issue-journey/model-fixture.ts';
import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const prefix = 'call_retirement_';
const stages = ['preview', 'apply'];
function retirement(request: ChatCompletionRequest): FixtureResponse | undefined {
  const start = request.messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      !['<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>', 'OpenClaw runtime context:'].some((prefix) =>
        getTextContent(message.content)?.trimStart().startsWith(prefix),
      ),
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
const queueHold: Fixture = {
  match: {
    model: issueExampleScenario.model.match,
    systemMessage: ['Name: Notification Tanaabot'],
    predicate: (request) =>
      request.messages.some(
        (message) =>
          message.role === 'user' &&
          getTextContent(message.content)?.includes('Hold retirement queue until release'),
      ),
  },
  response: async () => {
    const root = process.env.TMPDIR;
    assert.ok(root);
    await writeFile(join(root, 'retirement-queue-ready'), 'ready');
    const signal = AbortSignal.timeout(120_000);
    while (
      !(await access(join(root, 'retirement-queue-release')).then(
        () => true,
        () => false,
      ))
    ) {
      await setTimeout(100, undefined, { signal });
    }
    return { content: 'Retirement queue hold released.' };
  },
};
const helperCall = 'call_retirement_helper';
const helperTask = 'Complete retirement checkout helper.';
function helperPrompt(request: ChatCompletionRequest): string {
  return (
    request.messages
      .filter((message) => message.role === 'user')
      .map((message) => getTextContent(message.content) ?? '')
      .findLast(
        (text) =>
          !['<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>', 'OpenClaw runtime context:'].some((prefix) =>
            text.trimStart().startsWith(prefix),
          ),
      ) ?? ''
  );
}
const helperSpawn: Fixture = {
  match: {
    model: issueExampleScenario.model.match,
    systemMessage: ['Name: Notification Tanaabot'],
    predicate: (request) => helperPrompt(request).includes('Spawn retirement checkout helper at '),
  },
  response: async (request) => {
    const text = openClawAIMockToolResultText(request.messages, helperCall);
    if (text === undefined) {
      const prompt = helperPrompt(request);
      const cwd = /Spawn retirement checkout helper at ([^\n]+)/u.exec(prompt)?.[1]?.trim();
      assert.ok(cwd);
      return {
        toolCalls: [
          {
            id: helperCall,
            name: 'sessions_spawn',
            arguments: JSON.stringify({
              task: helperTask,
              cwd,
              mode: 'run',
              cleanup: 'keep',
              expectsCompletionMessage: false,
              context: 'isolated',
            }),
          },
        ],
      };
    }
    const result = JSON.parse(text);
    assert.equal(result.status, 'accepted');
    assert.equal(typeof result.childSessionKey, 'string');
    assert.equal(typeof result.runId, 'string');
    assert.ok(process.env.TMPDIR);
    await writeFile(join(process.env.TMPDIR, 'notification-helper.json'), JSON.stringify(result));
    return { content: 'Retirement checkout helper started.' };
  },
};
const helperCompleted: Fixture = {
  match: {
    model: issueExampleScenario.model.match,
    predicate: (request) => helperPrompt(request).includes(helperTask),
  },
  response: { content: 'Retirement checkout helper completed.' },
};
export const retirementExampleScenario: OpenClawAIMockScenario = {
  ...issueExampleScenario,
  id: 'openclaw-notifications-retirement',
  dynamicFinalResponseFixtures: [
    ...(issueExampleScenario.dynamicFinalResponseFixtures ?? []),
    final,
    queueHold,
    helperSpawn,
    helperCompleted,
  ],
  toolCalls: [
    ...issueExampleScenario.toolCalls,
    { id: helperCall, name: 'sessions_spawn' },
    ...stages.flatMap((stage) =>
      [0, 1, 2, 3].map((attempt) => ({
        id: prefix + stage + '_' + attempt,
        name: 'agent_system_dispatch',
      })),
    ),
  ],
  fixtures: [
    helperCompleted,
    helperSpawn,
    queueHold,
    tools,
    final,
    ...issueExampleScenario.fixtures,
  ],
};
