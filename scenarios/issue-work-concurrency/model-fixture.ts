import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import hasToolResult from '../../scripts/aimock-tool-result.ts';

const callId = 'call_concurrent_assignment_reply';
const finalResponse =
  '## Assessment\n\nThe bounded assignment is ready.\n\n## Plan\n\nI will carry out the requested work after this planning checkpoint.';
const signals = [
  'This is the initial turn for an assigned issue',
  'In a mode that advances automatically, call `agent_system_github_reply` exactly once',
];

export function concurrencyIssueNumber(request: ChatCompletionRequest): number {
  const sources = request.messages
    .filter((message) => ['system', 'developer', 'user'].includes(message.role))
    .map((message) => getTextContent(message.content) ?? '');
  const blocks = sources.flatMap((source) =>
    [...source.matchAll(/^[\t ]*```json[\t ]*\r?\n([\s\S]*?)^[\t ]*```[\t ]*$/gmu)].map(
      (match) => match[1]!,
    ),
  );
  const observations: unknown[] = [];
  for (const block of blocks) {
    try {
      const context = JSON.parse(block) as {
        source?: string;
        type?: string;
        payload?: {
          item?: {
            lifecycleId?: string;
            number?: number;
            repositoryOwner?: string;
            repositoryName?: string;
          };
          issue?: { title?: string; body?: string };
        };
      };
      const item = context.payload?.item;
      const issue = context.payload?.issue;
      observations.push({
        keys: Object.keys(context),
        source: context.source,
        type: context.type,
        item,
        issueKeys: issue ? Object.keys(issue) : [],
        titleMatches:
          typeof issue?.title === 'string' &&
          /^concurrent assignment [abc] \d+ \d+ (?:Linux|macOS)$/u.test(issue.title),
        bodyMatches:
          issue?.body ===
          'Assess the bounded concurrency fixture without changing repository files.',
      });
      if (
        context.source === 'agent-system' &&
        context.type === 'github_lifecycle_context' &&
        item?.lifecycleId === 'issue' &&
        item.repositoryOwner === 'tanaabased' &&
        item?.repositoryName === 'big-test-bucket' &&
        Number.isSafeInteger(item.number) &&
        item.number! > 0 &&
        typeof issue?.title === 'string' &&
        /^concurrent assignment [abc] \d+ \d+ (?:Linux|macOS)$/u.test(issue.title) &&
        issue.body === 'Assess the bounded concurrency fixture without changing repository files.'
      )
        return item.number!;
    } catch {
      observations.push({ invalidJson: true });
      continue;
    }
  }
  throw new Error(
    `The concurrency fixture did not receive bounded issue context. ${JSON.stringify({
      roles: request.messages.map(({ role }) => role),
      jsonBlocks: blocks.length,
      observations,
    })}`,
  );
}

const fixtures: Fixture[] = [
  {
    match: {
      hasToolResult: false,
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      systemMessage: signals,
      toolName: 'agent_system_github_reply',
    },
    response: async (request) => {
      const gate = join(tmpdir(), 'notification-concurrency');
      let number: number;
      try {
        number = concurrencyIssueNumber(request);
      } catch (error) {
        await writeFile(join(gate, 'fixture-error'), String(error));
        throw error;
      }
      await writeFile(join(gate, `entered-${number}`), 'entered');
      const deadline = Date.now() + 240_000;
      while (true) {
        try {
          await readFile(join(gate, 'release'));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (Date.now() >= deadline)
          throw new Error('The concurrency barrier was not released within four minutes.');
        await setTimeout(100);
      }
      return {
        toolCalls: [
          {
            id: callId,
            name: 'agent_system_github_reply',
            arguments: JSON.stringify({
              body: `I will resolve the bounded assignment for issue ${number}.`,
            }),
          },
        ],
      };
    },
  },
  {
    match: {
      hasToolResult: true,
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      systemMessage: signals,
      predicate: (request) => hasToolResult(request.messages, callId),
    },
    response: { content: finalResponse },
  },
];

export const concurrencyScenario = {
  id: 'concurrency',
  fixtures,
  finalResponses: [finalResponse],
  model: { match: /^(?:aimock\/)?gpt-5\.5$/u, reference: 'aimock/gpt-5.5' },
  systemPromptSignals: signals,
  toolCalls: [{ id: callId, name: 'agent_system_github_reply' }],
};
