import assessmentSource from '../../scripts/aimock-assessment-source.ts';
import { currentFacts } from '../openclaw-pr-journey/model-fixture.ts';
import assert from 'node:assert/strict';

import {
  getTextContent,
  type ChatCompletionRequest,
  type Fixture,
  type FixtureResponse,
} from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const model = /^(?:aimock\/)?gpt-5\.(?:5|4-nano)$/u;
const prefix = 'call_pickup_';
const pickupStages = Array.from({ length: 16 }, (_, index) => `scan-${index}`);
const dispatchStages = [
  ...Array.from({ length: 8 }, (_, index) =>
    ['next', 'prepare', 'assess', 'reconcile'].map((stage) => `${stage}-${index}`),
  ).flat(),
  'context',
  'report',
];
const attemptStage = (stage: string, attempt: number) => `${stage}-${attempt}`;

/** model choices are fixed; identities, eligibility, assignment and work mode must come from tools. */
export function pickupResponse(request: ChatCompletionRequest): FixtureResponse | undefined {
  const messages = request.messages.slice(
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
  const prompt = messages
    .filter(({ role }) => role === 'user')
    .map(({ content }) => getTextContent(content) ?? '')
    .join('\n');
  const attempts = new Map<string, number>();
  const result = (stage: string): Record<string, unknown> | undefined => {
    for (let attempt = 0; attempt <= 3; attempt++) {
      const text = openClawAIMockToolResultText(messages, prefix + attemptStage(stage, attempt));
      if (text === undefined) {
        attempts.set(stage, attempt);
        return;
      }
      let value = JSON.parse(text);
      while (typeof value === 'string') value = JSON.parse(value);
      if (
        !['busy', 'blocked', 'waiting'].includes(value.status) ||
        ![
          'private-state-file-lock-busy',
          'private-state-snapshot-conflict',
          'discovery-checkpoint-changed',
        ].includes(value.code)
      )
        return value;
      assert.ok(attempt < 3, `pickup fixture contention exhausted: ${value.code}`);
    }
  };
  const call = (stage: string, name: string, args: unknown): FixtureResponse => ({
    toolCalls: [
      {
        id: prefix + attemptStage(stage, attempts.get(stage) ?? 0),
        name,
        arguments: JSON.stringify(args),
      },
    ],
  });
  const dispatch = (stage: string, args: unknown) => call(stage, 'agent_system_dispatch', args);

  if (prompt.includes('Run the activated issue pickup once.')) {
    let args: Record<string, unknown> = { action: 'pickup' };
    for (const stage of pickupStages) {
      const observed = result(stage);
      if (!observed) return call(stage, 'agent_system_intake', args);
      if (observed.status === 'discovering') {
        args = { action: 'pickup' };
        continue;
      }
      if (observed.status === 'selection-required') {
        assert.equal(observed.contextMaterials, undefined, 'two small candidates must fit inline');
        const candidates = observed.candidates as Array<{ nodeId: string; url: string }>;
        assert.equal(candidates.length, 2);
        assert.match(String(observed.guidance), /bounded cleanup clarification/u);
        const repositoryGuidance = observed.repositoryGuidance as Record<
          string,
          { content: string }
        >;
        assert.match(
          repositoryGuidance['tanaabased/big-test-bucket']!.content,
          /prefer fixture cleanup/u,
        );
        const chosen = [];
        for (const [index, candidate] of candidates.entries()) {
          const read = result(`selection-source-${index}`);
          if (!read)
            return call(`selection-source-${index}`, 'agent_system_github', {
              argv: ['issue', 'view', candidate.url, '--json', 'body,comments'],
            });
          assert.equal(read.exitCode, 0);
          assert.equal(read.truncated, false);
          const source = JSON.parse(String(read.stdout));
          if (String(source.body).includes('pickup-cleanup-clarification')) chosen.push(candidate);
        }
        assert.equal(chosen.length, 1);
        args = {
          action: 'pickup',
          selection: {
            issueNodeId: chosen[0]!.nodeId,
            shortlist: candidates.map(({ nodeId }) => nodeId),
            rationale: 'The bounded cleanup clarification is smaller than the redesign.',
          },
        };
        continue;
      }
      assert.ok(
        ['empty', 'assigned', 'allowance-reached'].includes(String(observed.status)),
        JSON.stringify(observed),
      );
      assert.equal(typeof observed.response, 'string');
      assert.match(String(observed.response), /📥/u);
      if (observed.status === 'assigned') {
        // cron history is a bounded summary; verify full guidance before returning the report.
        assert.match(String(observed.response), /Guidance source.*inline/u);
        assert.match(String(observed.response), /bounded cleanup clarification/u);
        assert.match(String(observed.response), /prefer fixture cleanup/u);
        assert.match(String(observed.response), /2 eligible/u);
      }
      return { content: String(observed.response) };
    }
    throw new Error('pickup fixture discovery budget exhausted');
  }

  if (prompt.includes('Advance previously admitted issue or feedback work.')) {
    for (let index = 0; index < 8; index++) {
      const stage = (name: string) => `${name}-${index}`;
      const next = result(stage('next'));
      if (!next) return dispatch(stage('next'), { action: 'next' });
      if (next.status === 'discovery-progress' || next.nextAction === 'next') continue;
      if (['idle', 'at-capacity', 'pass-completed'].includes(String(next.status))) break;
      assert.equal(typeof next.id, 'string');
      let advanced = next;
      if (next.status === 'routing-required') {
        const context = next.context as { source: string };
        assert.match(
          context.source,
          /^https:\/\/github\.com\/tanaabased\/big-test-bucket\/issues\/\d+$/u,
        );
        const read = assessmentSource({ evidence: context }, result, call, stage('routing-source'));
        if (read) return read;
        const prepared = result(stage('prepare'));
        if (!prepared)
          return dispatch(stage('prepare'), {
            action: 'prepare',
            target: next.target,
            assessment: {
              complexity: 'low',
              reason: 'A bounded disposable cleanup clarification.',
            },
            fallback: 'default',
            title: 'Clarify disposable issue cleanup',
          });
        advanced = prepared;
      } else if (next.status === 'reconcile-required') {
        const reconciled = result(stage('reconcile'));
        if (!reconciled)
          return dispatch(stage('reconcile'), { action: 'reconcile', target: next.target });
        advanced = reconciled;
      }
      if (advanced.nextAction === 'next') continue;
      if (['assessment-required', 'session-created'].includes(String(advanced.status))) {
        const assessed = result(stage('assess'));
        if (!assessed) return dispatch(stage('assess'), { action: 'assess', target: next.target });
        advanced = assessed;
      }
      assert.ok(
        ['assessment-pending', 'assessment-completed'].includes(String(advanced.status)),
        JSON.stringify(advanced),
      );
      break;
    }
    const report = result('report');
    if (!report) return dispatch('report', { action: 'report' });
    assert.equal(report.status, 'reported');
    assert.equal(typeof report.response, 'string');
    return { content: String(report.response) || 'pickup-intake-unchanged' };
  }

  const id =
    currentFacts(messages, false).stage === 'assessment'
      ? currentFacts(messages, false).receipt
      : undefined;
  if (!id) return;
  const context = currentFacts(messages);
  assert.equal(context.stage, 'assessment');
  assert.equal(context.status, 'verified', JSON.stringify(context));
  assert.equal(context.contextMaterials, undefined, 'ordinary assignment context must fit inline');
  assert.equal(context.mode, 'work', 'pickup must override ordinary plan mode');
  const project = context.project as { path: string };
  assert.equal(typeof project.path, 'string');
  const sourceRead = assessmentSource(context, result, call);
  if (sourceRead) return sourceRead;
  return { content: 'Should disposable issues close after evidence capture?' };
}

const final: Fixture = {
  match: { model, predicate: (request) => 'content' in (pickupResponse(request) ?? {}) },
  response(request) {
    const response = pickupResponse(request);
    assert.ok(response && 'content' in response);
    return response;
  },
};

export const issuePickupScenario: OpenClawAIMockScenario = {
  id: 'openclaw-project-picker',
  model: { match: model, reference: 'aimock/gpt-5.5' },
  systemPromptSignals: [],
  finalResponses: [],
  dynamicFinalResponseFixtures: [final],
  toolCalls: [
    ...Array.from({ length: 8 }, (_, index) => ({
      stage: `routing-source-${index}`,
      name: 'agent_system_github',
    })),
    ...['assessment-source', 'selection-source-0', 'selection-source-1'].map((stage) => ({
      stage,
      name: 'agent_system_github',
    })),
    ...pickupStages.map((stage) => ({ stage, name: 'agent_system_intake' })),
    ...dispatchStages.map((stage) => ({ stage, name: 'agent_system_dispatch' })),
  ].flatMap(({ stage, name }) =>
    [0, 1, 2, 3].map((attempt) => ({ id: prefix + attemptStage(stage, attempt), name })),
  ),
  fixtures: [
    {
      match: { model, predicate: (request) => 'toolCalls' in (pickupResponse(request) ?? {}) },
      response(request) {
        const response = pickupResponse(request);
        assert.ok(response && 'toolCalls' in response);
        return response;
      },
    },
    final,
  ],
};
