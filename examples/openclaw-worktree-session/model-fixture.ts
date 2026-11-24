import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

function currentTurn(request: ChatCompletionRequest) {
  const index = request.messages.findLastIndex(
    ({ role, content }) =>
      role === 'user' &&
      !['<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>', 'OpenClaw runtime context:'].some((prefix) =>
        getTextContent(content)?.trimStart().startsWith(prefix),
      ),
  );
  return request.messages.slice(Math.max(0, index));
}

function currentPrompt(request: ChatCompletionRequest, phase: string): boolean {
  return (
    request.messages
      .filter(({ role }) => role === 'user')
      .map(({ content }) => getTextContent(content) ?? '')
      .findLast(
        (text) =>
          !['<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>', 'OpenClaw runtime context:'].some((prefix) =>
            text.trimStart().startsWith(prefix),
          ),
      )
      ?.includes(`Execute the worktree ${phase} probe.`) ?? false
  );
}

const probes = ['first', 'continued'].map((phase) => ({
  phase,
  id: `call_worktree_${phase}`,
  name: 'exec',
  resultMarker: `worktree-${phase}-verified`,
}));
const fixtures: Fixture[] = probes.flatMap(({ phase, id, resultMarker }) => {
  return [
    {
      match: {
        systemMessage: ['canonical-worktree-tanaabot'],
        toolName: 'exec',
        predicate: (request) =>
          currentPrompt(request, phase) &&
          !currentTurn(request).some(({ role }) => role === 'tool'),
      },
      response: {
        toolCalls: [
          {
            id,
            name: 'exec',
            arguments: JSON.stringify({
              command: `worktree-probe ${phase}`,
              timeoutSeconds: 60,
              yieldMs: 120000,
            }),
          },
        ],
      },
    },
    {
      match: {
        hasToolResult: true,
        systemMessage: ['canonical-worktree-tanaabot'],
        predicate: (request) =>
          currentPrompt(request, phase) &&
          openClawAIMockToolResultText(request.messages, id)?.includes(resultMarker) === true,
      },
      response: { content: `worktree-${phase}-ready` },
    },
  ];
});

export const worktreeExampleScenario: OpenClawAIMockScenario = {
  id: 'openclaw-worktree-session',
  model: { match: /^(?:aimock\/)?gpt-5\.5$/u, reference: 'aimock/gpt-5.5' },
  fixtures,
  finalResponses: probes.map(({ phase }) => `worktree-${phase}-ready`),
  systemPromptSignals: ['canonical-worktree-tanaabot'],
  toolCalls: probes,
};
