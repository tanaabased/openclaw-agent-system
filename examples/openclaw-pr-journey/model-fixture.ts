import assessmentSource from '../../scripts/aimock-assessment-source.ts';
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
  ...['context', 'compose', 'candidate', 'preview', 'publish'].map(
    (stage) => `native-plan-${stage}`,
  ),
  'native-plan-render',
  'context',
  'result',
  'recovery-present',
  'summary-compose',
  'summary-candidate',
  'summary-preview',
  'summary-publish',
  'report',
  'discovery-inspect',
  'binding-verify',
  'work-context',
  'work-result',
  'delivery-prepare',
  'delivery-publish',
  'delivery-publish-refreshed',
  ...Array.from({ length: 3 }, (_, index) => [
    `delivery-link-prepare-${index}`,
    `delivery-link-publish-${index}`,
  ]).flat(),
  'delivery-association',
  'delivery-compose',
  'delivery-candidate',
  'delivery-announce',
  'delivery-repeat',
  'delivery-present',
  'assessment-present',
  'feedback-context',
  'feedback-work-context',
  'feedback-work-result',
  'feedback-delivery-prepare',
  'feedback-delivery-publish',
  ...Array.from({ length: 3 }, (_, index) => [
    `feedback-link-prepare-${index}`,
    `feedback-link-publish-${index}`,
  ]).flat(),
  'feedback-delivery-association',
  'feedback-delivery-compose',
  'feedback-delivery-candidate',
  'feedback-delivery-announce',
  'feedback-delivery-present',
  'feedback-result',
  'feedback-compose',
  'feedback-candidate',
  'feedback-preview',
  'feedback-publish',
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

export function currentFacts(messages: ChatCompletionRequest['messages'], required = true) {
  const context = messages
    .filter(({ role }) => role === 'user')
    .map(({ content }) => getTextContent(content) ?? '')
    .join('\n');
  const facts = /Agent System model-only current-turn facts \(keep private\):\n([^\n]+)/u.exec(
    context,
  )?.[1];
  if (required) assert.ok(facts, 'the native hook must retain task facts in the current turn');
  return facts ? JSON.parse(facts) : {};
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

function isTransientDelivery(result: Record<string, unknown>) {
  const diagnostic = result.providerDiagnostic as Record<string, unknown> | undefined;
  return (
    result.status === 'retrying' &&
    result.code === 'github-delivery-github-request' &&
    diagnostic?.classification === 'transport' &&
    [500, 502, 503, 504].includes(Number(diagnostic.httpStatus))
  );
}

function isPendingDelivery(result: Record<string, unknown>) {
  return (
    isTransientDelivery(result) ||
    (result.status === 'waiting' &&
      ['github-delivery-linkage-unverified', 'github-delivery-head-not-observed'].includes(
        String(result.code),
      ))
  );
}

function deliveryObstacle(result: Record<string, unknown>): FixtureResponse | undefined {
  if (!['blocked', 'waiting', 'needs-attention', 'retrying'].includes(String(result.status)))
    return;
  return {
    content: `notification-delivery-stopped: ${JSON.stringify({ status: result.status, code: result.code, providerDiagnostic: result.providerDiagnostic })}`,
  };
}

const retryStage = (stage: string, attempt: number) =>
  attempt ? `${stage}_retry_${attempt}` : stage;

function call(stage: string, name: string, args: unknown): FixtureResponse {
  return { toolCalls: [{ id: prefix + stage, name, arguments: JSON.stringify(args) }] };
}

interface PRFixtureOptions {
  explicitInitialLink?: boolean;
  initialQuestion?: boolean;
  incorporateCollaborator?: boolean;
  interruptFeedbackReply?: boolean;
  inspectDiscovery?: boolean;
}

function publicText(composed: Record<string, unknown>, text: string) {
  const selected = composed.selection as {
    defaultSkill: boolean;
    guidance?: { content?: string; path?: string };
  };
  if (selected.defaultSkill) return text;
  assert.match(selected.guidance!.content!, /Evidence first/u);
  return `Evidence first: ${text} Live interpretation remains untested.`;
}

export function nativePlanResponse(
  context: Record<string, unknown>,
  result: (stage: string) => Record<string, unknown> | undefined,
  dispatch: (stage: string, input: Record<string, unknown>) => FixtureResponse,
  call: (stage: string, name: string, input: Record<string, unknown>) => FixtureResponse,
  skillRead: boolean,
  initialQuestion = false,
  source: Record<string, unknown> = {},
  leavePending = false,
): FixtureResponse | undefined {
  const target = (context.evidence as { source?: string })?.source;
  assert.ok(target);
  const sourceRead = assessmentSource(context, result, call);
  if (sourceRead) return sourceRead;
  const plan =
    typeof source.reviewSummary === 'string'
      ? source.reviewSummary
      : initialQuestion
        ? 'Should disposable test issues be closed after capturing evidence?'
        : 'Add a short cleanup rule for disposable test issues, then check and commit the diff before creating the PR.';
  const rendered = result('native-plan-render');
  if (!rendered)
    return dispatch('native-plan-render', {
      action: 'assessment',
      operation: 'render',
      target,
      ...(context.presentationRequest as object),
      result: {
        version: 1,
        outcome: initialQuestion ? 'clarification-needed' : 'plan-ready',
        summary: plan,
        assessment: 'Disposable test issues need an explicit cleanup rule.',
        fullAssessment:
          'Inspected the existing test guidance. Add a cleanup rule after evidence capture, preserve evidence limits, review the diff and verify both runtimes. No deployment is needed.',
        reviewSummary: plan,
        ...(initialQuestion
          ? { questions: [plan] }
          : {
              plan: 'Update the disposable issue cleanup guidance, inspect the diff, commit it and create the authorized PR.',
            }),
        evidence: [],
        progress: {
          completed: ['Inspected test guidance.'],
          remaining: ['Apply the agreed cleanup rule.'],
        },
        ...source,
      },
    });
  assert.equal(rendered.status, 'formatted');
  assert.equal(rendered.retained, false);
  assert.ok(typeof rendered.presentation === 'string');
  for (const card of (context.presentationRequest as { cards?: string[] })?.cards ?? [])
    assert.ok(rendered.presentation.includes(card));
  const observed = result('native-plan-context');
  if (!observed)
    return {
      ...dispatch('native-plan-context', {
        action: 'reply',
        operation: 'context',
        purpose: 'status-update',
        target,
      }),
      content: String(rendered.presentation),
    };
  assert.equal(observed.status, 'status-update-context');
  const composed = result('native-plan-compose');
  if (!composed)
    return dispatch('native-plan-compose', {
      action: 'reply',
      operation: 'compose',
      purpose: 'status-update',
      target,
      privateText: plan,
      update: {
        observation: observed.observation,
        facts: [
          { key: 'initial-plan', reference: context.currentTurnId, revision: '1', text: plan },
        ],
      },
    });
  assert.equal(composed.status, 'composition-ready');
  const skill = (composed.selection as { skill: { path: string } }).skill;
  if (!skillRead) return call('summary-skill', 'read', { path: skill.path });
  const candidate = result('native-plan-candidate');
  if (!candidate)
    return dispatch('native-plan-candidate', {
      action: 'reply',
      operation: 'candidate',
      id: composed.id,
      digest: composed.digest,
      publicText: publicText(composed, plan),
    });
  assert.equal(candidate.publication, 'workflow-authorized');
  if (leavePending) return { content: String(rendered.presentation) };
  const preview = result('native-plan-preview');
  if (!preview)
    return dispatch('native-plan-preview', {
      action: 'reply',
      operation: 'publish',
      id: composed.id,
    });
  assert.equal(preview.status, 'publication-ready');
  const published = result('native-plan-publish');
  if (!published)
    return dispatch('native-plan-publish', {
      action: 'reply',
      operation: 'publish',
      id: composed.id,
      digest: preview.digest,
    });
  assert.equal(published.status, 'published');
  return { content: String(published.presentation) };
}

/** fixture judgment follows native structured results; it never manufactures their identities. */
function respond(
  request: ChatCompletionRequest,
  options: PRFixtureOptions,
): FixtureResponse | undefined {
  const messages = currentTurn(request);
  const prompt = messages
    .filter(({ role }) => role === 'user')
    .map(({ content }) => getTextContent(content) ?? '')
    .join('\n');
  if (prompt.includes('Explain the completed PR in this ordinary conversation.')) {
    const retained = currentFacts(messages);
    assert.equal(retained.previousImplementationResult, undefined);
    assert.ok(retained.pullRequest?.pullRequestNumber);
    assert.ok(retained.worktree);
    assert.ok(retained.branch);
    return {
      content: 'The linked PR contains the completed cleanup note. No further work was requested.',
    };
  }
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
  if (options.inspectDiscovery && prompt.includes('Inspect saved discovery for ')) {
    const target =
      /Inspect saved discovery for (https:\/\/github\.com\/[^\s]+\/issues\/[1-9][0-9]*)/u.exec(
        prompt,
      )?.[1];
    assert.ok(target);
    const inspected = result('discovery-inspect');
    if (!inspected) return dispatch('discovery-inspect', { action: 'inspect', target, limit: 1 });
    assert.equal(inspected.status, 'ready');
    const records = inspected.records as Array<{ feedback?: { events?: unknown } }>;
    assert.equal(records.length, 1);
    assert.equal(records[0]!.feedback?.events, undefined);
    return { content: JSON.stringify(inspected) };
  }
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
        publicText: publicText(
          composed,
          'The plan is to document closing disposable test issues after capturing their evidence. The retained plan is ready for the configured workflow to continue.',
        ),
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
  const nativePlan = (context: Record<string, unknown>) =>
    nativePlanResponse(
      context,
      result,
      dispatch,
      call,
      Boolean(openClawAIMockToolResultText(messages, prefix + 'summary-skill')),
      options.initialQuestion,
    );
  const recoveryId =
    /recover only the pending public assessment summary[\s\S]*?id ([a-f0-9]{64})/u.exec(
      prompt,
    )?.[1];
  if (recoveryId) return summary(recoveryId);
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
      if (value.status === 'waiting' && typeof value.code === 'string' && !value.nextAction)
        return report();
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
  const retainedReply = /Publish retained reply draft: ([a-f0-9]{64})/u.exec(prompt)?.[1];
  if (retainedReply) {
    const args = { action: 'reply', id: retainedReply };
    const preview = result('feedback-preview');
    if (!preview) return dispatch('feedback-preview', { ...args, operation: 'publish' });
    if (preview.status !== 'publication-ready') return;
    const published = result('feedback-publish');
    if (!published)
      return dispatch('feedback-publish', {
        ...args,
        operation: 'publish',
        digest: preview.digest,
      });
    if (published.status !== 'published') return;
    return { content: String(published.presentation) };
  }
  const privateFeedback = currentFacts(messages, false).feedbackContextRequest;
  const feedback = privateFeedback
    ? ['', privateFeedback.id, privateFeedback.eventId]
    : /operation context, id ([a-f0-9]{64}), eventId ([a-f0-9]{64})/u.exec(prompt);
  if (feedback) {
    const [, id, eventId] = feedback;
    const args = { action: 'feedback', id, eventId };
    const context = result('feedback-context');
    if (!context)
      return dispatch('feedback-context', {
        ...args,
        operation: 'context',
      });
    if (
      context.status !== 'verified' ||
      context.runtime !== 'openclaw' ||
      context.publication !== 'allowed'
    )
      return;
    const initial = context.issueStage === 'planning';
    {
      assert.equal(context.mode, initial ? 'plan' : 'work');
      const work = initial ? result('feedback-work-context') : context;
      if (!work) return dispatch('feedback-work-context', { action: 'implementation-context' });
      const worktree = (work.project as { path?: string } | undefined)?.path;
      if (work.status !== 'verified' || !worktree) return;
      if (initial) {
        const implementation = work.implementation as { skill?: { path?: string } } | undefined;
        if (!implementation?.skill?.path) return;
        if (
          openClawAIMockToolResultText(messages, prefix + 'feedback-implementation-skill') ===
          undefined
        )
          return call('feedback-implementation-skill', 'read', { path: implementation.skill.path });
      }
      const branch = result('feedback-branch');
      if (!initial) {
        if (!branch)
          return call('feedback-branch', 'agent_system_git', {
            argv: ['branch', '--show-current'],
            cwd: worktree,
          });
        if (
          branch.exitCode !== 0 ||
          branch.truncated !== false ||
          typeof branch.stdout !== 'string' ||
          !branch.stdout.trim()
        )
          return;
      }
      const file = `notification-fixture-${id}.md`;
      const patch = initial
        ? `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+Close disposable test issues after capturing their evidence.\n`
        : `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,2 @@\n Close disposable test issues after capturing their evidence.\n+Keep feedback changes on the original PR.\n`;
      const steps = [
        ...(!initial && options.incorporateCollaborator
          ? [
              {
                stage: 'feedback-fetch',
                argv: ['fetch', 'origin', (branch!.stdout as string).trim()],
              },
              { stage: 'feedback-incorporate', argv: ['merge', '--ff-only', 'FETCH_HEAD'] },
            ]
          : []),
        { stage: 'feedback-apply', argv: ['apply', '-'], stdin: patch },
        { stage: 'feedback-check', argv: ['diff', '--check'] },
        { stage: 'feedback-add', argv: ['add', '--', file] },
        {
          stage: 'feedback-commit',
          argv: ['commit', '-m', 'document feedback update continuity', '--', file],
        },
      ];
      for (const step of steps) {
        const executed = result(step.stage);
        if (!executed)
          return call(step.stage, 'agent_system_git', {
            argv: step.argv,
            cwd: worktree,
            ...('stdin' in step ? { stdin: step.stdin } : {}),
          });
        if (executed.exitCode !== 0 || executed.truncated !== false) return;
      }
      const completed = result('feedback-work-result');
      if (initial && !completed)
        return dispatch('feedback-work-result', {
          action: 'implementation-result',
          id,
          implementationResult: {
            outcome: 'done',
            summary: initial
              ? 'Implemented the cleanup note.'
              : 'Added the feedback continuity note.',
            fullResult: initial
              ? 'Created the cleanup note, checked the diff, and committed the requested implementation.'
              : 'Updated the original note, checked the diff, and committed the feedback change.',
          },
        });
      if (initial && completed?.status !== 'recorded') return;
      const title = 'Document disposable notification fixture cleanup';
      const body = 'Document closing disposable test issues after their evidence is captured.';
      const delivery = result('feedback-delivery-prepare');
      if (!delivery)
        return dispatch('feedback-delivery-prepare', {
          action: 'delivery',
          id,
          operation: 'prepare',
          ...(initial ? { title, body } : {}),
        });
      if (delivery.status !== 'prepared' || typeof delivery.digest !== 'string') return;
      let delivered = result('feedback-delivery-publish');
      if (!delivered)
        return dispatch('feedback-delivery-publish', {
          action: 'delivery',
          id,
          operation: 'publish',
          digest: delivery.digest,
          ...(initial ? { title, body } : {}),
        });
      for (let index = 0; index < 3 && isPendingDelivery(delivered); index++) {
        const prepared = result(`feedback-link-prepare-${index}`);
        if (!prepared)
          return dispatch(`feedback-link-prepare-${index}`, {
            action: 'delivery',
            id,
            operation: 'prepare',
            ...(initial ? { title, body } : {}),
          });
        if (prepared.status !== 'prepared' || typeof prepared.digest !== 'string') return;
        // feedback's waiting envelope may omit the receipt; preparation reads the saved operation.
        const operation = prepared.operation as Record<string, unknown> | undefined;
        const receipt = (operation?.pullRequest ?? delivered.pullRequest) as
          Record<string, unknown> | undefined;
        if (
          !isTransientDelivery(delivered) &&
          (!receipt?.pullRequestNodeId || !receipt.pullRequestNumber)
        )
          return;
        const published = result(`feedback-link-publish-${index}`);
        if (!published)
          return dispatch(`feedback-link-publish-${index}`, {
            action: 'delivery',
            id,
            operation: 'publish',
            digest: prepared.digest,
            ...(initial ? { title, body } : {}),
          });
        delivered = published;
      }
      if (isPendingDelivery(delivered))
        throw new Error(`notification-delivery-reconciliation-exhausted: ${delivered.code}`);
      if (delivered.status !== 'published') return deliveryObstacle(delivered);
      if (initial) {
        const linked = result('feedback-delivery-association');
        if (!linked)
          return dispatch('feedback-delivery-association', {
            action: 'delivery',
            id,
            operation: 'link',
          });
        assert.equal(linked.status, 'linked');
        assert.ok((linked.pullRequest as Record<string, unknown>)?.pullRequestNumber);
        const composed = result('feedback-delivery-compose');
        if (!composed)
          return dispatch('feedback-delivery-compose', {
            action: 'delivery',
            id,
            operation: 'compose',
          });
        const selection = composed.selection as { skill?: { path?: string } } | undefined;
        if (
          composed.status !== 'composition-ready' ||
          typeof composed.digest !== 'string' ||
          !selection?.skill?.path
        )
          return;
        if (!openClawAIMockToolResultText(messages, prefix + 'delivery-skill'))
          return call('delivery-skill', 'read', { path: selection.skill.path });
        const candidate = result('feedback-delivery-candidate');
        const author = (context.source as { author?: { login?: string } } | undefined)?.author
          ?.login;
        if (!candidate)
          return dispatch('feedback-delivery-candidate', {
            action: 'delivery',
            id,
            operation: 'candidate',
            digest: composed.digest,
            publicText: publicText(
              composed,
              `${author ? '@' + author + ' ' : ''}Implemented the agreed disposable issue cleanup note.`,
            ),
          });
        if (candidate.status !== 'announcement-prepared' || typeof candidate.digest !== 'string')
          return;
        const announced = result('feedback-delivery-announce');
        if (!announced)
          return dispatch('feedback-delivery-announce', {
            action: 'delivery',
            id,
            operation: 'announce',
            digest: candidate.digest,
          });
        if (announced.status !== 'announced') return;
        const presented = result('feedback-delivery-present');
        if (!presented)
          return dispatch('feedback-delivery-present', {
            action: 'delivery',
            id,
            operation: 'present',
          });
        if (presented.status !== 'presented' || typeof presented.presentation !== 'string') return;
        return { content: presented.presentation };
      }
    }
    const privateText = initial
      ? 'Implemented the retained plan from approved feedback, checked the diff, and published its linked PR in the same chat and worktree.'
      : 'The approved feedback added a continuity note on the original branch. The diff check passed and the new commit was pushed to the same PR; the original assessment and announcement remain intact.';
    const composition = result('feedback-compose');
    if (!composition)
      return dispatch('feedback-compose', {
        action: 'reply',
        operation: 'compose',
        target: context.replyTarget,
        privateText,
      });
    const reply = { action: 'reply', id: composition.id };
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
        ...reply,
        operation: 'candidate',
        digest: composition.digest,
        publicText: publicText(
          composition,
          initial
            ? 'Implemented the agreed cleanup note, checked the diff, and published its linked PR.'
            : 'Added the requested note about keeping feedback changes on the original PR, checked the diff, and pushed the commit to this PR.',
        ),
      });
    if (candidate.status !== 'candidate-recorded') return;
    if (!initial && options.interruptFeedbackReply)
      return { content: privateText + '\n\nReply draft retained: ' + composition.id };
    const preview = result('feedback-preview');
    if (!preview) return dispatch('feedback-preview', { ...reply, operation: 'publish' });
    if (preview.status !== 'publication-ready' || typeof preview.digest !== 'string') return;
    const published = result('feedback-publish');
    if (!published)
      return dispatch('feedback-publish', {
        ...reply,
        operation: 'publish',
        digest: preview.digest,
      });
    if (published.status !== 'published' || typeof published.presentation !== 'string') return;
    return { content: published.presentation };
  }
  const id =
    (currentFacts(messages, false).contextRequest
      ? currentFacts(messages, false).receipt
      : undefined) ??
    /Call agent_system_dispatch with action context and id ([a-f0-9]{64})\b/u.exec(prompt)?.[1];
  let automaticId: string | undefined;
  if (id) {
    const context = result('context');
    if (!context) {
      const privateContext = request.messages
        .map(({ content }) => getTextContent(content) ?? '')
        .join('\n');
      if (!privateContext.includes('Agent System model-only current-turn facts')) return;
      return dispatch('context', { action: 'context' });
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
    const selection = context.assessment as {
      defaultSkill: boolean;
      skill: { path: string };
      guidance?: { content?: string; path?: string };
    };
    if (openClawAIMockToolResultText(messages, prefix + 'assessment-skill') === undefined)
      return call('assessment-skill', 'read', { path: selection.skill.path });
    if (!selection.defaultSkill) {
      assert.match(selection.guidance!.content!, /Preserve the evidence limit/u);
      assert.match(
        openClawAIMockToolResultText(messages, prefix + 'assessment-skill')!,
        /cleanup sequence/u,
      );
    }
    const published = nativePlan(context);
    if (
      !published ||
      'toolCalls' in published ||
      options.initialQuestion ||
      !['work', 'auto'].includes(String(context.mode))
    )
      return published;
    automaticId = id;
  }
  const operatorId =
    automaticId ?? /Operator request for managed issue ([a-f0-9]{64}):/u.exec(prompt)?.[1];
  if (operatorId) {
    const selectedPr =
      /Bind existing PR (https:\/\/github\.com\/[^\s]+\/pull\/[1-9][0-9]*)\./u.exec(prompt)?.[1];
    if (selectedPr) {
      const bound = result('binding-verify');
      if (!bound)
        return dispatch('binding-verify', {
          action: 'delivery',
          operation: 'bind',
          id: operatorId,
          pullRequest: selectedPr,
        });
      assert.equal(bound.status, 'bound');
      assert.equal(bound.retained, true);
    }

    if (prompt.includes('Preview reviewer delivery without publishing.')) {
      const prepared = result('delivery-prepare');
      if (!prepared)
        return dispatch('delivery-prepare', {
          action: 'delivery',
          operation: 'prepare',
          id: operatorId,
        });
      assert.equal(prepared.status, 'prepared');
      return { content: 'Reviewer delivery prepared without publication.' };
    }

    const secondUpdate = prompt.includes(
      'Add another follow-up commit and update the existing PR.',
    );
    const update =
      secondUpdate ||
      prompt.includes('Add a follow-up commit and update the existing PR title and body.');
    const retry = prompt.includes('Show the saved plan and existing PR card again.');
    const title = update
      ? 'Document disposable notification fixture cleanup and verification'
      : 'Document disposable notification fixture cleanup';
    const body = update
      ? 'Document closing disposable test issues and verifying the retained delivery after follow-up commits.'
      : 'Document closing disposable test issues after their evidence is captured.';
    let published = result('delivery-publish');
    if (!retry) {
      const nativeWork = update;
      const context = nativeWork ? currentFacts(messages) : result('work-context');
      if (!context)
        return dispatch('work-context', {
          ...(automaticId
            ? {
                action: 'implementation-context',
                decision: { mode: 'work', reasons: ['The current cleanup scope is clear.'] },
              }
            : { action: 'implementation', operation: 'context', id: operatorId }),
        });
      const path = nativeWork ? context.worktree : context.project?.path;
      if (!path) return;
      let customized = false;
      if (nativeWork) {
        assert.equal(context.receipt, operatorId);
        assert.ok(context.pullRequest?.pullRequestNumber);
        assert.ok(context.branch);
      } else {
        if (
          context.status !== 'verified' ||
          context.runtime !== 'openclaw' ||
          context.publicationAuthorized !== true
        )
          return;
        for (const key of ['resultContract', 'resultSchema', 'recording', 'handoff'])
          assert.equal(key in context, false);
        const selected = context.implementation as {
          defaultSkill: boolean;
          skill: { path: string };
          guidance?: { content?: string; path?: string };
        };
        if (openClawAIMockToolResultText(messages, prefix + 'implementation-skill') === undefined)
          return call('implementation-skill', 'read', { path: selected.skill.path });
        customized = !selected.defaultSkill;
        if (customized) {
          const guidance = selected.guidance!;
          if (
            guidance.path &&
            openClawAIMockToolResultText(messages, prefix + 'implementation-guidance') === undefined
          )
            return call('implementation-guidance', 'read', { path: guidance.path });
          assert.match(
            guidance.path
              ? openClawAIMockToolResultText(messages, prefix + 'implementation-guidance')!
              : guidance.content!,
            /Retain sanitized evidence/u,
          );
          assert.match(
            openClawAIMockToolResultText(messages, prefix + 'implementation-skill')!,
            /cleanup sequence/u,
          );
        }
      }
      const file = `notification-fixture-${operatorId}.md`;
      const patch = secondUpdate
        ? `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,3 @@\n Close disposable test issues after capturing their evidence.\n Verify the same PR and announcement after follow-up commits.\n+Keep completed results as history when accepting another revision.\n`
        : update
          ? `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,2 @@\n Close disposable test issues after capturing their evidence.\n+Verify the same PR and announcement after follow-up commits.\n`
          : `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${customized ? 2 : 1} @@\n+Close disposable test issues after capturing their evidence.\n${customized ? '+Retain sanitized evidence before cleanup.\n' : ''}`;
      const steps = [
        { stage: 'apply', argv: ['apply', '-'], stdin: patch },
        { stage: 'check', argv: ['diff', '--check'] },
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
      if (!published)
        return dispatch('delivery-publish', {
          action: 'delivery',
          operation: 'publish',
          id: operatorId,
          digest: prepared.digest,
          title,
          body,
        });
      if (published.status === 'prepared' && published.code === 'delivery-preview-stale') {
        if (typeof published.digest !== 'string') return;
        const refreshed = result('delivery-publish-refreshed');
        if (!refreshed)
          return dispatch('delivery-publish-refreshed', {
            action: 'delivery',
            operation: 'publish',
            id: operatorId,
            digest: published.digest,
            title,
            body,
          });
        published = refreshed;
      }
      for (let index = 0; index < 3 && isPendingDelivery(published); index++) {
        const receipt = published.pullRequest as Record<string, unknown> | undefined;
        if (
          !isTransientDelivery(published) &&
          (!receipt?.pullRequestNodeId || !receipt.pullRequestNumber)
        )
          return;
        const prepareStage = `delivery-link-prepare-${index}`;
        const retained = result(prepareStage);
        if (!retained)
          return dispatch(prepareStage, {
            action: 'delivery',
            operation: 'prepare',
            id: operatorId,
            title,
            body,
          });
        if (retained.status !== 'prepared' || typeof retained.digest !== 'string') return;
        const publishStage = `delivery-link-publish-${index}`;
        const reconciled = result(publishStage);
        if (!reconciled)
          return dispatch(publishStage, {
            action: 'delivery',
            operation: 'publish',
            id: operatorId,
            digest: retained.digest,
            title,
            body,
          });
        published = reconciled;
      }
      if (isPendingDelivery(published))
        throw new Error(`notification-delivery-reconciliation-exhausted: ${published.code}`);
      if (published.status !== 'published') return deliveryObstacle(published);
    }
    if (!retry && !update) {
      if (options.explicitInitialLink) assert.equal(typeof published?.url, 'string');
      const linked = result('delivery-association');
      if (!linked)
        return dispatch('delivery-association', {
          action: 'delivery',
          id: operatorId,
          operation: 'link',
          ...(options.explicitInitialLink ? { pullRequest: published?.url } : {}),
        });
      assert.equal(linked.status, 'linked');
      assert.ok((linked.pullRequest as Record<string, unknown>)?.pullRequestNumber);
      const composed = result('delivery-compose');
      if (!composed)
        return dispatch('delivery-compose', {
          action: 'delivery',
          operation: 'compose',
          id: operatorId,
        });
      if (composed.status !== 'composition-ready' || typeof composed.digest !== 'string') return;
      const selection = composed.selection as { skill?: { path?: string } } | undefined;
      if (!selection?.skill?.path) return;
      if (!openClawAIMockToolResultText(messages, prefix + 'delivery-skill'))
        return call('delivery-skill', 'read', { path: selection.skill.path });
      const candidate = result('delivery-candidate');
      if (!candidate)
        return dispatch('delivery-candidate', {
          action: 'delivery',
          operation: 'candidate',
          id: operatorId,
          digest: composed.digest,
          publicText: publicText(composed, 'Adds the disposable issue cleanup note.'),
        });
      if (candidate.status !== 'announcement-prepared' || typeof candidate.digest !== 'string')
        return;
      const announced = result('delivery-announce');
      if (!announced)
        return dispatch('delivery-announce', {
          action: 'delivery',
          operation: 'announce',
          id: operatorId,
          digest: candidate.digest,
        });
      if (announced.status !== 'announced') return;
      if (!automaticId)
        return {
          content:
            'Publication retained. Presentation intentionally deferred for recovery coverage.',
        };
    }
    if (!retry) {
      const repeated = result('delivery-repeat');
      if (!repeated)
        return dispatch('delivery-repeat', {
          action: 'delivery',
          operation: 'announce',
          id: operatorId,
        });
      if (repeated.status !== 'announced') return;
    }
    const presented = result('delivery-present');
    if (!presented)
      return dispatch('delivery-present', {
        action: 'delivery',
        operation: 'present',
        id: operatorId,
      });
    if (presented.status !== 'presented' || typeof presented.presentation !== 'string') return;
    return {
      content: presented.presentation,
    };
  }
}

function response(request: ChatCompletionRequest, options: PRFixtureOptions) {
  try {
    return respond(request, options);
  } catch (error) {
    if (
      error instanceof Error &&
      /^(?:notification-retry-exhausted: (?:private-state-(?:file-lock-busy|snapshot-conflict)|discovery-checkpoint-changed)|notification-delivery-reconciliation-exhausted: github-delivery-(?:linkage-unverified|head-not-observed|github-request))$/u.test(
        error.message,
      )
    )
      return { content: error.message };
    throw error;
  }
}

/** reuse the pr protocol while each scenario selects only its owned fault. */
export function createPRExampleScenario(
  id: string,
  options: PRFixtureOptions = {},
): OpenClawAIMockScenario {
  const runResponse = (request: ChatCompletionRequest) => response(request, options);
  const final: Fixture = {
    match: {
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      systemMessage: [identity],
      predicate: (request) => 'content' in (runResponse(request) ?? {}),
    },
    response: (request) => {
      const value = runResponse(request);
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
      { id: prefix + 'assessment-source', name: 'agent_system_github' },
      ...Array.from({ length: 8 }, (_, index) => ({
        id: prefix + `routing-source-${index}`,
        name: 'agent_system_github',
      })),
      { id: prefix + 'scan', name: 'agent_system_intake' },
      { id: prefix + 'feedback-skill', name: 'read' },
      { id: prefix + 'feedback-implementation-skill', name: 'read' },
      { id: prefix + 'delivery-skill', name: 'read' },
      { id: prefix + 'summary-skill', name: 'read' },
      { id: prefix + 'assessment-skill', name: 'read' },
      { id: prefix + 'implementation-skill', name: 'read' },
      { id: prefix + 'implementation-guidance', name: 'read' },
      ...dispatchStages.flatMap((stage) =>
        [0, 1, 2, 3].map((attempt) => ({
          id: prefix + retryStage(stage, attempt),
          name: 'agent_system_dispatch',
        })),
      ),
      ...[
        'git',
        'apply',
        'check',
        'add',
        'commit',
        'feedback-branch',
        'feedback-fetch',
        'feedback-incorporate',
        'feedback-apply',
        'feedback-check',
        'feedback-add',
        'feedback-commit',
      ].map((stage) => ({
        id: prefix + stage,
        name: 'agent_system_git',
      })),
    ],
    fixtures: [
      {
        match: {
          model: /^(?:aimock\/)?gpt-5\.5$/u,
          systemMessage: [identity],
          predicate: (request) => 'toolCalls' in (runResponse(request) ?? {}),
        },
        response: (request) => {
          const value = runResponse(request);
          assert.ok(value && 'toolCalls' in value);
          return value;
        },
      },
      final,
    ],
  };
}

export const prExampleScenario = createPRExampleScenario('openclaw-pr-journey', {
  initialQuestion: true,
});
