import { isAbsolute, join } from 'node:path';

import type { ChatCompletionRequest, Fixture, ToolCallResponse } from '@copilotkit/aimock';

import hasGitHubNotificationModelToolResult from './github-notification-model-tool-result.ts';

interface GitHubNotificationIssueWorkCallIds {
  add: string;
  commit: string;
  issue: string;
  patch: string;
  reply: string;
}

export interface GitHubNotificationIssueWorkScenarioOptions {
  assignmentFinalResponse: string;
  callIds: GitHubNotificationIssueWorkCallIds;
  candidate: string;
  commitMessage: string;
  fileContents: string;
  filenamePattern: RegExp;
  finalResponse: string;
  id: string;
  comment?: {
    finalResponse: string;
    replyCallId: string;
    replyTokenPattern: RegExp;
  };
}

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

const pullRequestOpenedPromptSignals = [
  'Continue the current GitHub issue lifecycle',
  'A delivery pull request has been linked to the current issue-owned work session',
  'Respond privately with one brief acknowledgment',
] as const;

export const githubNotificationPullRequestOpenedFinalResponse =
  'The delivery pull request is linked. Later issue or pull request comments will continue in this session and reply to their originating item.';

function messageText(message: ChatCompletionRequest['messages'][number]): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => (typeof part.text === 'string' ? part.text : '')).join('');
}

function requestText(request: ChatCompletionRequest): string {
  return request.messages.map(messageText).join('\n');
}

function commentReplyToken(
  request: ChatCompletionRequest,
  options: GitHubNotificationIssueWorkScenarioOptions,
): string {
  const token = requestText(request).match(options.comment?.replyTokenPattern ?? /$^/u)?.[0];
  if (!token) throw new Error(`The ${options.id} comment request is missing its reply token.`);
  return token;
}

interface IssueWorkContext {
  issueNumber: number;
  repository: string;
  worktreePath: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function issueWorkContext(request: ChatCompletionRequest): IssueWorkContext {
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
  throw new Error('The issue work model request is missing its lifecycle context.');
}

function issueWorkFilename(
  request: ChatCompletionRequest,
  options: GitHubNotificationIssueWorkScenarioOptions,
): string {
  const filename = requestText(request).match(options.filenamePattern)?.[0];
  if (!filename) {
    throw new Error(`The ${options.id} issue response is missing its bounded filename.`);
  }
  return filename;
}

function issueWorkToolResponse(
  request: ChatCompletionRequest,
  options: GitHubNotificationIssueWorkScenarioOptions,
  step: 'add' | 'commit' | 'inspect' | 'patch',
): ToolCallResponse {
  const { issueNumber, repository, worktreePath } = issueWorkContext(request);
  if (step === 'inspect') {
    return {
      id: `agent-system-notification-${options.id}-issue-response`,
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
          id: options.callIds.issue,
          name: 'agent_system_github',
        },
      ],
    };
  }
  const filename = issueWorkFilename(request, options);
  if (step === 'patch') {
    return {
      id: `agent-system-notification-${options.id}-patch-response`,
      toolCalls: [
        {
          arguments: JSON.stringify({
            input: [
              '*** Begin Patch',
              `*** Add File: ${join(worktreePath, filename)}`,
              `+${options.fileContents}`,
              '*** End Patch',
            ].join('\n'),
          }),
          id: options.callIds.patch,
          name: 'apply_patch',
        },
      ],
    };
  }
  return {
    id: `agent-system-notification-${options.id}-${step}-response`,
    toolCalls: [
      {
        arguments: JSON.stringify({
          argv: step === 'add' ? ['add', '--', filename] : ['commit', '-m', options.commitMessage],
          cwd: worktreePath,
        }),
        id: step === 'add' ? options.callIds.add : options.callIds.commit,
        name: 'agent_system_git',
      },
    ],
  };
}

/** Build one deterministic assignment and implementation turn for an issue work scenario. */
export default function createGitHubNotificationIssueWorkScenario(
  options: GitHubNotificationIssueWorkScenarioOptions,
) {
  const fixtures: Fixture[] = [
    {
      match: {
        hasToolResult: false,
        model: /^(?:aimock\/)?gpt-5\.5$/u,
        systemMessage: [...assignmentPromptSignals],
        toolName: 'agent_system_github_reply',
      },
      response: {
        id: `agent-system-notification-${options.id}-reply-response`,
        toolCalls: [
          {
            arguments: JSON.stringify({ body: options.candidate }),
            id: options.callIds.reply,
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
          hasGitHubNotificationModelToolResult(request.messages, options.callIds.reply),
        systemMessage: [...assignmentPromptSignals],
      },
      response: {
        content: options.assignmentFinalResponse,
        id: `agent-system-notification-${options.id}-assignment-final-response`,
      },
    },
    {
      match: {
        model: /^(?:aimock\/)?gpt-5\.5$/u,
        predicate: (request) =>
          !hasGitHubNotificationModelToolResult(request.messages, options.callIds.issue),
        systemMessage: [...implementationPromptSignals],
        toolName: 'agent_system_github',
      },
      response: (request) => issueWorkToolResponse(request, options, 'inspect'),
    },
    {
      match: {
        model: /^(?:aimock\/)?gpt-5\.5$/u,
        predicate: (request) =>
          hasGitHubNotificationModelToolResult(request.messages, options.callIds.issue) &&
          !hasGitHubNotificationModelToolResult(request.messages, options.callIds.patch),
        systemMessage: [...implementationPromptSignals],
        toolName: 'apply_patch',
      },
      response: (request) => issueWorkToolResponse(request, options, 'patch'),
    },
    {
      match: {
        model: /^(?:aimock\/)?gpt-5\.5$/u,
        predicate: (request) =>
          hasGitHubNotificationModelToolResult(request.messages, options.callIds.patch) &&
          !hasGitHubNotificationModelToolResult(request.messages, options.callIds.add),
        systemMessage: [...implementationPromptSignals],
        toolName: 'agent_system_git',
      },
      response: (request) => issueWorkToolResponse(request, options, 'add'),
    },
    {
      match: {
        model: /^(?:aimock\/)?gpt-5\.5$/u,
        predicate: (request) =>
          hasGitHubNotificationModelToolResult(request.messages, options.callIds.add) &&
          !hasGitHubNotificationModelToolResult(request.messages, options.callIds.commit),
        systemMessage: [...implementationPromptSignals],
        toolName: 'agent_system_git',
      },
      response: (request) => issueWorkToolResponse(request, options, 'commit'),
    },
    {
      match: {
        model: /^(?:aimock\/)?gpt-5\.5$/u,
        predicate: (request) =>
          hasGitHubNotificationModelToolResult(request.messages, options.callIds.commit),
        systemMessage: [...implementationPromptSignals],
      },
      response: {
        content: options.finalResponse,
        id: `agent-system-notification-${options.id}-final-response`,
      },
    },
    {
      match: {
        model: /^(?:aimock\/)?gpt-5\.5$/u,
        systemMessage: [...pullRequestOpenedPromptSignals],
      },
      response: {
        content: githubNotificationPullRequestOpenedFinalResponse,
        id: `agent-system-notification-${options.id}-pull-request-opened-final-response`,
      },
    },
  ];

  if (options.comment) {
    const comment = options.comment;
    fixtures.push(
      {
        match: {
          model: /^(?:aimock\/)?gpt-5\.5$/u,
          predicate: (request) =>
            comment.replyTokenPattern.test(requestText(request)) &&
            !hasGitHubNotificationModelToolResult(request.messages, comment.replyCallId),
          toolName: 'agent_system_github_reply',
        },
        response: (request): ToolCallResponse => ({
          id: `agent-system-notification-${options.id}-comment-reply-response`,
          toolCalls: [
            {
              arguments: JSON.stringify({
                body: `{{commenter}}, ${commentReplyToken(request, options)}`,
              }),
              id: comment.replyCallId,
              name: 'agent_system_github_reply',
            },
          ],
        }),
      },
      {
        match: {
          model: /^(?:aimock\/)?gpt-5\.5$/u,
          predicate: (request) =>
            comment.replyTokenPattern.test(requestText(request)) &&
            hasGitHubNotificationModelToolResult(request.messages, comment.replyCallId),
        },
        response: {
          content: comment.finalResponse,
          id: `agent-system-notification-${options.id}-comment-final-response`,
        },
      },
    );
  }

  return {
    finalResponses: [
      options.assignmentFinalResponse,
      options.finalResponse,
      githubNotificationPullRequestOpenedFinalResponse,
      ...(options.comment ? [options.comment.finalResponse] : []),
    ],
    fixtures,
    id: options.id,
    model: {
      match: /^(?:aimock\/)?gpt-5\.5$/u,
      reference: 'aimock/gpt-5.5',
    },
    systemPromptSignals: ['Continue the current GitHub issue lifecycle'],
    toolCalls: [
      { id: options.callIds.reply, name: 'agent_system_github_reply' },
      { id: options.callIds.issue, name: 'agent_system_github' },
      { id: options.callIds.patch, name: 'apply_patch' },
      { id: options.callIds.add, name: 'agent_system_git' },
      { id: options.callIds.commit, name: 'agent_system_git' },
      ...(options.comment
        ? [{ id: options.comment.replyCallId, name: 'agent_system_github_reply' }]
        : []),
    ],
  };
}
