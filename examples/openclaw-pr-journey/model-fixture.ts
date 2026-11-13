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
  ...['context', 'compose', 'candidate', 'publish'].map((stage) => `native-plan-${stage}`),
  'native-plan-render',
  'context',
  'result',
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
  'task-response',
  'feedback-context',
  'feedback-resume-context',
  'feedback-resume-context-repeat',
  'feedback-work-context',
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
  'feedback-compose',
  'feedback-candidate',
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

function isCompositionReadTimeout(stage: string, result: Record<string, unknown>) {
  const diagnostic = result.providerDiagnostic as Record<string, unknown> | undefined;
  return (
    ['delivery-compose', 'feedback-delivery-compose'].includes(stage) &&
    result.status === 'waiting' &&
    result.code === 'github-notification-response-bounded' &&
    diagnostic?.provider === 'github' &&
    diagnostic.classification === 'transport' &&
    diagnostic.httpStatus === null
  );
}

function isPendingDelivery(result: Record<string, unknown>) {
  return (
    isTransientDelivery(result) ||
    (['waiting', 'needs-attention'].includes(String(result.status)) &&
      result.code === 'github-delivery-head-not-observed')
  );
}

function deliveryObstacle(result: Record<string, unknown>): FixtureResponse | undefined {
  if (
    !['blocked', 'waiting', 'needs-attention', 'retrying', 'announcement-blocked'].includes(
      String(result.status),
    )
  )
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
  composeResponse?: boolean;
  assessmentSkill?: string;
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
        outcome: initialQuestion ? 'clarification-needed' : 'plan-ready',
        summary: plan,
        reviewSummary: plan,
        ...(initialQuestion ? { questions: [plan] } : {}),
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
        facts: [{ reference: target, text: plan }],
      },
    });
  assert.equal(composed.status, 'composition-ready');
  const skill = (composed.selection as { skill: { path: string } }).skill;
  if (!skillRead) return call('plan-reply-skill', 'read', { path: skill.path });
  const candidate = result('native-plan-candidate');
  if (!candidate)
    return dispatch('native-plan-candidate', {
      action: 'reply',
      operation: 'candidate',
      target,
      publicText: publicText(composed, plan),
    });
  assert.equal(candidate.publication, 'workflow-authorized');
  if (leavePending) return { content: String(rendered.presentation) };
  const published = result('native-plan-publish');
  if (!published)
    return dispatch('native-plan-publish', {
      action: 'reply',
      operation: 'publish',
      target,
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
  // repeat only known contention or read-only composition timeouts with unchanged arguments.
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
      if (
        !dispatchStages.includes(stage) ||
        (!isContention(value) && !isCompositionReadTimeout(stage, value))
      )
        return value;
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
  const nativePlan = (context: Record<string, unknown>) =>
    nativePlanResponse(
      context,
      result,
      dispatch,
      call,
      Boolean(openClawAIMockToolResultText(messages, prefix + 'plan-reply-skill')),
      options.initialQuestion,
    );
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
            title: 'Document disposable test issue cleanup',
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
      if (['assessment-required', 'session-created'].includes(String(advanced.status))) {
        const assessed = result(stage('assess'));
        if (!assessed) return dispatch(stage('assess'), { action: 'assess', target: next.target });
        advanced = assessed;
      }
      if (advanced.nextAction === 'next') continue;
      const stoppedAssessment = terminal(advanced);
      if (stoppedAssessment) return stoppedAssessment;
      if (!['assessment-pending', 'assessment-completed'].includes(String(advanced.status))) return;
    }
    return;
  }
  const retainedReply = /Publish retained reply: (\{[^\n]+\})/u.exec(prompt)?.[1];
  if (retainedReply) {
    const selected = JSON.parse(retainedReply) as { target: string; publicText: string };
    for (const stage of ['feedback-resume-context', 'feedback-resume-context-repeat']) {
      const context = result(stage);
      if (!context)
        return dispatch(stage, {
          action: 'feedback',
          operation: 'context',
          source: selected.target,
        });
      assert.equal(context.status, 'verified');
      assert.equal(context.replyTarget, selected.target);
    }
    const published = result('feedback-publish');
    if (!published)
      return dispatch('feedback-publish', { action: 'reply', operation: 'publish', ...selected });
    if (published.status !== 'published') return;
    return { content: String(published.presentation) };
  }
  const turnContext = currentFacts(messages, false);
  const privateFeedback = turnContext.feedback;
  if (privateFeedback) {
    const id = turnContext.receipt;
    const context = { ...turnContext, ...privateFeedback };
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
      const title = 'Document disposable notification fixture cleanup';
      const body = 'Document closing disposable test issues after their evidence is captured.';
      const delivery = result('feedback-delivery-prepare');
      if (!delivery)
        return dispatch('feedback-delivery-prepare', {
          action: 'delivery',
          operation: 'prepare',
          ...(initial ? { title, body } : {}),
        });
      if (delivery.status !== 'prepared') return;
      let delivered = result('feedback-delivery-publish');
      if (!delivered)
        return dispatch('feedback-delivery-publish', {
          action: 'delivery',
          operation: 'publish',
          ...(initial ? { title, body } : {}),
        });
      for (let index = 0; index < 3 && isPendingDelivery(delivered); index++) {
        const prepared = result(`feedback-link-prepare-${index}`);
        if (!prepared)
          return dispatch(`feedback-link-prepare-${index}`, {
            action: 'delivery',
            operation: 'prepare',
            ...(initial ? { title, body } : {}),
          });
        if (prepared.status !== 'prepared') return;
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
            operation: 'publish',
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
            operation: 'link',
          });
        assert.equal(linked.status, 'linked');
        assert.ok((linked.pullRequest as Record<string, unknown>)?.pullRequestNumber);
        const composed = result('feedback-delivery-compose');
        if (!composed)
          return dispatch('feedback-delivery-compose', {
            action: 'delivery',
            operation: 'compose',
          });
        const selection = composed.selection as { skill?: { path?: string } } | undefined;
        if (composed.status !== 'composition-ready') return deliveryObstacle(composed);
        if (!selection?.skill?.path) return;
        if (!openClawAIMockToolResultText(messages, prefix + 'delivery-skill'))
          return call('delivery-skill', 'read', { path: selection.skill.path });
        const candidate = result('feedback-delivery-candidate');
        const author = (context.source as { author?: { login?: string } } | undefined)?.author
          ?.login;
        if (!candidate)
          return dispatch('feedback-delivery-candidate', {
            action: 'delivery',
            operation: 'candidate',
            publicText: publicText(
              composed,
              `${author ? '@' + author + ' ' : ''}Implemented the agreed disposable issue cleanup note.`,
            ),
          });
        if (candidate.status !== 'announcement-prepared') return;
        const announced = result('feedback-delivery-announce');
        if (!announced)
          return dispatch('feedback-delivery-announce', {
            action: 'delivery',
            operation: 'announce',
          });
        if (announced.status !== 'announced') return deliveryObstacle(announced);
        const presented = result('feedback-delivery-present');
        if (!presented)
          return dispatch('feedback-delivery-present', {
            action: 'delivery',
            operation: 'present',
          });
        if (presented.status !== 'presented' || typeof presented.presentation !== 'string') return;
        return {
          content: [presented.presentation, announced.presentation].filter(Boolean).join('\n\n'),
        };
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
    const published = result('feedback-publish');
    if (!published) return dispatch('feedback-publish', { ...reply, operation: 'publish' });
    if (published.status !== 'published' || typeof published.presentation !== 'string') return;
    return { content: published.presentation };
  }
  const explicitOperatorId = /Operator request for managed issue ([a-f0-9]{64}):/u.exec(
    prompt,
  )?.[1];
  const id =
    (currentFacts(messages, false).stage === 'assessment'
      ? currentFacts(messages, false).receipt
      : undefined) ??
    /Call agent_system_dispatch with action context and id ([a-f0-9]{64})\b/u.exec(prompt)?.[1];
  let automaticId: string | undefined;
  if (id && !explicitOperatorId) {
    const context = currentFacts(messages);
    assert.equal(
      context.status,
      'verified',
      'the native hook must supply usable assessment context',
    );
    const project = context.project as { path?: unknown } | undefined;
    if (
      context.status !== 'verified' ||
      context.runtime !== 'openclaw' ||
      typeof project?.path !== 'string' ||
      !context.assessment ||
      !context.resultFormat
    )
      return;
    const git = result('git');
    if (!git) return call('git', 'agent_system_git', { argv: ['rev-parse', '--show-toplevel'] });
    if (git.exitCode !== 0 || String(git.stdout).trim() !== project.path || git.truncated !== false)
      return;
    const selection = context.assessment as {
      defaultSkill: boolean;
      skill: { name?: string; path: string };
      guidance?: { content?: string; path?: string };
    };
    if (options.assessmentSkill) assert.equal(selection.skill.name, options.assessmentSkill);
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
  const operatorId = automaticId ?? explicitOperatorId;
  if (operatorId) {
    const selectedPr =
      /Bind existing PR (https:\/\/github\.com\/[^\s]+\/pull\/[1-9][0-9]*)\./u.exec(prompt)?.[1];
    if (selectedPr) {
      const bound = result('binding-verify');
      if (!bound)
        return dispatch('binding-verify', {
          action: 'delivery',
          operation: 'bind',
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
    const retry = prompt.includes(
      'Show the plan from this conversation and existing PR card again.',
    );
    const preserveMetadata = prompt.includes('Preserve its title, body, base and draft state.');
    const title = update
      ? 'Document disposable notification fixture cleanup and verification'
      : 'Document disposable notification fixture cleanup';
    const body = update
      ? 'Document closing disposable test issues and verifying the retained delivery after follow-up commits.'
      : 'Document closing disposable test issues after their evidence is captured.';
    const publicationContent = preserveMetadata ? {} : { title, body };
    let published = result('delivery-publish');
    if (!retry) {
      const nativeWork = update;
      const context = nativeWork ? currentFacts(messages) : result('work-context');
      if (!context)
        return dispatch('work-context', {
          action: 'implementation-context',
          ...(automaticId
            ? {
                decision: { mode: 'work', reasons: ['The current cleanup scope is clear.'] },
              }
            : {}),
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
        assert.match(String(context.instructions), /latest authorized scope/u);
        assert.match(String(context.instructions), /preserves unrelated behavior/u);
        assert.match(String(context.instructions), /validation evidence/u);
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
          ...publicationContent,
        });
      if (prepared.status !== 'prepared') return;
      if (!published)
        return dispatch('delivery-publish', {
          action: 'delivery',
          operation: 'publish',
          ...publicationContent,
        });
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
            ...publicationContent,
          });
        if (retained.status !== 'prepared') return;
        const publishStage = `delivery-link-publish-${index}`;
        const reconciled = result(publishStage);
        if (!reconciled)
          return dispatch(publishStage, {
            action: 'delivery',
            operation: 'publish',
            ...publicationContent,
          });
        published = reconciled;
      }
      if (isPendingDelivery(published))
        throw new Error(`notification-delivery-reconciliation-exhausted: ${published.code}`);
      if (published.status !== 'published') return deliveryObstacle(published);
    }
    if (!retry && !update && !preserveMetadata) {
      if (options.explicitInitialLink) assert.equal(typeof published?.url, 'string');
      const linked = result('delivery-association');
      if (!linked)
        return dispatch('delivery-association', {
          action: 'delivery',
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
        });
      if (composed.status !== 'composition-ready') return deliveryObstacle(composed);
      const selection = composed.selection as { skill?: { path?: string } } | undefined;
      if (!selection?.skill?.path) return;
      if (!openClawAIMockToolResultText(messages, prefix + 'delivery-skill'))
        return call('delivery-skill', 'read', { path: selection.skill.path });
      const candidate = result('delivery-candidate');
      if (!candidate)
        return dispatch('delivery-candidate', {
          action: 'delivery',
          operation: 'candidate',
          publicText: publicText(composed, 'Adds the disposable issue cleanup note.'),
        });
      if (candidate.status !== 'announcement-prepared') return;
      const announced = result('delivery-announce');
      if (!announced)
        return dispatch('delivery-announce', {
          action: 'delivery',
          operation: 'announce',
        });
      if (announced.status !== 'announced') return deliveryObstacle(announced);
      if (!automaticId)
        return {
          content:
            'Publication retained. Presentation intentionally deferred for recovery coverage.',
        };
    }
    if (!retry && !preserveMetadata) {
      const repeated = result('delivery-repeat');
      if (!repeated)
        return dispatch('delivery-repeat', {
          action: 'delivery',
          operation: 'announce',
        });
      if (repeated.status !== 'announced') return;
    }
    const presented = result('delivery-present');
    if (!presented)
      return dispatch('delivery-present', {
        action: 'delivery',
        operation: 'present',
      });
    if (presented.status !== 'presented' || typeof presented.presentation !== 'string') return;
    if (!options.composeResponse)
      return {
        content: [
          presented.presentation,
          !retry && !update && !preserveMetadata
            ? result('delivery-announce')?.presentation
            : undefined,
        ]
          .filter(Boolean)
          .join('\n\n'),
      };
    const assembled = result('task-response');
    if (!assembled)
      return dispatch('task-response', {
        action: 'response',
        blocks: [{ section: 'work', markdown: 'Implementation and focused checks completed.' }],
      });
    if (assembled.status !== 'response-composed' || typeof assembled.presentation !== 'string')
      return;
    return {
      content: assembled.presentation + '\n\nAdditional prose after composition remains visible.',
    };
  }
}

function response(request: ChatCompletionRequest, options: PRFixtureOptions) {
  try {
    return respond(request, options);
  } catch (error) {
    if (
      error instanceof Error &&
      /^(?:notification-retry-exhausted: (?:private-state-(?:file-lock-busy|snapshot-conflict)|discovery-checkpoint-changed|github-notification-response-bounded)|notification-delivery-reconciliation-exhausted: github-delivery-(?:head-not-observed|github-request))$/u.test(
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
      { id: prefix + 'plan-reply-skill', name: 'read' },
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
  incorporateCollaborator: true,
});
