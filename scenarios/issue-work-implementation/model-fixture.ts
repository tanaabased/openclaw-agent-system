import { isAbsolute, join } from 'node:path';

import type { ChatCompletionRequest, Fixture, ToolCallResponse } from '@copilotkit/aimock';

import hasGitHubNotificationModelToolResult from '../../scripts/github-notification-model-tool-result.ts';

export const githubNotificationImplementationReplyCallId = 'call_agent_system_implementation_reply';
export const githubNotificationImplementationPatchCallId =
  'call_apply_patch_implementation_fixture';
export const githubNotificationImplementationIssueCallId =
  'call_agent_system_github_implementation_issue';
export const githubNotificationImplementationAddCallId = 'call_agent_system_git_implementation_add';
export const githubNotificationImplementationCommitCallId =
  'call_agent_system_git_implementation_commit';

export const githubNotificationImplementationCandidate =
  "This assignment asks for one exact repository fixture. I'm going to confirm the prepared worktree, create only that file, validate its contents, and commit the bounded change for lifecycle delivery.";

export const githubNotificationImplementationAssignmentFinalResponse = [
  '## Assessment',
  '',
  'The requested implementation fixture is bounded and the prepared worktree is ready for the scheduled implementation turn.',
  '',
  '## Plan',
  '',
  'Create the exact root fixture, validate its contents and worktree state, then commit it once for managed lifecycle delivery.',
].join('\n');

export const githubNotificationImplementationFinalResponse = [
  '## Implementation',
  '',
  'Created the requested root fixture with the exact assigned contents.',
  '',
  '## Validation',
  '',
  'Confirmed the bounded file change before staging it.',
  '',
  '## Delivery',
  '',
  'Created one local commit in the prepared lifecycle worktree for managed delivery.',
].join('\n');

const assignmentPromptSignals = [
  'Continue the current GitHub issue lifecycle',
  'This is the initial planning turn for an assigned issue',
  'Before your final response, call `agent_system_github_reply` exactly once',
] as const;

const implementationPromptSignals = [
  'Continue the current GitHub issue lifecycle',
  'The public Work plan has a durable GitHub publication receipt',
  'pass the prepared worktree path as cwd on every call',
  'Do not call `agent_system_github_reply`',
] as const;

function messageText(message: ChatCompletionRequest['messages'][number]): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => (typeof part.text === 'string' ? part.text : '')).join('');
}

function requestText(request: ChatCompletionRequest): string {
  return request.messages.map(messageText).join('\n');
}

interface ImplementationContext {
  issueNumber: number;
  repository: string;
  worktreePath: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function implementationContext(request: ChatCompletionRequest): ImplementationContext {
  const source = requestText(request);
  for (const match of source.matchAll(/```json\s*([\s\S]*?)\s*```/gu)) {
    try {
      const payload = record(record(JSON.parse(match[1] ?? ''))?.payload);
      const item = record(payload?.item);
      const worktree = record(payload?.worktree);
      const issueNumber = item?.number;
      const repositoryName = item?.repositoryName;
      const repositoryOwner = item?.repositoryOwner;
      const worktreePath = worktree?.path;
      if (
        typeof issueNumber === 'number' &&
        Number.isSafeInteger(issueNumber) &&
        issueNumber > 0 &&
        typeof repositoryName === 'string' &&
        repositoryName.length > 0 &&
        typeof repositoryOwner === 'string' &&
        repositoryOwner.length > 0 &&
        typeof worktreePath === 'string' &&
        isAbsolute(worktreePath)
      ) {
        return {
          issueNumber,
          repository: `${repositoryOwner}/${repositoryName}`,
          worktreePath,
        };
      }
    } catch {
      continue;
    }
  }
  throw new Error('The implementation model request is missing its lifecycle context.');
}

function implementationFilename(request: ChatCompletionRequest): string {
  const filename = requestText(request).match(
    /\bimplementation-fixture-[0-9]+-[0-9]+\.txt\b/u,
  )?.[0];
  if (!filename) {
    throw new Error('The implementation issue response is missing its bounded filename.');
  }
  return filename;
}

function implementationToolResponse(
  request: ChatCompletionRequest,
  step: 'add' | 'commit' | 'inspect' | 'patch',
): ToolCallResponse {
  const { issueNumber, repository, worktreePath } = implementationContext(request);
  if (step === 'inspect') {
    return {
      id: 'agent-system-notification-implementation-issue-response',
      toolCalls: [
        {
          arguments: JSON.stringify({
            argv: [
              'issue',
              'view',
              String(issueNumber),
              '--repo',
              repository,
              '--json',
              'body',
              '--jq',
              '.body',
            ],
          }),
          id: githubNotificationImplementationIssueCallId,
          name: 'agent_system_github',
        },
      ],
    };
  }
  const filename = implementationFilename(request);
  if (step === 'patch') {
    return {
      id: 'agent-system-notification-implementation-patch-response',
      toolCalls: [
        {
          arguments: JSON.stringify({
            input: [
              '*** Begin Patch',
              `*** Add File: ${join(worktreePath, filename)}`,
              '+implementation fixture ready.',
              '*** End Patch',
            ].join('\n'),
          }),
          id: githubNotificationImplementationPatchCallId,
          name: 'apply_patch',
        },
      ],
    };
  }
  return {
    id: `agent-system-notification-implementation-${step}-response`,
    toolCalls: [
      {
        arguments: JSON.stringify({
          argv:
            step === 'add'
              ? ['add', '--', filename]
              : ['commit', '-m', 'add implementation fixture'],
          cwd: worktreePath,
        }),
        id:
          step === 'add'
            ? githubNotificationImplementationAddCallId
            : githubNotificationImplementationCommitCallId,
        name: 'agent_system_git',
      },
    ],
  };
}

const fixtures: Fixture[] = [
  {
    match: {
      hasToolResult: false,
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      systemMessage: [...assignmentPromptSignals],
      toolName: 'agent_system_github_reply',
    },
    response: {
      id: 'agent-system-notification-implementation-reply-response',
      toolCalls: [
        {
          arguments: JSON.stringify({ body: githubNotificationImplementationCandidate }),
          id: githubNotificationImplementationReplyCallId,
          name: 'agent_system_github_reply',
        },
      ],
    },
  },
  {
    match: {
      hasToolResult: true,
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      predicate: (request) =>
        hasGitHubNotificationModelToolResult(
          request.messages,
          githubNotificationImplementationReplyCallId,
        ),
      systemMessage: [...assignmentPromptSignals],
    },
    response: {
      content: githubNotificationImplementationAssignmentFinalResponse,
      id: 'agent-system-notification-implementation-assignment-final-response',
    },
  },
  {
    match: {
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      predicate: (request) =>
        hasGitHubNotificationModelToolResult(
          request.messages,
          githubNotificationImplementationReplyCallId,
        ) &&
        !hasGitHubNotificationModelToolResult(
          request.messages,
          githubNotificationImplementationIssueCallId,
        ),
      systemMessage: [...implementationPromptSignals],
      toolName: 'agent_system_github',
    },
    response: (request) => implementationToolResponse(request, 'inspect'),
  },
  {
    match: {
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      predicate: (request) =>
        hasGitHubNotificationModelToolResult(
          request.messages,
          githubNotificationImplementationIssueCallId,
        ) &&
        !hasGitHubNotificationModelToolResult(
          request.messages,
          githubNotificationImplementationPatchCallId,
        ),
      systemMessage: [...implementationPromptSignals],
      toolName: 'apply_patch',
    },
    response: (request) => implementationToolResponse(request, 'patch'),
  },
  {
    match: {
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      predicate: (request) =>
        hasGitHubNotificationModelToolResult(
          request.messages,
          githubNotificationImplementationPatchCallId,
        ) &&
        !hasGitHubNotificationModelToolResult(
          request.messages,
          githubNotificationImplementationAddCallId,
        ),
      systemMessage: [...implementationPromptSignals],
      toolName: 'agent_system_git',
    },
    response: (request) => implementationToolResponse(request, 'add'),
  },
  {
    match: {
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      predicate: (request) =>
        hasGitHubNotificationModelToolResult(
          request.messages,
          githubNotificationImplementationAddCallId,
        ) &&
        !hasGitHubNotificationModelToolResult(
          request.messages,
          githubNotificationImplementationCommitCallId,
        ),
      systemMessage: [...implementationPromptSignals],
      toolName: 'agent_system_git',
    },
    response: (request) => implementationToolResponse(request, 'commit'),
  },
  {
    match: {
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      predicate: (request) =>
        hasGitHubNotificationModelToolResult(
          request.messages,
          githubNotificationImplementationCommitCallId,
        ),
      systemMessage: [...implementationPromptSignals],
    },
    response: {
      content: githubNotificationImplementationFinalResponse,
      id: 'agent-system-notification-implementation-final-response',
    },
  },
];

export const implementationScenario = {
  finalResponses: [
    githubNotificationImplementationAssignmentFinalResponse,
    githubNotificationImplementationFinalResponse,
  ],
  fixtures,
  id: 'implementation',
  model: {
    match: /^(?:aimock\/)?gpt-5\.5$/u,
    reference: 'aimock/gpt-5.5',
  },
  promptSignals: ['Continue the current GitHub issue lifecycle'],
  toolCalls: [
    {
      id: githubNotificationImplementationReplyCallId,
      name: 'agent_system_github_reply',
    },
    {
      id: githubNotificationImplementationIssueCallId,
      name: 'agent_system_github',
    },
    {
      id: githubNotificationImplementationPatchCallId,
      name: 'apply_patch',
    },
    {
      id: githubNotificationImplementationAddCallId,
      name: 'agent_system_git',
    },
    {
      id: githubNotificationImplementationCommitCallId,
      name: 'agent_system_git',
    },
  ],
};
