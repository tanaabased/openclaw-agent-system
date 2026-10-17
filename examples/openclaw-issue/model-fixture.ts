import assert from 'node:assert/strict';

import {
  getTextContent,
  type ChatCompletionRequest,
  type Fixture,
  type FixtureResponse,
} from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const prefix = 'call_notifications_';
const identity = 'Name: Notification Tanaabot';

function currentTurn(request: ChatCompletionRequest) {
  return request.messages.slice(
    Math.max(
      0,
      request.messages.findLastIndex(
        ({ role, content }) =>
          role === 'user' &&
          !getTextContent(content)?.trimStart().startsWith('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>'),
      ),
    ),
  );
}

function isBusy(result: Record<string, unknown> | undefined) {
  return result?.status === 'busy' && result.code === 'private-state-file-lock-busy';
}

function call(stage: string, name: string, args: unknown): FixtureResponse {
  return { toolCalls: [{ id: prefix + stage, name, arguments: JSON.stringify(args) }] };
}

/** fixture judgment follows native structured results; it never manufactures their identities. */
function respond(request: ChatCompletionRequest): FixtureResponse | undefined {
  const messages = currentTurn(request);
  const prompt = messages
    .filter(({ role }) => role === 'user')
    .map(({ content }) => getTextContent(content) ?? '')
    .join('\n');
  const result = (stage: string): Record<string, unknown> | undefined => {
    const text = openClawAIMockToolResultText(messages, prefix + stage);
    return text === undefined ? undefined : JSON.parse(text);
  };
  const dispatch = (stage: string, args: unknown) => call(stage, 'agent_system_dispatch', args);
  const manual = prompt.includes('Advance previously admitted issue or feedback work.');
  if (manual || prompt.includes('Advance at most one new issue or feedback turn per run.')) {
    if (!manual) {
      const digest = /Policy digest: ([a-f0-9]{64})\b/u.exec(prompt)?.[1];
      if (!digest) return;
      const scan = result('scan');
      if (!scan)
        return call('scan', 'agent_system_intake', { action: 'scan', policyDigest: digest });
      if (scan.status !== 'ready') return;
    }
    const next = result('next');
    if (!next) return dispatch('next', { action: 'next' });
    if (isBusy(next)) return { content: 'notification-intake-busy' };
    if (['feedback-pending', 'feedback-completed', 'feedback-queued'].includes(String(next.status)))
      return { content: 'notification-feedback-advanced' };
    if (next.status === 'idle') return { content: 'notification-intake-idle' };
    if (typeof next.id !== 'string' || !/^[a-f0-9]{64}$/u.test(next.id)) return;
    if (next.status === 'routing-required') {
      const context = next.context as Record<string, unknown> | undefined;
      if (
        typeof next.digest !== 'string' ||
        !/^https:\/\/github\.com\/tanaabased\/big-test-bucket\/issues\/[1-9][0-9]*$/u.test(
          String(context?.source),
        ) ||
        !String(context?.body).includes('disposable Agent System notification-flow fixture')
      )
        return;
      const prepared = result('prepare');
      if (!prepared)
        return dispatch('prepare', {
          action: 'prepare',
          id: next.id,
          digest: next.digest,
          assessment: { complexity: 'low', reason: 'A bounded disposable documentation plan.' },
          fallback: 'default',
          title: 'Document disposable test issue cleanup',
        });
      if (isBusy(prepared)) return { content: 'notification-intake-busy' };
      if (prepared.status !== 'session-created') return;
    } else if (!['assessment-required', 'reconcile-required'].includes(String(next.status))) return;
    const stage = next.status === 'reconcile-required' ? 'reconcile' : 'assess';
    const advanced = result(stage);
    if (!advanced) return dispatch(stage, { action: stage, id: next.id });
    if (isBusy(advanced)) return { content: 'notification-intake-busy' };
    if (advanced.status === 'session-created' || advanced.status === 'working-turn-completed') {
      const assessed = result('assess');
      if (!assessed) return dispatch('assess', { action: 'assess', id: next.id });
      if (isBusy(assessed)) return { content: 'notification-intake-busy' };
      if (!['assessment-pending', 'assessment-completed'].includes(String(assessed.status))) return;
    } else if (!['assessment-pending', 'assessment-completed'].includes(String(advanced.status)))
      return;
    return { content: 'notification-intake-advanced' };
  }
  const feedback = /operation context, id ([a-f0-9]{64}), eventId ([a-f0-9]{64})/u.exec(prompt);
  if (feedback) {
    const [, id, eventId] = feedback;
    const args = { action: 'feedback', id, eventId };
    const context = result('feedback-context');
    if (!context) return dispatch('feedback-context', { ...args, operation: 'context' });
    if (
      context.status !== 'verified' ||
      context.runtime !== 'openclaw' ||
      context.publication !== 'allowed'
    )
      return;
    const saved = result('feedback-result');
    if (!saved)
      return dispatch('feedback-result', {
        ...args,
        operation: 'result',
        privateText:
          'The retained plan proposes documenting disposable issue cleanup after evidence is captured. This feedback turn explains the plan; implementation remains unstarted and no pull request has been created.',
      });
    if (saved.status !== 'recorded') return;
    const composition = result('feedback-compose');
    if (!composition) return dispatch('feedback-compose', { ...args, operation: 'compose' });
    const skill = (composition.selection as { skill?: { path?: string } } | undefined)?.skill;
    if (
      composition.status !== 'composition-ready' ||
      typeof composition.digest !== 'string' ||
      !skill?.path
    )
      return;
    if (openClawAIMockToolResultText(messages, prefix + 'feedback-skill') === undefined)
      return call('feedback-skill', 'read', { path: skill.path });
    const candidate = result('feedback-candidate');
    if (!candidate)
      return dispatch('feedback-candidate', {
        ...args,
        operation: 'candidate',
        digest: composition.digest,
        publicText:
          'The plan is to document closing disposable test issues after capturing their evidence. Implementation has not started.',
      });
    if (candidate.status !== 'candidate-recorded') return;
    const preview = result('feedback-preview');
    if (!preview) return dispatch('feedback-preview', { ...args, operation: 'publish' });
    if (preview.status !== 'publication-ready' || typeof preview.digest !== 'string') return;
    const published = result('feedback-publish');
    if (!published)
      return dispatch('feedback-publish', {
        ...args,
        operation: 'publish',
        digest: preview.digest,
      });
    if (published.status !== 'published' || typeof published.presentation !== 'string') return;
    return { content: published.presentation };
  }
  const id = /Call agent_system_dispatch with action context and id ([a-f0-9]{64})\b/u.exec(
    prompt,
  )?.[1];
  if (!id || !prompt.includes('Stop before implementation.')) return;
  const context = result('context');
  if (!context) return dispatch('context', { action: 'context', id });
  const project = context.project as { path?: unknown } | undefined;
  if (
    context.status !== 'verified' ||
    context.runtime !== 'openclaw' ||
    context.id !== id ||
    typeof project?.path !== 'string' ||
    !context.assessment ||
    context.resultContract !== 'assessment-result/v1'
  )
    return;
  const git = result('git');
  if (!git) return call('git', 'agent_system_git', { argv: ['rev-parse', '--show-toplevel'] });
  if (git.exitCode !== 0 || String(git.stdout).trim() !== project.path || git.truncated !== false)
    return;
  const saved = result('result');
  if (!saved)
    return dispatch('result', {
      action: 'result',
      id,
      result: {
        version: 1,
        outcome: 'plan-ready',
        summary: 'Document disposable issue cleanup.',
        assessment: 'The admitted issue requests a small documentation change.',
        planSummary: 'Describe closing disposable test issues after capturing evidence.',
        plan: 'Add the cleanup rule to the repository documentation and review the resulting diff.',
        fullAssessment:
          'Verified the assigned repository in its managed worktree. Add a short documentation rule to close disposable test issues after capturing evidence, then review the diff. No implementation or publication was performed.',
        evidence: [
          {
            source: project.path,
            status: 'observed',
            detail: 'Managed Git confirmed this worktree.',
          },
        ],
        progress: {
          completed: ['Verified the managed worktree.'],
          remaining: ['Implement after approval.'],
        },
      },
    });
  if (saved.status !== 'recorded' || typeof saved.presentation !== 'string') return;
  return { content: saved.presentation };
}

function response(request: ChatCompletionRequest) {
  try {
    return respond(request);
  } catch {
    return undefined;
  }
}

const final: Fixture = {
  match: {
    model: /^(?:aimock\/)?gpt-5\.5$/u,
    systemMessage: [identity],
    predicate: (request) => 'content' in (response(request) ?? {}),
  },
  response: (request) => {
    const value = response(request);
    assert.ok(value && 'content' in value);
    return value;
  },
};

export const issueExampleScenario: OpenClawAIMockScenario = {
  id: 'openclaw-issue',
  model: { match: /^(?:aimock\/)?gpt-5\.5$/u, reference: 'aimock/gpt-5.5' },
  systemPromptSignals: [identity],
  finalResponses: [],
  dynamicFinalResponseFixtures: [final],
  toolCalls: [
    { id: prefix + 'scan', name: 'agent_system_intake' },
    { id: prefix + 'feedback-skill', name: 'read' },
    ...[
      'next',
      'prepare',
      'assess',
      'reconcile',
      'context',
      'result',
      'feedback-context',
      'feedback-result',
      'feedback-compose',
      'feedback-candidate',
      'feedback-preview',
      'feedback-publish',
    ].map((stage) => ({
      id: prefix + stage,
      name: 'agent_system_dispatch',
    })),
    ...['git'].map((stage) => ({
      id: prefix + stage,
      name: 'agent_system_git',
    })),
  ],
  fixtures: [
    {
      match: {
        model: /^(?:aimock\/)?gpt-5\.5$/u,
        systemMessage: [identity],
        predicate: (request) => 'toolCalls' in (response(request) ?? {}),
      },
      response: (request) => {
        const value = response(request);
        assert.ok(value && 'toolCalls' in value);
        return value;
      },
    },
    final,
  ],
};
