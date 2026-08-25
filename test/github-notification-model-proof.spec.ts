import assert from 'node:assert/strict';

import githubNotificationModelProofEvidence, {
  githubNotificationModelProofCallId,
  githubNotificationModelProofFinalResponse,
  hasGithubNotificationModelProofReplyToolResult,
} from '../scripts/github-notification-model-proof-evidence.ts';

const prompt = [
  'Continue the current GitHub issue lifecycle',
  'This is the initial planning turn for an assigned issue',
  'Before your final response, call `agent_system_github_reply` exactly once',
].join('\n');

describe('scripts/github-notification-model-proof-evidence', () => {
  it('should recognize the exact reply tool result before later response references', () => {
    assert.equal(
      hasGithubNotificationModelProofReplyToolResult([
        {
          role: 'tool',
          tool_call_id: githubNotificationModelProofCallId,
        },
        { role: 'assistant' },
      ]),
      true,
    );
    assert.equal(
      hasGithubNotificationModelProofReplyToolResult([
        { role: 'assistant' },
        { role: 'tool', tool_call_id: 'call_other' },
      ]),
      false,
    );
  });

  it('should normalize one strict tool loop across accepted responses paths', () => {
    assert.match(githubNotificationModelProofCallId, /^call_[A-Za-z0-9_-]{1,59}$/u);

    const evidence = githubNotificationModelProofEvidence([
      {
        body: {
          messages: [{ content: prompt, role: 'system' }],
          model: 'gpt-5.5',
          tools: [{ function: { name: 'agent_system_github_reply' } }],
        },
        method: 'POST',
        path: '/responses',
        response: {
          fixture: {
            response: {
              toolCalls: [
                {
                  id: githubNotificationModelProofCallId,
                  name: 'agent_system_github_reply',
                },
              ],
            },
          },
          status: 200,
        },
      },
      {
        body: {
          messages: [
            { content: prompt, role: 'system' },
            {
              content: '{"status":"staged"}',
              role: 'tool',
              tool_call_id: githubNotificationModelProofCallId,
            },
          ],
          model: 'gpt-5.5',
          tools: [{ function: { name: 'agent_system_github_reply' } }],
        },
        method: 'POST',
        path: '/v1/responses',
        response: {
          fixture: { response: { content: githubNotificationModelProofFinalResponse } },
          status: 200,
        },
      },
    ]);

    assert.deepEqual(evidence, {
      assignmentPromptRequestCount: 2,
      finalResponseCount: 1,
      model: 'aimock/gpt-5.5',
      provider: 'aimock',
      replyToolCallResponseCount: 1,
      replyToolProjectionRequestCount: 2,
      replyToolResultRequestCount: 1,
      requestCount: 2,
      responsesApiRequestCount: 2,
      schemaVersion: 1,
      strictMissCount: 0,
      successfulFixtureResponseCount: 2,
    });
  });

  it('should report unmatched requests without inventing successful proof signals', () => {
    const evidence = githubNotificationModelProofEvidence([
      {
        body: { messages: [], model: 'unexpected-model', tools: [] },
        method: 'POST',
        path: '/responses',
        response: { fixture: null, status: 503 },
      },
    ]);

    assert.deepEqual(evidence, {
      assignmentPromptRequestCount: 0,
      finalResponseCount: 0,
      model: 'unexpected-model',
      provider: 'aimock',
      replyToolCallResponseCount: 0,
      replyToolProjectionRequestCount: 0,
      replyToolResultRequestCount: 0,
      requestCount: 1,
      responsesApiRequestCount: 1,
      schemaVersion: 1,
      strictMissCount: 1,
      successfulFixtureResponseCount: 0,
    });
  });
});
