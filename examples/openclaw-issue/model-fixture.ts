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
const fullAssessment =
  'Disposable issues remain open after evidence capture. Keep cleanup after evidence capture. Add the cleanup rule to the repository documentation and review the resulting diff. Documentation-only change: existing notification checks are sufficient; no test changes or runtime changes are proposed.';
const reviewSummary =
  'Today you finish a test run with disposable issues still open. The guide would explain when to close them, so you can keep the evidence you need and leave a clean issue list. Documentation changes; existing tests will run, with no test changes proposed.';
const dispatchStages = [
  ...Array.from({ length: 8 }, (_, index) =>
    ['next', 'prepare', 'assess', 'reconcile'].map((stage) => `${stage}-${index}`),
  ).flat(),
  'context',
  'result',
  'detail-readback',
  'report',
  'refresh-context',
  'refresh-result',
  'recovery-present',
  'summary-compose',
  'summary-candidate',
  'summary-preview',
  'summary-publish',
  'summary-duplicate',
  'feedback-context',
  'feedback-result',
  'feedback-compose',
  'feedback-candidate',
  'feedback-preview',
  'feedback-publish',
  'direct-question-context',
  'manual-compose',
  'manual-candidate',
  'manual-preview',
  'manual-publish',
  'manual-reconcile',
];

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

function isContention(result: Record<string, unknown> | undefined) {
  return (
    ['busy', 'blocked', 'waiting'].includes(String(result?.status)) &&
    [
      'private-state-file-lock-busy',
      'private-state-snapshot-conflict',
      'discovery-checkpoint-changed',
    ].includes(String(result?.code))
  );
}

const retryStage = (stage: string, attempt: number) =>
  attempt ? `${stage}_retry_${attempt}` : stage;

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
  // repeat only known contention, preserving the operation and its retained arguments.
  const attempts = new Map<string, number>();
  const result = (stage: string): Record<string, unknown> | undefined => {
    for (let attempt = 0; attempt <= 3; attempt++) {
      const text = openClawAIMockToolResultText(messages, prefix + retryStage(stage, attempt));
      if (text === undefined) {
        attempts.set(stage, attempt);
        return undefined;
      }
      let value = JSON.parse(text);
      while (typeof value === 'string') value = JSON.parse(value);
      if (!dispatchStages.includes(stage) || !isContention(value)) return value;
      if (attempt === 3) throw new Error(`notification-retry-exhausted: ${value.code}`);
    }
    return undefined;
  };
  const dispatch = (stage: string, args: unknown) =>
    call(retryStage(stage, attempts.get(stage) ?? 0), 'agent_system_dispatch', args);
  const report = (): FixtureResponse | undefined => {
    const retained = result('report');
    if (!retained) return dispatch('report', { action: 'report' });
    if (retained.status !== 'reported' || typeof retained.response !== 'string') return;
    return { content: retained.response || 'notification-intake-unchanged' };
  };
  const summary = (
    id: string,
    saved: Record<string, unknown>,
    source: Record<string, unknown>,
  ): FixtureResponse | undefined => {
    if (saved.status !== 'recorded' || typeof saved.presentation !== 'string') return;
    const details = result('detail-readback');
    if (!details)
      return {
        ...dispatch('detail-readback', { action: 'present', id, includeDetails: true }),
        content: saved.presentation,
      };
    assert.equal(details.status, 'presented');
    assert.ok(String(details.presentation).includes('Managed Git confirmed this worktree.'));
    assert.ok(String(details.presentation).includes('Verified the managed worktree.'));
    if (typeof source.fullAssessment === 'string') {
      assert.ok(String(details.presentation).includes(source.fullAssessment));
      if (typeof source.reviewSummary === 'string') {
        assert.ok(saved.presentation.includes(source.reviewSummary));
        assert.ok(!saved.presentation.includes(source.fullAssessment));
      }
    }
    assert.ok(!saved.presentation.includes('Managed Git confirmed this worktree.'));
    assert.ok(!saved.presentation.includes('Verified the managed worktree.'));
    const args = { action: 'summary', id };
    const composed = result('summary-compose');
    if (!composed) return dispatch('summary-compose', { ...args, operation: 'compose' });
    const skill = (composed.selection as { skill?: { path?: string } } | undefined)?.skill;
    if (
      composed.status !== 'composition-ready' ||
      typeof composed.digest !== 'string' ||
      !skill?.path
    )
      return;
    if (openClawAIMockToolResultText(messages, prefix + 'summary-skill') === undefined)
      return call('summary-skill', 'read', { path: skill.path });
    const candidate = result('summary-candidate');
    if (!candidate)
      return dispatch('summary-candidate', {
        ...args,
        operation: 'candidate',
        digest: composed.digest,
        publicText:
          'Today disposable test issues can hang around after a run. The plan is to explain when to close them, so you can keep the results you need without leaving a cluttered issue list. This is proposed documentation work; implementation has not started.',
      });
    if (candidate.status !== 'candidate-recorded') return;
    const preview = result('summary-preview');
    if (!preview) return dispatch('summary-preview', { ...args, operation: 'publish' });
    if (preview.status !== 'publication-ready' || typeof preview.digest !== 'string') return;
    const published = result('summary-publish');
    if (!published)
      return dispatch('summary-publish', { ...args, operation: 'publish', digest: preview.digest });
    if (published.status !== 'published' || typeof published.presentation !== 'string') return;
    const duplicate = result('summary-duplicate');
    if (!duplicate)
      return dispatch('summary-duplicate', {
        ...args,
        operation: 'publish',
        digest: preview.digest,
      });
    if (duplicate.status !== 'published') return;
    return { content: published.presentation };
  };
  const directTarget = /Direct reply draft target: (https:\/\/github\.com\/[^\s]+)/u.exec(
    prompt,
  )?.[1];
  if (directTarget) {
    const composed = result('manual-compose');
    if (!composed)
      return dispatch('manual-compose', {
        action: 'reply',
        operation: 'compose',
        target: directTarget,
        privateText:
          'The disposable manual reply fixture is ready. No implementation or test result is claimed.',
      });
    assert.equal(composed.status, 'composition-ready');
    assert.equal(composed.compositionContext, 'feedback/v1');
    assert.equal(composed.factsProvenance, 'operator-supplied');
    const selection = composed.selection as { skill: { path: string } };
    if (openClawAIMockToolResultText(messages, prefix + 'manual-skill') === undefined)
      return call('manual-skill', 'read', { path: selection.skill.path });
    const candidate = result('manual-candidate');
    if (!candidate)
      return dispatch('manual-candidate', {
        action: 'reply',
        operation: 'candidate',
        id: composed.id,
        digest: composed.digest,
        publicText:
          'The disposable manual reply fixture is ready. No implementation or test result is claimed.',
      });
    assert.equal(candidate.status, 'candidate-recorded');
    return { content: String(candidate.presentation) };
  }
  const directDraft = /Direct reply publish draft: ([a-f0-9]{64})/u.exec(prompt)?.[1];
  if (directDraft) {
    const preview = result('manual-preview');
    if (!preview)
      return dispatch('manual-preview', { action: 'reply', operation: 'publish', id: directDraft });
    assert.equal(preview.status, 'publication-ready');
    const published = result('manual-publish');
    if (!published)
      return dispatch('manual-publish', {
        action: 'reply',
        operation: 'publish',
        id: directDraft,
        digest: preview.digest,
      });
    assert.equal(published.status, 'published');
    const reconciled = result('manual-reconcile');
    if (!reconciled)
      return dispatch('manual-reconcile', {
        action: 'reply',
        operation: 'reconcile',
        id: directDraft,
      });
    assert.equal(reconciled.status, 'published');
    return { content: String(reconciled.presentation) };
  }
  const manual = prompt.includes('Advance previously admitted issue or feedback work.');
  if (manual || prompt.includes('Fill initially available intake slots in one bounded pass.')) {
    if (!manual && !prompt.includes('Consume saved discoveries')) {
      const digest = /Policy digest: ([a-f0-9]{64})\b/u.exec(prompt)?.[1];
      const scan = result('scan');
      if (!scan)
        return call('scan', 'agent_system_intake', {
          action: 'scan',
          ...(digest ? { policyDigest: digest } : {}),
        });
      if (scan.status === 'blocked') return report();
      if (scan.status !== 'ready') return;
    }
    const terminal = (value: Record<string, unknown>) => {
      if (
        ['idle', 'at-capacity', 'pass-completed', 'blocked', 'uncertain'].includes(
          String(value.status),
        )
      )
        return report();
    };
    // indexed calls bind each repeated stage to its own native result.
    for (let index = 0; index <= messages.length; index++) {
      const stage = (name: string) => `${name}-${index}`;
      const next = result(stage('next'));
      if (!next) return dispatch(stage('next'), { action: 'next' });
      if (next.status === 'discovery-progress') continue;
      if (next.nextAction === 'next') continue;
      const stopped = terminal(next);
      if (stopped) return stopped;
      if (
        ['feedback-pending', 'feedback-completed', 'feedback-queued'].includes(String(next.status))
      )
        continue;
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
      if (advanced.nextAction === 'next') continue;
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
      if (advanced.nextAction === 'next') continue;
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
  const questionId = /Explain retained plan for managed issue ([a-f0-9]{64})/u.exec(prompt)?.[1];
  if (questionId) {
    const context = result('direct-question-context');
    if (!context) return dispatch('direct-question-context', { action: 'context', id: questionId });
    if (context.status !== 'verified' || context.mode !== 'plan') return;
    const history = context.feedbackWork as Array<{ privateText?: string }>;
    assert.equal(history.length, 2);
    assert.ok(history.every((entry) => entry.privateText?.includes('disposable issue cleanup')));
    return { content: history[0]!.privateText! };
  }
  const recoveryId =
    /recover only the pending public assessment summary[\s\S]*?id ([a-f0-9]{64})/u.exec(
      prompt,
    )?.[1];
  if (recoveryId) {
    const shown = result('recovery-present');
    if (!shown) return dispatch('recovery-present', { action: 'present', id: recoveryId });
    if (shown.status !== 'presented') return;
    return summary(recoveryId, { ...shown, status: 'recorded' }, {});
  }
  const refreshId = /Refresh retained assessment for managed issue ([a-f0-9]{64})/u.exec(
    prompt,
  )?.[1];
  if (refreshId) {
    const privateContext = request.messages
      .map(({ content }) => getTextContent(content) ?? '')
      .join('\n');
    if (
      !privateContext.includes('Agent System model-only current-turn facts') ||
      !privateContext.includes('previousResultDigest')
    )
      return;
    const fresh = result('refresh-context');
    if (!fresh) return dispatch('refresh-context', { action: 'context', id: refreshId });
    const evidence = fresh.evidence as { body?: string } | undefined;
    if (
      fresh.status !== 'verified' ||
      !fresh.previousResult ||
      typeof fresh.previousResultDigest !== 'string' ||
      !evidence?.body?.includes('notification-hidden-later-fact')
    )
      return;
    const saved = result('refresh-result');
    if (!saved)
      return dispatch('refresh-result', {
        action: 'result',
        id: refreshId,
        previousResultDigest: fresh.previousResultDigest,
        result: {
          ...(fresh.previousResult as Record<string, unknown>),
          fullAssessment:
            String((fresh.previousResult as Record<string, unknown>).fullAssessment) +
            '\n\nFresh issue context verified after restart.',
        },
      });
    if (saved.status !== 'recorded' || typeof saved.presentation !== 'string') return;
    if (prompt.includes('leave summary pending')) return { content: saved.presentation };
    return summary(refreshId, saved, fresh.previousResult as Record<string, unknown>);
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
    const history = context.previousFeedbackWork as Array<{ privateText?: string }>;
    const source = context.source as { body: string };
    if (source.body.includes('using the earlier explanation')) {
      assert.equal(history.length, 1);
      assert.ok(history[0]!.privateText?.includes('disposable issue cleanup'));
    } else assert.deepEqual(history, []);
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
  if (
    !id ||
    !prompt.includes('Agent System: assess this admitted issue and retain its complete plan.')
  )
    return;
  const context = result('context');
  if (!context) {
    const privateContext = request.messages
      .map(({ content }) => getTextContent(content) ?? '')
      .join('\n');
    if (
      !privateContext.includes('Agent System model-only current-turn facts') ||
      !privateContext.includes('notification-hidden-initial-fact')
    )
      return;
    return dispatch('context', { action: 'context', id });
  }
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
        summary: 'Document disposable issue cleanup so test runs leave no abandoned issues.',
        assessment: 'Document disposable issue cleanup so test runs leave no abandoned issues.',
        plan: 'Add the cleanup rule to the repository documentation and review the resulting diff.',
        fullAssessment,
        reviewSummary,
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
  return summary(id, saved, { fullAssessment, reviewSummary });
}

function response(request: ChatCompletionRequest) {
  try {
    return respond(request);
  } catch (error) {
    if (
      error instanceof Error &&
      /^notification-retry-exhausted: (?:private-state-(?:file-lock-busy|snapshot-conflict)|discovery-checkpoint-changed)$/u.test(
        error.message,
      )
    )
      return { content: error.message };
    return undefined;
  }
}

const final: Fixture = {
  match: {
    model: /^(?:aimock\/)?gpt-5\.5$/u,
    systemMessage: [identity],
    predicate: (request) => {
      const value = response(request);
      return !!value && 'content' in value && !('toolCalls' in value);
    },
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
    { id: prefix + 'summary-skill', name: 'read' },
    ...dispatchStages.flatMap((stage) =>
      [0, 1, 2, 3].map((attempt) => ({
        id: prefix + retryStage(stage, attempt),
        name: 'agent_system_dispatch',
      })),
    ),
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
