import assert from 'node:assert/strict';

import {
  getTextContent,
  type ChatCompletionRequest,
  type Fixture,
  type FixtureResponse,
} from '@copilotkit/aimock';

import waitForAssessmentRelease from './assessment-barrier.ts';
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
    if (text === undefined) return;
    let value = JSON.parse(text);
    while (typeof value === 'string') value = JSON.parse(value);
    return value;
  };
  const dispatch = (stage: string, args: unknown) => call(stage, 'agent_system_dispatch', args);
  if (prompt.includes('Fill initially available intake slots in one bounded pass.')) {
    const digest = /Policy digest: ([a-f0-9]{64})\b/u.exec(prompt)?.[1];
    if (!digest) return;
    const scan = result('scan');
    if (!scan) return call('scan', 'agent_system_intake', { action: 'scan', policyDigest: digest });
    if (scan.status === 'blocked') return { content: 'notification-intake-blocked' };
    if (scan.status !== 'ready') return;
    const terminal = (value: Record<string, unknown>) => {
      if (isBusy(value)) return { content: 'notification-intake-busy' };
      if (['idle', 'at-capacity', 'pass-completed', 'blocked'].includes(String(value.status)))
        return { content: `notification-intake-${value.status}` };
    };
    // indexed calls bind each repeated stage to its own native result.
    for (let index = 0; index <= messages.length; index++) {
      const stage = (name: string) => `${name}-${index}`;
      const next = result(stage('next'));
      if (!next) return dispatch(stage('next'), { action: 'next' });
      const stopped = terminal(next);
      if (stopped) return stopped;
      if (typeof next.id !== 'string' || !/^[a-f0-9]{64}$/u.test(next.id)) return;
      let advanced = next;
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
        const prepared = result(stage('prepare'));
        if (!prepared)
          return dispatch(stage('prepare'), {
            action: 'prepare',
            id: next.id,
            digest: next.digest,
            assessment: { complexity: 'low', reason: 'A bounded disposable documentation plan.' },
            fallback: 'default',
            title: 'Document disposable test issue cleanup',
          });
        advanced = prepared;
      } else if (next.status === 'reconcile-required') {
        const reconciled = result(stage('reconcile'));
        if (!reconciled) return dispatch(stage('reconcile'), { action: 'reconcile', id: next.id });
        advanced = reconciled;
      }
      const stoppedAdvance = terminal(advanced);
      if (stoppedAdvance) return stoppedAdvance;
      if (
        ['assessment-required', 'session-created', 'working-turn-completed'].includes(
          String(advanced.status),
        )
      ) {
        const assessed = result(stage('assess'));
        if (!assessed) return dispatch(stage('assess'), { action: 'assess', id: next.id });
        advanced = assessed;
      }
      const stoppedAssessment = terminal(advanced);
      if (stoppedAssessment) return stoppedAssessment;
      if (
        !['assessment-pending', 'assessment-completed', 'working-turn-pending'].includes(
          String(advanced.status),
        )
      )
        return;
    }
    return;
  }
  const operatorId = /Operator request for managed issue ([a-f0-9]{64}):/u.exec(prompt)?.[1];
  if (operatorId) {
    const retry = prompt.includes('Reconcile the existing PR and show its card again.');
    const title = 'Document disposable notification fixture cleanup';
    const body = 'Document closing disposable test issues after their evidence is captured.';
    if (!retry) {
      const preview = result('handoff-preview');
      if (!preview)
        return dispatch('handoff-preview', {
          action: 'handoff',
          id: operatorId,
          permission: 'implementation-and-publication',
        });
      if (preview.status !== 'handoff-available' || typeof preview.digest !== 'string') return;
      const handed = result('handoff');
      if (!handed)
        return dispatch('handoff', {
          action: 'handoff',
          id: operatorId,
          permission: 'implementation-and-publication',
          digest: preview.digest,
        });
      if (handed.status !== 'handed-off') return;
      const context = result('work-context');
      if (!context)
        return dispatch('work-context', { action: 'implementation-context', id: operatorId });
      const path = (context.project as { path?: string } | undefined)?.path;
      if (
        context.status !== 'verified' ||
        context.runtime !== 'openclaw' ||
        !path ||
        context.publicationAuthorized !== true
      )
        return;
      const file = `notification-fixture-${operatorId}.md`;
      const patch = `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+Close disposable test issues after capturing their evidence.\n`;
      const steps = [
        { stage: 'apply', argv: ['apply', '-'], stdin: patch },
        { stage: 'add', argv: ['add', '--', file] },
        {
          stage: 'commit',
          argv: ['commit', '-m', 'document disposable issue cleanup', '--', file],
        },
      ];
      for (const step of steps) {
        const executed = result(step.stage);
        if (!executed)
          return call(step.stage, 'agent_system_git', {
            argv: step.argv,
            cwd: path,
            ...('stdin' in step ? { stdin: step.stdin } : {}),
          });
        if (executed.exitCode !== 0 || executed.truncated !== false) return;
      }
      const saved = result('work-result');
      if (!saved)
        return dispatch('work-result', {
          action: 'implementation-result',
          id: operatorId,
          implementationResult: {
            outcome: 'done',
            summary: 'Committed the disposable cleanup note.',
            fullResult:
              'Added and committed the one-line cleanup note through managed Git in the verified issue worktree.',
          },
        });
      if (saved.status !== 'recorded') return;
    }
    const prepared = result('delivery-prepare');
    if (!prepared)
      return dispatch('delivery-prepare', {
        action: 'delivery',
        operation: 'prepare',
        id: operatorId,
        title,
        body,
      });
    if (prepared.status !== 'prepared' || typeof prepared.digest !== 'string') return;
    const published = result('delivery-publish');
    if (!published)
      return dispatch('delivery-publish', {
        action: 'delivery',
        operation: 'publish',
        id: operatorId,
        digest: prepared.digest,
        title,
        body,
      });
    if (published.status !== 'published') return;
    const reconciled = result('delivery-reconcile');
    if (!reconciled)
      return dispatch('delivery-reconcile', {
        action: 'delivery',
        operation: 'reconcile',
        id: operatorId,
      });
    if (reconciled.status !== 'ready') return;
    const presented = result('delivery-present');
    if (!presented)
      return dispatch('delivery-present', {
        action: 'delivery',
        operation: 'present',
        id: operatorId,
      });
    if (presented.status !== 'presented' || typeof presented.presentation !== 'string') return;
    return { content: presented.presentation };
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

export const notificationExampleScenario: OpenClawAIMockScenario = {
  id: 'openclaw-notifications',
  model: { match: /^(?:aimock\/)?gpt-5\.5$/u, reference: 'aimock/gpt-5.5' },
  systemPromptSignals: [identity],
  finalResponses: [],
  dynamicFinalResponseFixtures: [final],
  toolCalls: [
    { id: prefix + 'scan', name: 'agent_system_intake' },
    ...[
      ...Array.from({ length: 8 }, (_, index) =>
        ['next', 'prepare', 'assess', 'reconcile'].map((stage) => `${stage}-${index}`),
      ).flat(),
      'context',
      'result',
      'handoff-preview',
      'handoff',
      'work-context',
      'work-result',
      'delivery-prepare',
      'delivery-publish',
      'delivery-reconcile',
      'delivery-present',
    ].map((stage) => ({
      id: prefix + stage,
      name: 'agent_system_dispatch',
    })),
    ...['git', 'apply', 'add', 'commit'].map((stage) => ({
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
      response: async (request) => {
        const value = response(request);
        assert.ok(value && 'toolCalls' in value);
        const context = value.toolCalls?.find((tool) => tool.id === prefix + 'context');
        if (context) await waitForAssessmentRelease(JSON.parse(context.arguments).id);
        return value;
      },
    },
    final,
  ],
};
