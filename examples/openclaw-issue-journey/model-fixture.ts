import assessmentSource from '../../scripts/aimock-assessment-source.ts';
import { currentFacts, nativePlanResponse } from '../openclaw-pr-journey/model-fixture.ts';
import assert from 'node:assert/strict';

import {
  getTextContent,
  type ChatCompletionRequest,
  type Fixture,
  type FixtureResponse,
} from '@copilotkit/aimock';

import { assessmentPresentationSchema } from '../../agent/assessment-result.ts';
import { dispatchModelParameters } from '../../tools/dispatch/tool-schema.ts';
import { Value } from 'typebox/value';

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
  'native-plan-render',
  'native-plan-context',
  'native-plan-compose',
  'native-plan-candidate',
  'native-plan-publish',
  'report',
  'refresh-context',
  'feedback-context',
  'feedback-compose',
  'feedback-candidate',
  'feedback-publish',
  'direct-assessment-context',
  'direct-assessment-result',
  'manual-compose',
  'manual-candidate',
  'manual-publish',
  'manual-reconcile',
  'update-context',
  'update-compose',
  'update-candidate',
];

function assessmentRequest(context: Record<string, unknown>, payload: object) {
  assert.ok(Value.Check(assessmentPresentationSchema, payload));
  const presentation = { ...(context.presentationRequest as Record<string, unknown>) };
  return {
    action: 'assessment',
    operation: 'render',
    target: context.target ?? (context.evidence as { source?: string })?.source,
    ...(context.entry === 'direct' ? { assessmentOnly: true } : {}),
    ...presentation,
    result: payload,
  };
}

export function currentTurn(request: ChatCompletionRequest) {
  return request.messages.slice(
    Math.max(
      0,
      request.messages.findLastIndex(
        ({ role, content }) =>
          role === 'user' &&
          !['<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>', 'OpenClaw runtime context:'].some((prefix) =>
            getTextContent(content)?.trimStart().startsWith(prefix),
          ),
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
  const nativePlan = (context: Record<string, unknown>, revised = false) =>
    nativePlanResponse(
      context,
      result,
      dispatch,
      call,
      Boolean(openClawAIMockToolResultText(messages, prefix + 'summary-skill')),
      false,
      {
        fullAssessment:
          fullAssessment + (revised ? '\nFresh issue context verified after restart.' : ''),
        reviewSummary:
          reviewSummary + (revised ? ' Fresh issue facts confirm the cleanup approach.' : ''),
        plan: fullAssessment,
      },
      prompt.includes('leave summary pending'),
    );
  const assessmentTarget =
    /Direct issue assessment target: (https:\/\/github\.com\/[^\s]+) checkout: ([^\n]+)/u.exec(
      prompt,
    );
  if (assessmentTarget) {
    const context = result('direct-assessment-context');
    if (!context)
      return dispatch('direct-assessment-context', {
        action: 'assessment',
        operation: 'context',
        target: assessmentTarget[1],
        path: assessmentTarget[2]!.trim(),
      });
    if (context.status === 'presented') {
      assert.equal((context.handoff as { next: string }).next, 'assessment-only');
      return { content: String(context.presentation) };
    }
    if (context.status === 'native') {
      assert.equal(typeof context.id, 'string');
      assert.equal((context.project as { path: string }).path, assessmentTarget[2]!.trim());
      const presentation = context.presentationRequest as { operation: string; target: string };
      assert.equal(presentation.operation, 'render');
      assert.equal(presentation.target, assessmentTarget[1]);
    } else {
      assert.equal(context.status, 'verified');
      assert.equal(context.entry, 'direct');
      assert.equal('id' in context, false);
    }
    const sourceRead = assessmentSource(context, result, call);
    if (sourceRead) return sourceRead;
    const selected = context.assessment as { skill: { path: string } };
    if (openClawAIMockToolResultText(messages, prefix + 'direct-assessment-skill') === undefined)
      return call('direct-assessment-skill', 'read', { path: selected.skill.path });
    const payload = {
      version: 1,
      outcome: 'plan-ready',
      summary: 'Assess cleanup documentation only.',
      assessment: fullAssessment,
      fullAssessment,
      plan: fullAssessment,
      reviewSummary,
    };
    const rejection = openClawAIMockToolResultText(messages, prefix + 'direct-assessment-invalid');
    if (rejection === undefined) {
      const malformed = assessmentRequest(context, payload);
      const incomplete: Partial<typeof payload> = { ...payload };
      delete incomplete.plan;
      return call('direct-assessment-invalid', 'agent_system_dispatch', {
        ...malformed,
        result: incomplete,
      });
    }
    const diagnostic = rejection.split('Received arguments:')[0]!;
    assert.match(diagnostic, /result\.plan/u);
    assert.doesNotMatch(diagnostic, /result\.questions|result\.remediation/u);
    const saved = result('direct-assessment-result');
    if (!saved) return dispatch('direct-assessment-result', assessmentRequest(context, payload));
    assert.equal(saved.status, 'formatted');
    assert.equal(saved.retained, false);
    return { content: String(saved.presentation) };
  }
  const updateTarget =
    /(?:Operator status update|Check current status) target: (https:\/\/github\.com\/[^\s]+)/u.exec(
      prompt,
    )?.[1];
  if (updateTarget) {
    const current = result('update-context');
    if (!current)
      return dispatch('update-context', {
        action: 'reply',
        operation: 'context',
        purpose: 'status-update',
        target: updateTarget,
      });
    assert.equal(current.status, 'status-update-context');
    const composeRequest = current.composeRequest;
    assert.ok(
      Value.Check(dispatchModelParameters, composeRequest) && composeRequest.action === 'reply',
    );
    assert.ok(composeRequest.update);
    assert.equal(composeRequest.target, updateTarget);
    const noOp = prompt.includes('Check current status target:');
    const composed = result('update-compose');
    if (!composed)
      return dispatch('update-compose', {
        ...composeRequest,
        privateText: noOp
          ? 'The issue already reflects the selected approach.'
          : 'The operator selected the shared reply approach. Implementation remains unstarted.',
        update: {
          ...composeRequest.update,
          facts: noOp
            ? []
            : [
                {
                  reference: 'current-chat:operator-decision',
                  text: 'The operator selected the shared reply approach. Implementation remains unstarted.',
                },
              ],
        },
      });
    if (noOp) {
      assert.equal(composed.status, 'already-current');
      return { content: String(composed.presentation) };
    }
    assert.equal(composed.status, 'composition-ready');
    assert.equal((composed.source as { kind: string }).kind, 'status-update');
    const selection = composed.selection as { skill: { path: string } };
    if (openClawAIMockToolResultText(messages, prefix + 'update-skill') === undefined)
      return call('update-skill', 'read', { path: selection.skill.path });
    const candidate = result('update-candidate');
    if (!candidate)
      return dispatch('update-candidate', {
        action: 'reply',
        operation: 'candidate',
        target: updateTarget,
        publicText:
          'The operator selected the shared reply approach. Implementation remains unstarted.',
      });
    assert.equal(candidate.status, 'candidate-recorded');
    return { content: String(candidate.presentation) };
  }
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
        target: directTarget,
        publicText:
          'The disposable manual reply fixture is ready. No implementation or test result is claimed.',
      });
    assert.equal(candidate.status, 'candidate-recorded');
    return { content: String(candidate.presentation) };
  }
  const directReply = /Direct reply publish: (\{[^\n]+\})/u.exec(prompt)?.[1];
  if (directReply) {
    const selected = JSON.parse(directReply) as { target: string; publicText: string };
    const published = result('manual-publish');
    if (!published)
      return dispatch('manual-publish', { action: 'reply', operation: 'publish', ...selected });
    assert.equal(published.status, 'published');
    const reconciled = result('manual-reconcile');
    if (!reconciled)
      return dispatch('manual-reconcile', { action: 'reply', operation: 'reconcile', ...selected });
    assert.equal(reconciled.status, 'published');
    return { content: String(reconciled.presentation) };
  }
  const manual = prompt.includes('Advance previously admitted issue or feedback work.');
  if (manual || prompt.includes('Fill initially available intake slots in one bounded pass.')) {
    if (!manual && !prompt.includes('Consume saved discoveries')) {
      const scan = result('scan');
      if (!scan)
        return call('scan', 'agent_system_intake', {
          action: 'scan',
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
          !/^https:\/\/github\.com\/tanaabased\/big-test-bucket\/issues\/[1-9][0-9]*$/u.test(
            String(context?.source),
          )
        )
          return;
        const read = assessmentSource({ evidence: context }, result, call, stage('routing-source'));
        if (read) return read;
        const prepared = result(stage('prepare'));
        if (!prepared)
          return dispatch(stage('prepare'), {
            action: 'prepare',
            target: next.target,
            assessment: { complexity: 'low', reason: 'A bounded disposable documentation plan.' },
            fallback: 'default',
            title: `big-test-bucket #${String(context?.source).split('/').at(-1)} — #${String(context?.source).split('/').at(-1)} Document disposable test issue cleanup`,
          });
        advanced = prepared;
      } else if (next.status === 'reconcile-required') {
        const reconciled = result(stage('reconcile'));
        if (!reconciled)
          return dispatch(stage('reconcile'), { action: 'reconcile', target: next.target });
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
        if (!assessed) return dispatch(stage('assess'), { action: 'assess', target: next.target });
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
    const history = request.messages.map(({ content }) => getTextContent(content) ?? '').join('\n');
    assert.ok(history.includes('disposable issue cleanup'));
    return {
      content:
        'The retained plan proposes documenting disposable issue cleanup after evidence is captured. Implementation remains unstarted.',
    };
  }
  const refreshId = /Refresh native assessment for managed issue ([a-f0-9]{64})/u.exec(prompt)?.[1];
  if (refreshId) {
    const privateContext = request.messages
      .map(({ content }) => getTextContent(content) ?? '')
      .join('\n');
    if (!privateContext.includes('Agent System model-only current-turn facts')) return;
    const fresh = result('refresh-context');
    if (!fresh) return dispatch('refresh-context', { action: 'context' });
    assert.equal(fresh.status, 'verified', JSON.stringify(fresh));
    assert.equal(fresh.contextMaterials, undefined, 'ordinary refreshed context must fit inline');
    const sourceRead = assessmentSource(fresh, result, call);
    if (sourceRead) return sourceRead;
    const evidence = JSON.parse(String(result('assessment-source')!.stdout));
    if (!evidence.body.includes('notification-hidden-later-fact')) return;
    return nativePlan(fresh, true);
  }
  const facts = currentFacts(messages, false);
  const available = facts.availableFeedback as
    | Array<{
        source: { number: number; itemType: string; commentId: number; kind: string };
        url?: string;
      }>
    | undefined;
  const incoming = prompt.split('Agent System model-only current-turn facts (keep private):')[0]!;
  const received = available?.filter(({ source }) =>
    incoming.includes(
      `/${source.itemType === 'issue' ? 'issues' : 'pull'}/${source.number}#${source.kind}${source.commentId}`,
    ),
  );
  const privateFeedback =
    facts.feedback ?? (received?.length === 1 ? { source: received[0]!.url } : undefined);
  if (privateFeedback) {
    const args = { action: 'feedback', ...(facts.feedback ? {} : privateFeedback) };
    const context = facts.feedback ? { ...facts, ...facts.feedback } : result('feedback-context');
    if (!context) {
      const privateContext = request.messages
        .map(({ content }) => getTextContent(content) ?? '')
        .join('\n');
      if (
        !privateContext.includes(
          '"contextProbe":{"version":1,"runtime":"openclaw","hook":"before_prompt_build"}',
        ) ||
        !privateContext.includes('"git":{"protocol":"ssh"}')
      )
        return;
      return dispatch('feedback-context', { ...args, operation: 'context' });
    }
    if (
      context.status !== 'verified' ||
      context.runtime !== 'openclaw' ||
      context.publication !== 'allowed'
    )
      return;
    const privateText =
      'The retained plan proposes documenting disposable issue cleanup after evidence is captured. This feedback turn explains the plan; implementation remains unstarted and no pull request has been created.';
    const composition = result('feedback-compose');
    if (!composition)
      return dispatch('feedback-compose', {
        action: 'reply',
        operation: 'compose',
        target: context.replyTarget,
        privateText,
      });
    const reply = { action: 'reply', target: context.replyTarget };
    const skill = (composition.selection as { skill?: { path?: string } } | undefined)?.skill;
    if (composition.status !== 'composition-ready' || !skill?.path) return;
    if (openClawAIMockToolResultText(messages, prefix + 'feedback-skill') === undefined)
      return call('feedback-skill', 'read', { path: skill.path });
    const candidate = result('feedback-candidate');
    if (!candidate)
      return dispatch('feedback-candidate', {
        ...reply,
        operation: 'candidate',
        publicText:
          'The plan is to document closing disposable test issues after capturing their evidence. Implementation has not started.',
      });
    if (candidate.status !== 'candidate-recorded') return;
    const published = result('feedback-publish');
    if (!published) return dispatch('feedback-publish', { ...reply, operation: 'publish' });
    if (published.status !== 'published' || typeof published.presentation !== 'string') return;
    return { content: published.presentation };
  }
  const revision = /(Clarify|Answer) ordinary assessment for managed issue ([a-f0-9]{64})/u.exec(
    prompt,
  );
  const id =
    revision?.[2] ??
    (currentFacts(messages, false).stage === 'assessment'
      ? currentFacts(messages, false).receipt
      : undefined) ??
    /Call agent_system_dispatch with action context and id ([a-f0-9]{64})\b/u.exec(prompt)?.[1];
  if (
    !id ||
    (!revision &&
      !(currentFacts(messages, false).stage === 'assessment') &&
      !prompt.includes('Call agent_system_dispatch with action context and id '))
  )
    return;
  const context = result('context');
  if (!context) {
    const privateContext = request.messages
      .map(({ content }) => getTextContent(content) ?? '')
      .join('\n');
    if (
      !privateContext.includes(
        '"contextProbe":{"version":1,"runtime":"openclaw","hook":"before_prompt_build"}',
      ) ||
      !privateContext.includes('"git":{"protocol":"ssh"}')
    )
      return;
    return call(retryStage('context', attempts.get('context') ?? 0), 'agent_system_context', {});
  }
  const project = context.project as { path?: unknown } | undefined;
  if (
    context.status !== 'verified' ||
    context.runtime !== 'openclaw' ||
    typeof project?.path !== 'string' ||
    !context.assessment ||
    !context.resultFormat
  )
    return;
  const method = (context.assessment as { skill?: { name?: string; path?: string } }).skill;
  if (method?.name === 'generic-assessment') {
    if (!method.path) return;
    const methodText = openClawAIMockToolResultText(messages, prefix + 'assessment-skill');
    if (methodText === undefined) return call('assessment-skill', 'read', { path: method.path });
    if (!methodText.includes('Generic Assessment')) return;
  }
  const git = result('git');
  if (!git) return call('git', 'agent_system_git', { argv: ['rev-parse', '--show-toplevel'] });
  if (git.exitCode !== 0 || String(git.stdout).trim() !== project.path || git.truncated !== false)
    return;
  if (revision?.[1] === 'Clarify')
    return { content: 'Should cleanup close the issue only after evidence capture?' };
  return nativePlan(context, Boolean(revision));
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
    throw error;
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
  id: 'openclaw-issue-journey',
  model: { match: /^(?:aimock\/)?gpt-5\.5$/u, reference: 'aimock/gpt-5.5' },
  systemPromptSignals: [identity],
  finalResponses: [],
  expectedInvalidToolCalls: [
    { id: prefix + 'direct-assessment-invalid', name: 'agent_system_dispatch' },
  ],
  dynamicFinalResponseFixtures: [final],
  toolCalls: [
    { id: prefix + 'assessment-source', name: 'agent_system_github' },
    ...Array.from({ length: 8 }, (_, index) => ({
      id: prefix + `routing-source-${index}`,
      name: 'agent_system_github',
    })),
    { id: prefix + 'scan', name: 'agent_system_intake' },
    { id: prefix + 'assessment-skill', name: 'read' },
    { id: prefix + 'direct-assessment-skill', name: 'read' },
    { id: prefix + 'direct-assessment-invalid', name: 'agent_system_dispatch' },
    { id: prefix + 'feedback-skill', name: 'read' },
    { id: prefix + 'summary-skill', name: 'read' },
    { id: prefix + 'update-skill', name: 'read' },
    ...dispatchStages.flatMap((stage) =>
      [0, 1, 2, 3].map((attempt) => ({
        id: prefix + retryStage(stage, attempt),
        name: stage === 'context' ? 'agent_system_context' : 'agent_system_dispatch',
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
