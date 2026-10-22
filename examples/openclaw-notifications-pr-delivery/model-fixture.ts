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
  'recovery-present',
  'summary-compose',
  'summary-candidate',
  'summary-preview',
  'summary-publish',
  'report',
  'handoff-preview',
  'handoff',
  'work-context',
  'work-result',
  'delivery-prepare',
  'delivery-publish',
  'delivery-publish-refreshed',
  ...Array.from({ length: 3 }, (_, index) => [
    `delivery-link-prepare-${index}`,
    `delivery-link-publish-${index}`,
  ]).flat(),
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
  'feedback-delivery-compose',
  'feedback-delivery-candidate',
  'feedback-delivery-announce',
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

function isPendingDelivery(result: Record<string, unknown>) {
  return (
    result.status === 'waiting' &&
    ['github-delivery-linkage-unverified', 'github-delivery-head-not-observed'].includes(
      String(result.code),
    )
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
  const feedback = /operation context, id ([a-f0-9]{64}), eventId ([a-f0-9]{64})/u.exec(prompt);
  if (feedback) {
    const [, id, eventId] = feedback;
    const args = { action: 'feedback', id, eventId };
    const resume = prompt.includes('Resume the retained feedback reply only.');
    const context = result('feedback-context');
    if (!context)
      return dispatch('feedback-context', {
        ...args,
        operation: 'context',
        ...(resume ? { resume: true } : {}),
      });
    if (
      context.status !== 'verified' ||
      context.runtime !== 'openclaw' ||
      context.publication !== 'allowed'
    )
      return;
    const initial = context.issueStage === 'planning';
    if (!resume) {
      if (initial) {
        assert.equal(context.mode, 'plan');
        assert.equal(context.previousImplementation, undefined);
        assert.deepEqual(context.previousFeedbackWork, []);
      } else {
        assert.equal(context.mode, 'work');
        assert.equal((context.previousImplementation as { outcome?: string }).outcome, 'done');
        assert.equal((context.previousFeedbackWork as unknown[]).length, 1);
      }
      const work = result('feedback-work-context');
      if (!work)
        return dispatch('feedback-work-context', { ...args, operation: 'implementation-context' });
      const implementation = work.implementation as { skill?: { path?: string } } | undefined;
      if (
        work.status !== 'verified' ||
        typeof work.worktree !== 'string' ||
        !implementation?.skill?.path
      )
        return;
      assert.equal(work.issueStage, 'implementation');
      assert.equal((work.work as { decision?: unknown }).decision, undefined);
      assert.deepEqual(work.previousFeedbackWork, context.previousFeedbackWork);
      assert.deepEqual(work.previousImplementation, context.previousImplementation);
      if (
        openClawAIMockToolResultText(messages, prefix + 'feedback-implementation-skill') ===
        undefined
      )
        return call('feedback-implementation-skill', 'read', { path: implementation.skill.path });
      const branch = result('feedback-branch');
      if (!initial) {
        if (!branch)
          return call('feedback-branch', 'agent_system_git', {
            argv: ['branch', '--show-current'],
            cwd: work.worktree,
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
        : `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,3 @@\n Close disposable test issues after capturing their evidence.\n Verify the same PR and announcement after follow-up commits.\n+Keep feedback changes on the original PR.\n`;
      const steps = [
        ...(!initial
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
            cwd: work.worktree,
            ...('stdin' in step ? { stdin: step.stdin } : {}),
          });
        if (executed.exitCode !== 0 || executed.truncated !== false) return;
      }
      const completed = result('feedback-work-result');
      if (!completed)
        return dispatch('feedback-work-result', {
          ...args,
          operation: 'implementation-result',
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
      if (completed.status !== 'recorded') return;
      const title = 'Document disposable notification fixture cleanup';
      const body = 'Document closing disposable test issues after their evidence is captured.';
      const delivery = result('feedback-delivery-prepare');
      if (!delivery)
        return dispatch('feedback-delivery-prepare', {
          ...args,
          operation: 'delivery',
          deliveryOperation: 'prepare',
          ...(initial ? { title, body } : {}),
        });
      if (delivery.status !== 'prepared' || typeof delivery.digest !== 'string') return;
      let delivered = result('feedback-delivery-publish');
      if (!delivered)
        return dispatch('feedback-delivery-publish', {
          ...args,
          operation: 'delivery',
          deliveryOperation: 'publish',
          digest: delivery.digest,
          ...(initial ? { title, body } : {}),
        });
      for (let index = 0; index < 3 && isPendingDelivery(delivered); index++) {
        const prepared = result(`feedback-link-prepare-${index}`);
        if (!prepared)
          return dispatch(`feedback-link-prepare-${index}`, {
            ...args,
            operation: 'delivery',
            deliveryOperation: 'prepare',
            ...(initial ? { title, body } : {}),
          });
        if (prepared.status !== 'prepared' || typeof prepared.digest !== 'string') return;
        // feedback's waiting envelope may omit the receipt; preparation reads the saved operation.
        const operation = prepared.operation as Record<string, unknown> | undefined;
        const receipt = (operation?.pullRequest ?? delivered.pullRequest) as
          Record<string, unknown> | undefined;
        if (!receipt?.pullRequestNodeId || !receipt.pullRequestNumber) return;
        const published = result(`feedback-link-publish-${index}`);
        if (!published)
          return dispatch(`feedback-link-publish-${index}`, {
            ...args,
            operation: 'delivery',
            deliveryOperation: 'publish',
            digest: prepared.digest,
            ...(initial ? { title, body } : {}),
          });
        delivered = published;
      }
      if (isPendingDelivery(delivered))
        throw new Error(`notification-delivery-reconciliation-exhausted: ${delivered.code}`);
      if (delivered.status !== 'published') return;
      if (initial) {
        const composed = result('feedback-delivery-compose');
        if (!composed)
          return dispatch('feedback-delivery-compose', {
            ...args,
            operation: 'delivery',
            deliveryOperation: 'compose',
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
        if (!candidate)
          return dispatch('feedback-delivery-candidate', {
            ...args,
            operation: 'delivery',
            deliveryOperation: 'candidate',
            digest: composed.digest,
            publicText: 'Adds the disposable issue cleanup note.',
          });
        if (candidate.status !== 'announcement-prepared' || typeof candidate.digest !== 'string')
          return;
        const announced = result('feedback-delivery-announce');
        if (!announced)
          return dispatch('feedback-delivery-announce', {
            ...args,
            operation: 'delivery',
            deliveryOperation: 'announce',
            digest: candidate.digest,
          });
        if (announced.status !== 'announced') return;
      }
      const saved = result('feedback-result');
      if (!saved)
        return dispatch('feedback-result', {
          ...args,
          operation: 'result',
          privateText: initial
            ? 'Implemented the retained plan from approved feedback without an extra decision, checked the diff, and published its linked PR in the same chat and worktree.'
            : 'The approved feedback added a continuity note on the original branch. The diff check passed and the new commit was pushed to the same PR; the original assessment and announcement remain intact.',
        });
      if (saved.status !== 'recorded') return;
      if (!initial)
        return {
          content:
            'The pushed repair and private reply are retained. Awaiting the explicit reply-only continuation.',
        };
    }
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
        publicText: initial
          ? 'Implemented the agreed cleanup note, checked the diff, and published its linked PR.'
          : 'Added the requested note about keeping feedback changes on the original PR, checked the diff, and pushed the commit to this PR.',
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
  const operatorId = /Operator request for managed issue ([a-f0-9]{64}):/u.exec(prompt)?.[1];
  if (operatorId) {
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

    const update = prompt.includes(
      'Add a follow-up commit and update the existing PR title and body.',
    );
    const retry = prompt.includes('Show the saved plan and existing PR card again.');
    const title = update
      ? 'Document disposable notification fixture cleanup and verification'
      : 'Document disposable notification fixture cleanup';
    const body = update
      ? 'Document closing disposable test issues and verifying the retained delivery after follow-up commits.'
      : 'Document closing disposable test issues after their evidence is captured.';
    if (!retry) {
      const preview = result('handoff-preview');
      if (!preview)
        return dispatch('handoff-preview', {
          action: 'handoff',
          id: operatorId,
        });
      if (preview.status !== 'handoff-available' || typeof preview.digest !== 'string') return;
      const handed = result('handoff');
      if (!handed)
        return dispatch('handoff', {
          action: 'handoff',
          id: operatorId,
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
      const patch = update
        ? `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,2 @@\n Close disposable test issues after capturing their evidence.\n+Verify the same PR and announcement after follow-up commits.\n`
        : `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+Close disposable test issues after capturing their evidence.\n`;
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
      const handoff = saved.handoff as { next?: string; request?: Record<string, unknown> };
      if (saved.status !== 'recorded' || handoff?.next !== 'delivery') return;
      if (!result('delivery-prepare'))
        return dispatch('delivery-prepare', { ...handoff.request, title, body });
    }
    if (!retry) {
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
      let published = result('delivery-publish');
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
        if (!receipt?.pullRequestNodeId || !receipt.pullRequestNumber) return;
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
      if (published.status !== 'published') return;
      if (!update && published.workflowStatus !== 'partially-delivered')
        throw new Error('published pr must retain pending announcement as partial delivery');
    }
    if (!retry && !update) {
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
          publicText: 'Adds the disposable issue cleanup note.',
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
      return {
        content: 'Publication retained. Presentation intentionally deferred for recovery coverage.',
      };
    }
    if (retry) {
      const plan = result('assessment-present');
      if (!plan) return dispatch('assessment-present', { action: 'present', id: operatorId });
      if (plan.status !== 'presented' || typeof plan.presentation !== 'string') return;
    } else {
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
      content: [
        retry ? result('assessment-present')?.presentation : undefined,
        presented.presentation,
      ]
        .filter(Boolean)
        .join('\n\n'),
    };
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

function response(request: ChatCompletionRequest) {
  try {
    return respond(request);
  } catch (error) {
    if (
      error instanceof Error &&
      /^(?:notification-retry-exhausted: (?:private-state-(?:file-lock-busy|snapshot-conflict)|discovery-checkpoint-changed)|notification-delivery-reconciliation-exhausted: github-delivery-(?:linkage-unverified|head-not-observed))$/u.test(
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
    predicate: (request) => 'content' in (response(request) ?? {}),
  },
  response: (request) => {
    const value = response(request);
    assert.ok(value && 'content' in value);
    return value;
  },
};

export const prExampleScenario: OpenClawAIMockScenario = {
  id: 'openclaw-notifications-pr-delivery',
  model: { match: /^(?:aimock\/)?gpt-5\.5$/u, reference: 'aimock/gpt-5.5' },
  systemPromptSignals: [identity],
  finalResponses: [],
  dynamicFinalResponseFixtures: [final],
  toolCalls: [
    { id: prefix + 'scan', name: 'agent_system_intake' },
    { id: prefix + 'feedback-skill', name: 'read' },
    { id: prefix + 'feedback-implementation-skill', name: 'read' },
    { id: prefix + 'delivery-skill', name: 'read' },
    { id: prefix + 'summary-skill', name: 'read' },
    ...dispatchStages.flatMap((stage) =>
      [0, 1, 2, 3].map((attempt) => ({
        id: prefix + retryStage(stage, attempt),
        name: 'agent_system_dispatch',
      })),
    ),
    ...[
      'git',
      'apply',
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
