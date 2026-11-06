import assessmentSource from '../../scripts/aimock-assessment-source.ts';
import { nativePlanResponse } from '../openclaw-pr-journey/model-fixture.ts';
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
export const retainedPlan =
  'Add the cleanup rule after evidence is captured and review the diff.\n' +
  'Retained evidence: preserve disposable fixture cleanup timing.\n'.repeat(390);
const dispatchStages = [
  ...Array.from({ length: 8 }, (_, index) =>
    ['next', 'prepare', 'assess', 'reconcile'].map((stage) => `${stage}-${index}`),
  ).flat(),
  'context',
  'native-plan-render',
  'native-plan-context',
  'native-plan-compose',
  'native-plan-candidate',
  'native-plan-preview',
  'native-plan-publish',
  'report',
  'work-context',
  'work-result',
  ...Array.from({ length: 64 }, (_, i) => `work-material-${i}`),
  'summary-hold',
];

function currentTurn(request: ChatCompletionRequest) {
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
function respond(
  request: ChatCompletionRequest,
  interruptDecision: boolean,
  autoDecision: 'plan' | 'work',
): FixtureResponse | undefined {
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
  const hydrate = (
    context: Record<string, unknown>,
    owner: 'work' | 'summary' | 'assessment',
  ): FixtureResponse | undefined => {
    const materials = context.contextMaterials as
      | {
          fields: Array<{
            path: string[];
            request: Record<string, unknown>;
            digest: string;
            length: number;
          }>;
          aliases: Array<{ path: string[]; from: string[] }>;
        }
      | undefined;
    const locate = (path: string[]) => {
      let parent = context;
      for (const name of path.slice(0, -1)) {
        parent[name] ??= {};
        parent = parent[name] as Record<string, unknown>;
      }
      return { parent, name: path.at(-1)! };
    };
    let sequence = 0;
    for (const field of [...(materials?.fields ?? [])].sort(
      (a, b) => a.path.length - b.path.length,
    )) {
      let request: Record<string, unknown> | undefined = field.request;
      let text = '';
      while (request) {
        const stage = `${owner}-material-${sequence++}`;
        assert.ok(sequence <= 64);
        const page = result(stage);
        if (!page) return dispatch(stage, request);
        assert.equal(page.status, 'material');
        assert.ok(JSON.stringify(page).length < 64000);
        const value = page.materialPage as { offset: number; digest: string; text: string };
        assert.equal(value.offset, text.length);
        assert.equal(value.digest, field.digest);
        text += value.text;
        request = page.next as Record<string, unknown> | undefined;
      }
      assert.equal(text.length, field.length);
      const { parent, name } = locate(field.path);
      parent[name] = JSON.parse(text);
    }
    for (const alias of materials?.aliases ?? []) {
      const source = locate(alias.from);
      const destination = locate(alias.path);
      destination.parent[destination.name] = source.parent[source.name];
    }
    delete context.contextMaterials;
  };
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
        [
          'implementation-pending',
          'implementation-completed',
          'implementation-queued',
          'implementation-idle',
          'policy-held',
          'feedback-pending',
          'feedback-completed',
          'feedback-queued',
        ].includes(String(next.status))
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
          )
        )
          return;
        const read = assessmentSource({ evidence: context }, result, call, stage('routing-source'));
        if (read) return read;
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
  const decisionId = /Consider current plan for managed issue ([a-f0-9]{64}):/u.exec(prompt)?.[1];
  if (decisionId && interruptDecision && !prompt.includes('Resume the discussion.'))
    return {
      content: 'The discussion stopped before an implementation decision. Wait for native input.',
    };
  if (decisionId && autoDecision === 'plan')
    return {
      content:
        'Cleanup timing needs confirmation. Should cleanup happen after evidence is captured?',
    };
  const automaticId =
    decisionId ??
    /Continue plan for managed issue ([a-f0-9]{64}):/u.exec(prompt)?.[1] ??
    /Call agent_system_dispatch action implementation-context with id ([a-f0-9]{64})/u.exec(
      prompt,
    )?.[1];
  const answerId = /Answer for managed issue ([a-f0-9]{64}):/u.exec(prompt)?.[1];
  const operatorId = automaticId ?? answerId;
  if (operatorId) {
    const context = result('work-context');
    if (!context)
      return dispatch('work-context', {
        action: 'implementation-context',
        id: operatorId,
        ...(prompt.includes('Do not push or publish a PR.') ? { scope: 'local' } : {}),
        ...(decisionId
          ? {
              decision: {
                mode: 'work',
                reasons: ['The retained documentation plan is bounded and actionable.'],
              },
            }
          : {}),
      });
    const path = (context.project as { path?: string } | undefined)?.path;
    if (
      context.status !== 'verified' ||
      context.runtime !== 'openclaw' ||
      !path ||
      context.publicationAuthorized !== !prompt.includes('Do not push or publish a PR.')
    )
      return;
    const pendingMaterial = hydrate(context, 'work');
    if (pendingMaterial) return pendingMaterial;
    if (automaticId) return { content: 'Should cleanup happen after evidence is captured?' };
    if (
      answerId &&
      (!prompt.includes('Yes, after evidence is captured.') ||
        !prompt.includes('Do not push or publish a PR.'))
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
            'Committed the requested cleanup note change through managed Git in the verified issue worktree.',
        },
      });
    if (saved.status !== 'recorded' || typeof saved.presentation !== 'string') return;
    return { content: saved.presentation };
  }
  const id = /Call agent_system_dispatch with action context and id ([a-f0-9]{64})\b/u.exec(
    prompt,
  )?.[1];
  if (!id || !prompt.includes('Call agent_system_dispatch with action context and id ')) return;
  const context = result('context');
  if (!context) {
    const privateContext = request.messages
      .map(({ content }) => getTextContent(content) ?? '')
      .join('\n');
    if (!privateContext.includes('Agent System model-only current-turn facts')) return;
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
  return nativePlanResponse(
    context,
    result,
    dispatch,
    call,
    Boolean(openClawAIMockToolResultText(messages, prefix + 'summary-skill')),
  );
}

function response(
  request: ChatCompletionRequest,
  interruptDecision: boolean,
  autoDecision: 'plan' | 'work',
) {
  try {
    return respond(request, interruptDecision, autoDecision);
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

export function createProgressionScenario(
  id: string,
  interruptDecision = false,
  autoDecision: 'plan' | 'work' = 'work',
): OpenClawAIMockScenario {
  const respond = (request: ChatCompletionRequest) =>
    response(request, interruptDecision, autoDecision);
  const final: Fixture = {
    match: {
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      systemMessage: [identity],
      predicate: (request) => 'content' in (respond(request) ?? {}),
    },
    response: (request) => {
      const value = respond(request);
      assert.ok(value && 'content' in value);
      return value;
    },
  };

  return {
    id,
    model: { match: /^(?:aimock\/)?gpt-5\.5$/u, reference: 'aimock/gpt-5.5' },
    systemPromptSignals: [identity],
    finalResponses: [],
    dynamicFinalResponseFixtures: [final],
    toolCalls: [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: prefix + `routing-source-${index}`,
        name: 'agent_system_github',
      })),
      { id: prefix + 'summary-skill', name: 'read' },
      { id: prefix + 'scan', name: 'agent_system_intake' },
      ...dispatchStages.flatMap((stage) =>
        [0, 1, 2, 3].map((attempt) => ({
          id: prefix + retryStage(stage, attempt),
          name: 'agent_system_dispatch',
        })),
      ),
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
          predicate: (request) => 'toolCalls' in (respond(request) ?? {}),
        },
        response: (request) => {
          const value = respond(request);
          assert.ok(value && 'toolCalls' in value);
          return value;
        },
      },
      final,
    ],
  };
}

export const progressionExampleScenario = createProgressionScenario('openclaw-issue-progression');
