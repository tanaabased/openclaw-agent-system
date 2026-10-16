import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

function currentPrompt(request: ChatCompletionRequest, phase: string): boolean {
  return (
    request.messages
      .filter(({ role }) => role === 'user')
      .map(({ content }) => getTextContent(content) ?? '')
      .findLast((text) => !text.trimStart().startsWith('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>'))
      ?.includes(`Execute the worktree ${phase} probe.`) ?? false
  );
}

const phases = ['first', 'continued'];
const fixtures: Fixture[] = phases.flatMap((phase) => {
  const callId = `call_worktree_${phase}`;
  return [
    {
      match: {
        hasToolResult: false,
        systemMessage: ['canonical-worktree-tanaabot'],
        toolName: 'exec',
        predicate: (request) => currentPrompt(request, phase),
      },
      response: {
        toolCalls: [
          {
            id: callId,
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
          openClawAIMockToolResultText(request.messages, callId)?.includes(
            `worktree-${phase}-verified`,
          ) === true,
      },
      response: { content: `worktree-${phase}-ready` },
    },
  ];
});

export const worktreeExampleScenario: OpenClawAIMockScenario = {
  id: 'openclaw-worktree',
  model: { match: /^(?:aimock\/)?gpt-5\.5$/u, reference: 'aimock/gpt-5.5' },
  fixtures,
  finalResponses: phases.map((phase) => `worktree-${phase}-ready`),
  systemPromptSignals: ['canonical-worktree-tanaabot'],
  toolCalls: phases.map((phase) => ({ id: `call_worktree_${phase}`, name: 'exec' })),
};
