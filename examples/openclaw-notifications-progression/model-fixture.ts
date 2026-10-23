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
const dispatchStages = [
  ...Array.from({ length: 8 }, (_, index) =>
    ['next', 'prepare', 'assess', 'reconcile'].map((stage) => `${stage}-${index}`),
  ).flat(),
  'context',
  'result',
  'report',
  'refresh-context',
  'refresh-result',
  'work-context',
  'work-result',
  'recovery-present',
  'summary-compose',
  'summary-candidate',
  'summary-preview',
  'summary-publish',
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
  const summary = (id: string, presentation?: string): FixtureResponse | undefined => {
    if (!presentation) {
      const shown = result('recovery-present');
      if (!shown) return dispatch('recovery-present', { action: 'present', id });
      if (shown.status !== 'presented' || typeof shown.presentation !== 'string') return;
      presentation = shown.presentation;
    }
    const args = { action: 'summary', id };
    const composed = result('summary-compose');
    if (!composed)
      return {
        ...dispatch('summary-compose', { ...args, operation: 'compose' }),
        content: presentation,
      };
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
          'The plan is to document closing disposable test issues after capturing their evidence. The retained plan is ready for the configured workflow to continue.',
      });
    if (candidate.status !== 'candidate-recorded') return;
    const preview = result('summary-preview');
    if (!preview) return dispatch('summary-preview', { ...args, operation: 'publish' });
    if (preview.status !== 'publication-ready' || typeof preview.digest !== 'string') return;
    const published = result('summary-publish');
    if (!published)
      return dispatch('summary-publish', { ...args, operation: 'publish', digest: preview.digest });
    if (published.status !== 'published' || typeof published.presentation !== 'string') return;
    return { content: published.presentation };
  };
  const recoveryId =
    /recover only the pending public assessment summary[\s\S]*?id ([a-f0-9]{64})/u.exec(
      prompt,
    )?.[1];
  if (recoveryId) return summary(recoveryId);
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
  const decisionId = /Refresh agent_system_dispatch action context with id ([a-f0-9]{64})/u.exec(
    prompt,
  )?.[1];
  if (decisionId) {
    if (interruptDecision && !prompt.includes('Resume the unfinished Auto decision.'))
      return { content: 'The decision was interrupted before its result was recorded.' };
    const fresh = result('refresh-context');
    if (!fresh) return dispatch('refresh-context', { action: 'context', id: decisionId });
    if (fresh.status !== 'verified' || fresh.mode !== 'auto' || !fresh.previousResult) return;
    const saved = result('refresh-result');
    if (!saved)
      return dispatch('refresh-result', {
        action: 'result',
        id: decisionId,
        previousResultDigest: fresh.previousResultDigest,
        result: {
          ...(fresh.previousResult as Record<string, unknown>),
          decision: {
            mode: autoDecision,
            reasons: [
              autoDecision === 'plan'
                ? 'Cleanup timing needs operator confirmation before implementation.'
                : 'The retained documentation plan is bounded and actionable.',
            ],
          },
        },
      });
    if (saved.status !== 'recorded' || typeof saved.presentation !== 'string') return;
    if (autoDecision === 'plan') {
      assert.equal((saved.handoff as { next?: string } | undefined)?.next, 'planning');
      return summary(decisionId, saved.presentation);
    }
    if ((saved.handoff as { next?: string } | undefined)?.next !== 'implementation') return;
  }
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
      return dispatch('work-context', { action: 'implementation-context', id: operatorId });
    const path = (context.project as { path?: string } | undefined)?.path;
    if (
      context.status !== 'verified' ||
      context.runtime !== 'openclaw' ||
      !path ||
      context.publicationAuthorized !== true
    )
      return;
    if (context.pendingPublicResponse) {
      const pending = summary(operatorId);
      if (!pending || 'toolCalls' in pending) return pending;
    }
    if (automaticId) {
      const saved = result('work-result');
      if (!saved)
        return dispatch('work-result', {
          action: 'implementation-result',
          id: operatorId,
          implementationResult: {
            outcome: 'clarification-needed',
            summary: 'Confirm cleanup timing.',
            fullResult:
              'Reviewed the retained plan. No files changed; cleanup timing needs confirmation.',
            questions: ['Should cleanup happen after evidence is captured?'],
          },
        });
      if (saved.status !== 'recorded' || typeof saved.presentation !== 'string') return;
      return {
        content: [result('refresh-result')?.presentation, saved.presentation]
          .filter(Boolean)
          .join('\n\n'),
      };
    }
    if (
      answerId &&
      ((context.previousImplementationResult as { outcome?: string })?.outcome !==
        'clarification-needed' ||
        !prompt.includes('Yes, after evidence is captured.') ||
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
  return summary(id, saved.presentation);
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

export const progressionExampleScenario = createProgressionScenario(
  'openclaw-notifications-progression',
);
