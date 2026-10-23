import assert from 'node:assert/strict';
import { join } from 'node:path';
import waitForAssessmentRelease from '../examples/openclaw-notifications-intake/assessment-barrier.ts';
import openclawIntakeJobs from '../agent/openclaw-intake-policy.ts';
import { intakeFixture } from './github-intake-fixture.ts';

import { matchFixture, type ChatCompletionRequest } from '@copilotkit/aimock';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { issueExampleScenario } from '../examples/openclaw-notifications-issue-journey/model-fixture.ts';
import { intakeExampleScenario } from '../examples/openclaw-notifications-intake/model-fixture.ts';
import { retirementExampleScenario } from '../examples/openclaw-notifications-retirement/model-fixture.ts';
import { progressionExampleScenario } from '../examples/openclaw-notifications-progression/model-fixture.ts';
import { prExampleScenario } from '../examples/openclaw-notifications-pr-delivery/model-fixture.ts';
import { dispatchParameters } from '../tools/dispatch/tool-schema.ts';
import { intakeParameters } from '../tools/intake/tool-schema.ts';

for (const scenario of [
  issueExampleScenario,
  prExampleScenario,
  progressionExampleScenario,
  intakeExampleScenario,
  retirementExampleScenario,
]) {
  const id = 'a'.repeat(64);
  const job = openclawIntakeJobs({
    schemaVersion: 1,
    agent: { id: 'receiver' },
    models: { default: { model: 'openai/gpt-6-luna', effort: 'medium' } },
    github: {
      username: 'receiver',
      notifications: { ...intakeFixture().policy, runtimes: ['openclaw'] },
    },
  })[0]!;
  assert.equal(job.payload.kind, 'prompt');
  const intakePrompt = job.payload.kind === 'prompt' ? job.payload.prompt : '';
  const digest = 'd'.repeat(64);

  const source = 'https://github.com/tanaabased/big-test-bucket/issues/123';

  function request(prompt: string): ChatCompletionRequest {
    return {
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: 'Name: Notification Tanaabot' },
        { role: 'user', content: prompt },
        ...(prompt.includes(
          'Agent System: assess this admitted issue and retain its complete plan.',
        )
          ? [
              {
                role: 'user' as const,
                content:
                  '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> Agent System model-only current-turn facts notification-hidden-initial-fact',
              },
            ]
          : []),
      ],
      tools: ['agent_system_intake', 'agent_system_dispatch', 'agent_system_git', 'read'].map(
        (name) => ({
          type: 'function',
          function: { name },
        }),
      ),
    };
  }

  function append(input: ChatCompletionRequest, stage: string, result: unknown) {
    input.messages.push({
      role: 'tool',
      tool_call_id: `call_notifications_${['next', 'prepare', 'assess', 'reconcile'].includes(stage) ? stage + '-0' : stage}_fc-native`,
      content: JSON.stringify(result),
    });
  }

  async function response(input: ChatCompletionRequest) {
    const fixture = matchFixture([...scenario.fixtures], input);
    assert.ok(fixture);
    return typeof fixture.response === 'function'
      ? await fixture.response(input)
      : fixture.response;
  }

  type Action = Static<typeof dispatchParameters> | { action: 'scan'; policyDigest: string };

  async function action<A extends Action['action']>(input: ChatCompletionRequest, expected: A) {
    const next = await response(input);
    assert.ok('toolCalls' in next && next.toolCalls?.length === 1);
    const call = next.toolCalls[0]!;
    const args = JSON.parse(call.arguments);
    assert.equal(args.action, expected);
    assert.ok(
      Value.Check(
        call.name === 'agent_system_intake' ? intakeParameters : dispatchParameters,
        args,
      ),
    );
    return args as Extract<Action, { action: A }>;
  }

  async function publishProgressionSummary(input: ChatCompletionRequest) {
    assert.equal((await action(input, 'summary')).operation, 'compose');
    append(input, 'summary-compose', {
      status: 'composition-ready',
      digest,
      selection: { skill: { path: '/tmp/SUMMARY.md' } },
    });
    const read = await response(input);
    assert.ok('toolCalls' in read);
    assert.equal(read.toolCalls?.[0]?.name, 'read');
    append(input, 'summary-skill', { text: 'Selected reply guidance' });
    const candidate = await action(input, 'summary');
    assert.equal(candidate.operation, 'candidate');
    assert.equal(candidate.digest, digest);
    append(input, 'summary-candidate', { status: 'candidate-recorded' });
    assert.equal((await action(input, 'summary')).digest, undefined);
    append(input, 'summary-preview', { status: 'publication-ready', digest: 'e'.repeat(64) });
    assert.equal((await action(input, 'summary')).digest, 'e'.repeat(64));
    append(input, 'summary-publish', {
      status: 'published',
      presentation: 'Published retained plan.',
    });
  }

  describe(`examples/${scenario.id} model fixture`, () => {
    if (scenario.id === 'openclaw-notifications-intake')
      it('should release only the assessment explicitly unblocked by the native scenario', async () => {
        const directory = '/tmp/notification-barrier-fixture';
        const files = new Set<string>();
        const listeners = new Set<() => void>();
        const boundary = {
          exists: (path: string) => files.has(path),
          observe: (_directory: string, changed: () => void) => {
            listeners.add(changed);
            return () => {
              listeners.delete(changed);
            };
          },
        };
        await waitForAssessmentRelease('no-hold', directory, boundary);
        files.add(join(directory, 'notification-assessments-held'));
        const first = waitForAssessmentRelease('first', directory, boundary);
        let secondReleased = false;
        const second = waitForAssessmentRelease('second', directory, boundary).then(() => {
          secondReleased = true;
        });
        files.add(join(directory, 'notification-assessment-released-first'));
        for (const listener of listeners) listener();
        await first;
        assert.equal(secondReleased, false);
        files.add(join(directory, 'notification-assessment-released-second'));
        for (const listener of listeners) listener();
        await second;
        assert.equal(listeners.size, 0);
        await waitForAssessmentRelease('first', directory, boundary);
      });

    it('should advance three distinct pending assessments using indexed string-wrapped native results', async () => {
      const input = request(intakePrompt);
      append(input, 'scan', JSON.stringify({ status: 'ready' }));
      for (let index = 0; index < 3; index++) {
        const receipt = String(index + 1).repeat(64);
        await action(input, 'next');
        append(
          input,
          `next-${index}`,
          JSON.stringify({
            status: 'routing-required',
            id: receipt,
            digest,
            context: { source, body: 'disposable Agent System notification-flow fixture' },
          }),
        );
        assert.equal((await action(input, 'prepare')).id, receipt);
        append(input, `prepare-${index}`, { status: 'session-created', id: receipt });
        assert.equal((await action(input, 'assess')).id, receipt);
        append(
          input,
          `assess-${index}`,
          JSON.stringify({ status: 'assessment-pending', id: receipt }),
        );
      }
      await action(input, 'next');
      append(input, 'next-3', { status: 'pass-completed' });
      await action(input, 'report');
      append(input, 'report', { status: 'reported', response: 'pass completed' });
      assert.deepEqual(await response(input), { content: 'pass completed' });
    });

    it('should continue after working turns and terminate on native capacity and blockers', async () => {
      for (const status of [
        'working-turn-pending',
        'working-turn-completed',
        'assessment-completed',
      ]) {
        const input = request(intakePrompt);
        append(input, 'scan', { status: 'ready' });
        append(input, 'next', { status: 'reconcile-required', id });
        append(input, 'reconcile', { status, id });
        if (status === 'working-turn-completed') {
          await action(input, 'assess');
          append(input, 'assess', { status: 'assessment-pending', id });
        }
        await action(input, 'next');
        append(input, 'next-1', { status: 'at-capacity' });
        await action(input, 'report');
        append(input, 'report', { status: 'reported', response: 'at capacity' });
        assert.deepEqual(await response(input), { content: 'at capacity' });
      }
    });

    it('should continue unrelated work after an item failure explicitly selects next', async () => {
      for (const status of ['blocked', 'waiting', 'retrying']) {
        const input = request(intakePrompt);
        append(input, 'scan', { status: 'ready' });
        append(input, 'next', { status, id, nextAction: 'next' });
        await action(input, 'next');
        append(input, 'next-1', { status: 'idle' });
        await action(input, 'report');
      }
    });

    it('should advance manually admitted work without requesting another intake scan', async () => {
      const input = request('Advance previously admitted issue or feedback work.');
      assert.deepEqual(await action(input, 'next'), { action: 'next' });
    });

    it('should carry native scan and routing receipts through preparation and assessment', async () => {
      const input = request(
        `Fill initially available intake slots in one bounded pass. Policy digest: ${digest}`,
      );
      assert.deepEqual(await action(input, 'scan'), { action: 'scan', policyDigest: digest });
      append(input, 'scan', { status: 'ready', admitted: 1 });
      await action(input, 'next');
      append(input, 'next', {
        status: 'routing-required',
        id,
        digest,
        context: { source, body: 'disposable Agent System notification-flow fixture' },
      });
      const prepared = await action(input, 'prepare');
      assert.equal(prepared.id, id);
      assert.equal(prepared.digest, digest);
      append(input, 'prepare', { status: 'session-created', id });
      assert.equal((await action(input, 'assess')).id, id);
      append(input, 'assess', { status: 'assessment-pending', id });
      await action(input, 'next');
      append(input, 'next-1', { status: 'pass-completed' });
      await action(input, 'report');
      append(input, 'report', { status: 'reported', response: '> ## 💡 Intake complete' });
      assert.deepEqual(await response(input), { content: '> ## 💡 Intake complete' });
      input.messages.push({
        role: 'user',
        content: `Fill initially available intake slots in one bounded pass. Policy digest: ${digest}`,
      });
      await action(input, 'scan');
    });

    it('should reconcile pending assessments and stop on native idle without fabricating work', async () => {
      for (const status of ['idle', 'reconcile-required']) {
        const input = request(
          `Fill initially available intake slots in one bounded pass. Policy digest: ${digest}`,
        );
        append(input, 'scan', { status: 'ready', admitted: 0 });
        append(input, 'next', { status, id });
        if (status === 'reconcile-required') {
          assert.equal((await action(input, 'reconcile')).id, id);
          append(input, 'reconcile', { status: 'assessment-completed', id });
          await action(input, 'next');
          append(input, 'next-1', { status: 'pass-completed' });
        }
        await action(input, 'report');
        append(input, 'report', { status: 'reported', response: '' });
        assert.deepEqual(await response(input), { content: 'notification-intake-unchanged' });
      }
    });

    for (const code of ['private-state-file-lock-busy', 'discovery-checkpoint-changed']) {
      it(`should retry waiting ${code} with the same arguments and a bounded budget`, async () => {
        const input = request('Advance previously admitted issue or feedback work.');
        await action(input, 'next');
        append(input, 'next', {
          status: 'waiting',
          code,
          runtime: 'openclaw',
          operation: 'dispatch:next',
        });
        for (let attempt = 1; attempt <= 3; attempt++) {
          const retry = await response(input);
          assert.ok('toolCalls' in retry && retry.toolCalls?.length === 1);
          assert.equal(retry.toolCalls[0]!.id, `call_notifications_next-0_retry_${attempt}`);
          assert.deepEqual(JSON.parse(retry.toolCalls[0]!.arguments), { action: 'next' });
          const recovered = structuredClone(input);
          append(recovered, `next-0_retry_${attempt}`, { status: 'idle' });
          await action(recovered, 'report');
          append(input, `next-0_retry_${attempt}`, { status: 'waiting', code });
        }
        assert.deepEqual(await response(input), {
          content: `notification-retry-exhausted: ${code}`,
        });
      });
    }

    it('should retry known coordinator contention three times before reporting the blocker', async () => {
      const routing = {
        status: 'routing-required',
        id,
        digest,
        context: { source, body: 'disposable Agent System notification-flow fixture' },
      };
      const paths: Array<Array<[string, unknown]>> = [
        [],
        [['next', routing]],
        [['next', { status: 'assessment-required', id }]],
        [['next', { status: 'reconcile-required', id }]],
        [
          ['next', { status: 'reconcile-required', id }],
          ['reconcile', { status: 'session-created', id }],
        ],
      ];
      for (const path of paths) {
        const input = request(
          `Fill initially available intake slots in one bounded pass. Policy digest: ${digest}`,
        );
        append(input, 'scan', { status: 'ready' });
        for (const [stage, result] of path) append(input, stage, result);
        const pending = await response(input);
        assert.ok('toolCalls' in pending && pending.toolCalls?.length === 1);
        const stage = pending.toolCalls[0]!.id!.replace('call_notifications_', '');
        append(input, stage, { status: 'busy', code: 'private-state-file-lock-busy', id });
        for (let attempt = 1; attempt <= 3; attempt++) {
          const retry = await response(input);
          assert.ok('toolCalls' in retry && retry.toolCalls?.length === 1);
          assert.equal(retry.toolCalls[0]!.arguments, pending.toolCalls[0]!.arguments);
          assert.equal(retry.toolCalls[0]!.id, `call_notifications_${stage}_retry_${attempt}`);
          append(input, `${stage}_retry_${attempt}`, {
            status: 'busy',
            code: 'private-state-file-lock-busy',
            id,
          });
        }
        assert.deepEqual(await response(input), {
          content: 'notification-retry-exhausted: private-state-file-lock-busy',
        });
        input.messages.push({
          role: 'user',
          content: `Fill initially available intake slots in one bounded pass. Policy digest: ${digest}`,
        });
        await action(input, 'scan');
      }
      const invalid = request(
        `Fill initially available intake slots in one bounded pass. Policy digest: ${digest}`,
      );
      append(invalid, 'scan', { status: 'ready' });
      append(invalid, 'next', { status: 'busy', code: 'unexpected-failure' });
      assert.equal(matchFixture([...scenario.fixtures], invalid), null);
    });

    it('should require model-only context before assessment', async () => {
      const missing = request(
        `Agent System: assess this admitted issue and retain its complete plan. Call agent_system_dispatch with action context and id ${id}`,
      );
      missing.messages.pop();
      assert.equal(matchFixture([...scenario.fixtures], missing), null);
    });

    if (
      !['openclaw-notifications-pr-delivery', 'openclaw-notifications-progression'].includes(
        scenario.id,
      )
    )
      it('should consume fresh later evidence after recovery', async () => {
        const later = request(`Refresh retained assessment for managed issue ${id}`);
        assert.equal(matchFixture([...scenario.fixtures], later), null);
        later.messages.push({
          role: 'user',
          content:
            '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> Agent System model-only current-turn facts previousResultDigest',
        });
        assert.equal((await action(later, 'context')).id, id);
        append(later, 'refresh-context', {
          status: 'verified',
          previousResultDigest: digest,
          previousResult: {
            version: 1,
            outcome: 'plan-ready',
            summary: 'Retained.',
            assessment: 'Observed.',
            plan: 'Complete retained plan.',
            planSummary: 'Retain it.',
            fullAssessment: 'Complete retained plan.',
            evidence: [],
            progress: { completed: [], remaining: [] },
          },
          evidence: { body: 'notification-hidden-later-fact' },
        });
        const revised = await action(later, 'result');
        assert.equal(revised.previousResultDigest, digest);
        assert.ok(!JSON.stringify(revised.result).includes('notification-hidden-later-fact'));
        append(later, 'refresh-result', { status: 'recorded', presentation: '> ## 🧭 Plan ready' });
        const nextResponse = await response(later);
        assert.equal('content' in nextResponse && nextResponse.content, '> ## 🧭 Plan ready');
        assert.deepEqual(await action(later, 'present'), {
          action: 'present',
          id,
          includeDetails: true,
        });
        append(later, 'detail-readback', {
          status: 'presented',
          presentation:
            revised.result.fullAssessment +
            ' Managed Git confirmed this worktree. Verified the managed worktree.',
        });
        assert.equal((await action(later, 'summary')).operation, 'compose');
      });

    it('should recover blocked child context without changing its identity or accepting other blockers', async () => {
      const prompt = `Agent System: assess this admitted issue and retain its complete plan. Call agent_system_dispatch with action context and id ${id}`;
      for (const code of ['private-state-file-lock-busy', 'private-state-snapshot-conflict']) {
        const input = request(prompt);
        const original = await action(input, 'context');
        append(input, 'context', { status: 'blocked', code });
        assert.deepEqual(await action(input, 'context'), original);
        append(input, 'context_retry_1', {
          status: 'verified',
          runtime: 'openclaw',
          id,
          project: { path: '/fixture' },
          assessment:
            scenario.id === 'openclaw-notifications-issue-journey'
              ? { skill: { name: 'generic-assessment', path: '/fixture/SKILL.md' } }
              : {},
          resultContract: 'assessment-result/v1',
        });
        if (scenario.id === 'openclaw-notifications-issue-journey') {
          const read = await response(input);
          assert.ok('toolCalls' in read && read.toolCalls?.[0]?.name === 'read');
          append(input, 'assessment-skill', 'Generic Assessment');
        }
        const next = await response(input);
        assert.ok('toolCalls' in next && next.toolCalls?.[0]?.name === 'agent_system_git');
      }
      for (const code of [
        'dispatch-turn-send-unverified',
        'feedback-authority-changed',
        'permission-denied',
      ]) {
        const input = request(prompt);
        append(input, 'context', { status: 'blocked', code });
        assert.equal(matchFixture([...scenario.fixtures], input), null);
      }
    });

    it('should retain a plan only after native context and git verify its worktree', async () => {
      const input = request(
        `Agent System: assess this admitted issue and retain its complete plan. Call agent_system_dispatch with action context and id ${id}`,
      );
      assert.equal((await action(input, 'context')).id, id);
      const context = {
        status: 'verified',
        runtime: 'openclaw',
        id,
        project: { path: '/tmp/managed-worktree' },
        assessment: {
          skill:
            scenario.id === 'openclaw-notifications-issue-journey'
              ? { name: 'generic-assessment', path: '/fixture/SKILL.md' }
              : {},
        },
        resultContract: 'assessment-result/v1',
      };
      append(input, 'context', context);
      if (scenario.id === 'openclaw-notifications-issue-journey') {
        const read = await response(input);
        assert.ok('toolCalls' in read && read.toolCalls?.[0]?.name === 'read');
        assert.deepEqual(JSON.parse(read.toolCalls![0]!.arguments), { path: '/fixture/SKILL.md' });
        append(input, 'assessment-skill', 'Generic Assessment');
      }
      const git = await response(input);
      assert.ok('toolCalls' in git);
      assert.equal(git.toolCalls?.[0]?.name, 'agent_system_git');
      assert.deepEqual(JSON.parse(git.toolCalls![0]!.arguments), {
        argv: ['rev-parse', '--show-toplevel'],
      });
      append(input, 'git', { exitCode: 0, stdout: '/tmp/managed-worktree\n', truncated: false });
      const saved = await action(input, 'result');
      assert.equal(saved.id, id);
      assert.equal(saved.result.outcome, 'plan-ready');
      const presentation = saved.result.reviewSummary ?? 'The complete retained presentation.';
      append(input, 'result', { status: 'recorded', presentation });
      const nextResponse = await response(input);
      assert.equal('content' in nextResponse && nextResponse.content, presentation);
      if (
        ['openclaw-notifications-pr-delivery', 'openclaw-notifications-progression'].includes(
          scenario.id,
        )
      ) {
        await publishProgressionSummary(input);
        assert.deepEqual(await response(input), { content: 'Published retained plan.' });
      }
      if (
        !['openclaw-notifications-pr-delivery', 'openclaw-notifications-progression'].includes(
          scenario.id,
        )
      ) {
        assert.deepEqual(await action(input, 'present'), {
          action: 'present',
          id,
          includeDetails: true,
        });
        append(input, 'detail-readback', {
          status: 'presented',
          presentation:
            saved.result.fullAssessment +
            ' Managed Git confirmed this worktree. Verified the managed worktree.',
        });
        assert.equal((await action(input, 'summary')).operation, 'compose');
      }
      for (const value of [
        { ...context, runtime: 'codex' },
        { ...context, id: 'c'.repeat(64) },
        { ...context, status: 'blocked' },
      ]) {
        const invalid = request(
          `Agent System: assess this admitted issue and retain its complete plan. Call agent_system_dispatch with action context and id ${id}`,
        );
        append(invalid, 'context', value);
        assert.equal(matchFixture([...scenario.fixtures], invalid), null);
      }
    });

    it('should reject failed scans unrelated issues and an execution outside the verified worktree', async () => {
      const scan = request(
        `Fill initially available intake slots in one bounded pass. Policy digest: ${digest}`,
      );
      append(scan, 'scan', { status: 'blocked' });
      await action(scan, 'report');
      append(scan, 'report', { status: 'reported', response: '> ## ⚠️ Intake needs attention' });
      assert.deepEqual(await response(scan), { content: '> ## ⚠️ Intake needs attention' });
      const unrelated = request(
        `Fill initially available intake slots in one bounded pass. Policy digest: ${digest}`,
      );
      append(unrelated, 'scan', { status: 'ready' });
      append(unrelated, 'next', {
        status: 'routing-required',
        id,
        digest,
        context: {
          source: 'https://github.com/pirog/me/issues/123',
          body: 'disposable Agent System notification-flow fixture',
        },
      });
      assert.equal(matchFixture([...scenario.fixtures], unrelated), null);
      const invalid = request(
        `Agent System: assess this admitted issue and retain its complete plan. Call agent_system_dispatch with action context and id ${id}`,
      );
      append(invalid, 'context', {
        status: 'verified',
        runtime: 'openclaw',
        id,
        project: { path: '/tmp/owned' },
        assessment: {},
        resultContract: 'assessment-result/v1',
      });
      append(invalid, 'git', { exitCode: 0, stdout: '/tmp/other', truncated: false });
      assert.equal(matchFixture([...scenario.fixtures], invalid), null);
    });
    if (
      ['openclaw-notifications-pr-delivery', 'openclaw-notifications-progression'].includes(
        scenario.id,
      )
    )
      it('should finish response-only recovery without repeating assessment or implementation', async () => {
        const input = request(`recover only the pending public assessment summary with id ${id}`);
        await action(input, 'present');
        append(input, 'recovery-present', {
          status: 'presented',
          presentation: 'Retained assessment.',
        });
        await publishProgressionSummary(input);
        assert.deepEqual(await response(input), { content: 'Published retained plan.' });
      });
    if (scenario.id === 'openclaw-notifications-progression') {
      for (const direct of [false, true])
        it(`should ask clarification during automatic work and resume an answer with direct handoff ${direct}`, async () => {
          const automatic = request(
            direct
              ? `Resume the unfinished Auto decision. Refresh agent_system_dispatch action context with id ${id}.`
              : `Continue this issue through implementation. Call agent_system_dispatch action implementation-context with id ${id}.`,
          );
          if (direct) {
            await action(automatic, 'context');
            append(automatic, 'refresh-context', {
              status: 'verified',
              mode: 'auto',
              previousResult: {
                version: 1,
                outcome: 'plan-ready',
                summary: 'Ready.',
                assessment: 'Bounded documentation.',
                plan: 'Document cleanup.',
                evidence: [],
                progress: { completed: [], remaining: [] },
              },
              previousResultDigest: digest,
            });
            await action(automatic, 'result');
            append(automatic, 'refresh-result', {
              status: 'recorded',
              presentation: 'The retained plan.',
              handoff: { next: 'implementation' },
            });
          }
          await action(automatic, 'implementation-context');
          append(automatic, 'work-context', {
            status: 'verified',
            runtime: 'openclaw',
            publicationAuthorized: true,
            pendingPublicResponse: {
              kind: 'assessment-summary',
              revision: direct ? 2 : 1,
              state: 'pending',
            },
            project: { path: '/tmp/owned' },
          });
          await action(automatic, 'present');
          append(automatic, 'recovery-present', {
            status: 'presented',
            presentation: 'The retained plan.',
          });
          await publishProgressionSummary(automatic);
          const question = await action(automatic, 'implementation-result');
          assert.equal(question.implementationResult.outcome, 'clarification-needed');
          append(automatic, 'work-result', {
            status: 'recorded',
            presentation: 'Which cleanup timing?',
          });
          assert.deepEqual(await response(automatic), {
            content: direct
              ? 'The retained plan.\n\nWhich cleanup timing?'
              : 'Which cleanup timing?',
          });
          const answer = request(
            `Answer for managed issue ${id}: Yes, after evidence is captured. Do not push or publish a PR.`,
          );
          await action(answer, 'implementation-context');
          append(answer, 'work-context', {
            status: 'verified',
            runtime: 'openclaw',
            publicationAuthorized: true,
            project: { path: '/tmp/owned' },
            previousImplementationResult: question.implementationResult,
          });
          for (const stage of ['apply', 'add', 'commit']) {
            const resumed = await response(answer);
            assert.ok('toolCalls' in resumed);
            assert.equal(resumed.toolCalls?.[0]?.name, 'agent_system_git');
            assert.equal(JSON.parse(resumed.toolCalls![0]!.arguments).argv[0], stage);
            append(answer, stage, { exitCode: 0, truncated: false });
          }
          const completed = await action(answer, 'implementation-result');
          assert.equal(completed.implementationResult.outcome, 'done');
          append(answer, 'work-result', {
            status: 'recorded',
            presentation: 'Committed locally.',
            handoff: { next: 'delivery' },
          });
          assert.deepEqual(await response(answer), { content: 'Committed locally.' });
        });
    }
    if (scenario.id === 'openclaw-notifications-pr-delivery') {
      it('should wait for native handoff before implementation and use the same delivery for an operator retry', async () => {
        const input = request(
          `Operator request for managed issue ${id}: Implement the retained plan and open a linked pull request.`,
        );
        await action(input, 'handoff');
        append(input, 'handoff-preview', { status: 'handoff-available', digest });
        assert.equal((await action(input, 'handoff')).digest, digest);
        append(input, 'handoff', { status: 'handed-off' });
        await action(input, 'implementation-context');
        append(input, 'work-context', {
          status: 'verified',
          runtime: 'openclaw',
          publicationAuthorized: true,
          project: { path: '/tmp/owned' },
        });
        for (const stage of ['apply', 'add', 'commit']) {
          const next = await response(input);
          assert.ok('toolCalls' in next && next.toolCalls?.length === 1);
          assert.equal(next.toolCalls[0]!.name, 'agent_system_git');
          assert.equal(JSON.parse(next.toolCalls[0]!.arguments).cwd, '/tmp/owned');
          append(input, stage, { exitCode: 0, truncated: false, stdout: '' });
        }
        await action(input, 'implementation-result');
        append(input, 'work-result', {
          status: 'recorded',
          handoff: {
            next: 'delivery',
            request: { action: 'delivery', id, operation: 'prepare' },
          },
        });
        assert.equal((await action(input, 'delivery')).operation, 'prepare');
        append(input, 'delivery-prepare', { status: 'prepared', digest });
        assert.equal((await action(input, 'delivery')).digest, digest);
        append(input, 'delivery-publish', {
          status: 'waiting',
          code: 'github-delivery-linkage-unverified',
          pullRequest: { pullRequestNodeId: 'PR_owned', pullRequestNumber: 456 },
        });
        const reconciliation = await action(input, 'delivery');
        assert.equal(reconciliation.operation, 'prepare');
        assert.equal(reconciliation.id, id);
        append(input, 'delivery-link-prepare-0', { status: 'prepared', digest });
        const linkageRetry = await action(input, 'delivery');
        assert.equal(linkageRetry.operation, 'publish');
        assert.equal(linkageRetry.id, id);
        append(input, 'delivery-link-publish-0', {
          status: 'published',
          workflowStatus: 'partially-delivered',
        });
        assert.equal((await action(input, 'delivery')).operation, 'compose');
        append(input, 'delivery-compose', {
          status: 'composition-ready',
          digest,
          selection: { skill: { path: '/skills/reply/SKILL.md' } },
        });
        const skill = await response(input);
        assert.ok('toolCalls' in skill && skill.toolCalls?.[0]?.name === 'read');
        append(input, 'delivery-skill', { content: 'Reply skill instructions.' });
        assert.equal((await action(input, 'delivery')).operation, 'candidate');
        append(input, 'delivery-candidate', { status: 'announcement-prepared', digest });
        assert.equal((await action(input, 'delivery')).operation, 'announce');
        append(input, 'delivery-announce', { status: 'announced' });
        assert.ok('content' in (await response(input)));
        const retry = request(
          `Operator request for managed issue ${id}: Show the saved plan and existing PR card again.`,
        );
        await action(retry, 'present');
        append(retry, 'assessment-present', { status: 'presented', presentation: '> Saved plan' });
        assert.equal((await action(retry, 'delivery')).operation, 'present');
        append(retry, 'delivery-present', { status: 'presented', presentation: '> PR card' });
        assert.deepEqual(await response(retry), { content: '> Saved plan\n\n> PR card' });
      });

      it('should commit a follow-up and reuse the existing announcement after updating the pr', async () => {
        const input = request(
          `Operator request for managed issue ${id}: Add a follow-up commit and update the existing PR title and body.`,
        );
        append(input, 'handoff-preview', { status: 'handoff-available', digest });
        append(input, 'handoff', { status: 'handed-off' });
        append(input, 'work-context', {
          status: 'verified',
          runtime: 'openclaw',
          publicationAuthorized: true,
          project: { path: '/tmp/owned' },
        });
        const patch = await response(input);
        assert.ok('toolCalls' in patch && patch.toolCalls?.[0]?.name === 'agent_system_git');
        const args = JSON.parse(patch.toolCalls[0].arguments);
        assert.match(args.stdin, /Verify the same PR and announcement/);
        assert.doesNotMatch(args.stdin, /new file mode/);
        for (const stage of ['apply', 'add', 'commit'])
          append(input, stage, { exitCode: 0, truncated: false, stdout: '' });
        append(input, 'work-result', {
          status: 'recorded',
          handoff: {
            next: 'delivery',
            request: { action: 'delivery', id, operation: 'prepare' },
          },
        });
        const prepared = await action(input, 'delivery');
        assert.equal(prepared.operation, 'prepare');
        assert.match(prepared.title!, /cleanup and verification/);
        append(input, 'delivery-prepare', { status: 'prepared', digest });
        assert.equal((await action(input, 'delivery')).operation, 'publish');
        const refreshedDigest = 'f'.repeat(64);
        append(input, 'delivery-publish', {
          status: 'prepared',
          code: 'delivery-preview-stale',
          digest: refreshedDigest,
        });
        const refreshed = await action(input, 'delivery');
        assert.equal(refreshed.operation, 'publish');
        assert.equal(refreshed.digest, refreshedDigest);
        assert.equal(refreshed.title, prepared.title);
        assert.equal(refreshed.body, prepared.body);
        const stopped = structuredClone(input);
        append(stopped, 'delivery-publish-refreshed', {
          status: 'prepared',
          code: 'delivery-preview-stale',
          digest,
        });
        assert.equal(matchFixture([...scenario.fixtures], stopped), null);
        const waiting = {
          status: 'waiting',
          code: 'github-delivery-head-not-observed',
          pullRequest: { pullRequestNodeId: 'PR_owned', pullRequestNumber: 456 },
        };
        for (const rejected of [
          { ...waiting, code: 'github-delivery-binding-head-changed' },
          { ...waiting, status: 'blocked' },
          { ...waiting, pullRequest: undefined },
        ]) {
          const invalid = structuredClone(input);
          append(invalid, 'delivery-publish-refreshed', rejected);
          assert.equal(matchFixture([...scenario.fixtures], invalid), null);
        }
        append(input, 'delivery-publish-refreshed', waiting);
        const exhausted = structuredClone(input);
        for (let index = 0; index < 3; index++) {
          const reconcile = await action(exhausted, 'delivery');
          assert.equal(reconcile.operation, 'prepare');
          assert.equal(reconcile.id, id);
          append(exhausted, `delivery-link-prepare-${index}`, {
            status: 'prepared',
            digest: refreshedDigest,
          });
          const publish = await action(exhausted, 'delivery');
          assert.equal(publish.operation, 'publish');
          assert.equal(publish.digest, refreshedDigest);
          append(exhausted, `delivery-link-publish-${index}`, waiting);
        }
        assert.deepEqual(await response(exhausted), {
          content:
            'notification-delivery-reconciliation-exhausted: github-delivery-head-not-observed',
        });
        assert.equal((await action(input, 'delivery')).operation, 'prepare');
        append(input, 'delivery-link-prepare-0', { status: 'prepared', digest: refreshedDigest });
        assert.equal((await action(input, 'delivery')).digest, refreshedDigest);
        append(input, 'delivery-link-publish-0', {
          status: 'published',
          workflowStatus: 'partially-delivered',
        });
        assert.equal((await action(input, 'delivery')).operation, 'announce');
        append(input, 'delivery-repeat', { status: 'announced' });
        assert.equal((await action(input, 'delivery')).operation, 'present');
      });

      it('should stop when native authority rejects the operator handoff', async () => {
        const input = request(
          `Operator request for managed issue ${id}: Implement the retained plan and open a linked pull request.`,
        );
        append(input, 'handoff-preview', { status: 'blocked', code: 'dispatch-operator-required' });
        assert.equal(matchFixture([...scenario.fixtures], input), null);
      });
    } else {
      it('should refuse operator pr delivery in a non-pr fixture', () => {
        assert.equal(
          matchFixture(
            [...scenario.fixtures],
            request(
              `Operator request for managed issue ${id}: Implement the retained plan and open a linked pull request.`,
            ),
          ),
          null,
        );
      });
    }
    if (scenario.id === 'openclaw-notifications-issue-journey')
      it('should answer paired github and direct questions using retained responses without work', async () => {
        const privateText = 'The retained plan documents disposable issue cleanup after evidence.';
        const github = request(
          `Call agent_system_dispatch with action feedback, operation context, id ${id}, eventId ${'e'.repeat(64)}`,
        );
        assert.equal((await action(github, 'feedback')).operation, 'context');
        append(github, 'feedback-context', {
          status: 'verified',
          runtime: 'openclaw',
          publication: 'allowed',
          source: { body: '@tanaabot explain the plan using the earlier explanation.' },
          previousFeedbackWork: [{ eventId: 'd'.repeat(64), privateText }],
        });
        assert.equal((await action(github, 'feedback')).operation, 'result');
        const direct = request(
          `Explain retained plan for managed issue ${id}: explain the plan using the earlier explanation.`,
        );
        assert.equal((await action(direct, 'context')).id, id);
        append(direct, 'direct-question-context', {
          status: 'verified',
          mode: 'plan',
          feedbackWork: [
            { eventId: 'd'.repeat(64), privateText },
            { eventId: 'e'.repeat(64), privateText },
          ],
        });
        assert.deepEqual(await response(direct), { content: privateText });
      });
    if (scenario.id === 'openclaw-notifications-issue-journey')
      it('should adapt ordinary clarification and an answer using retained full output', async () => {
        let previous: Record<string, unknown> = {
          fullAssessment: 'Original findings and uncertainty.',
        };
        for (const stage of ['Clarify', 'Answer']) {
          const input = request(
            `[Wed 2026-10-21 17:32 UTC] ${stage} ordinary assessment for managed issue ${id}`,
          );
          input.messages.push({
            role: 'user',
            content:
              '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> Agent System model-only current-turn facts notification-hidden-initial-fact',
          });
          assert.equal((await action(input, 'context')).id, id);
          append(input, 'context', {
            status: 'verified',
            runtime: 'openclaw',
            id,
            project: { path: '/tmp/managed-worktree' },
            assessment: { skill: { name: 'generic-assessment', path: '/fixture/SKILL.md' } },
            previousResult: previous,
            previousResultDigest: digest,
            resultContract: 'assessment-result/v1',
          });
          const read = await response(input);
          assert.ok('toolCalls' in read && read.toolCalls?.[0]?.name === 'read');
          append(input, 'assessment-skill', 'Generic Assessment');
          await response(input);
          append(input, 'git', { exitCode: 0, stdout: '/tmp/managed-worktree', truncated: false });
          const submission = await action(input, 'result');
          assert.equal(submission.previousResultDigest, digest);
          assert.equal(
            submission.result.outcome,
            stage === 'Clarify' ? 'clarification-needed' : 'plan-ready',
          );
          assert.ok(submission.result.fullAssessment!.startsWith(String(previous.fullAssessment)));
          if (stage === 'Clarify') {
            assert.equal(submission.result.outcome, 'clarification-needed');
            assert.ok('questions' in submission.result);
            assert.deepEqual(submission.result.questions, [
              'Should cleanup close the issue only after evidence capture?',
            ]);
          }
          append(input, 'result', { status: 'recorded', presentation: 'Retained native review.' });
          assert.deepEqual(await response(input), { content: 'Retained native review.' });
          previous = submission.result;
        }
      });
    if (scenario.id !== 'openclaw-notifications-progression')
      for (const initial of scenario.id === 'openclaw-notifications-pr-delivery'
        ? [true, false]
        : [false])
        it(`should keep feedback ${initial ? 'initial implementation' : 'continuation'} private retention skill selection candidate and publication as distinct stages`, async () => {
          const eventId = 'e'.repeat(64);
          let input = request(
            `Call agent_system_dispatch with action feedback, operation context, id ${id}, eventId ${eventId}`,
          );
          assert.equal((await action(input, 'feedback')).operation, 'context');
          append(input, 'feedback-context', {
            status: 'verified',
            runtime: 'openclaw',
            publication: 'allowed',
            previousFeedbackWork: [],
            source: { body: '@tanaabot explain the plan.' },
          });
          if (scenario.id === 'openclaw-notifications-pr-delivery') {
            const last = input.messages.at(-1)!;
            last.content = JSON.stringify({
              status: 'verified',
              runtime: 'openclaw',
              publication: 'allowed',
              mode: initial ? 'plan' : 'work',
              issueStage: initial ? 'planning' : 'implementation',
              previousFeedbackWork: initial
                ? []
                : [{ eventId: 'd'.repeat(64), result: { outcome: 'done' } }],
              ...(initial ? {} : { previousImplementation: { outcome: 'done' } }),
            });
            const entry = await action(input, 'feedback');
            assert.equal(entry.operation, 'implementation-context');
            assert.equal(entry.decision, undefined);
            append(input, 'feedback-work-context', {
              status: 'verified',
              worktree: '/tmp/worktree',
              issueStage: 'implementation',
              work: {},
              implementation: { skill: { path: '/tmp/IMPLEMENT.md' } },
              previousFeedbackWork: initial
                ? []
                : [{ eventId: 'd'.repeat(64), result: { outcome: 'done' } }],
              ...(initial ? {} : { previousImplementation: { outcome: 'done' } }),
            });
            const selected = await response(input);
            assert.ok('toolCalls' in selected);
            assert.equal(selected.toolCalls?.[0]?.name, 'read');
            append(input, 'feedback-implementation-skill', { text: 'Implementation method' });
            if (!initial) {
              const branch = await response(input);
              assert.ok('toolCalls' in branch);
              assert.deepEqual(JSON.parse(branch.toolCalls![0]!.arguments).argv, [
                'branch',
                '--show-current',
              ]);
              append(input, 'feedback-branch', {
                exitCode: 0,
                truncated: false,
                stdout: 'fixture-pr-branch\n',
              });
            }
            for (const stage of [
              ...(!initial ? ['feedback-fetch', 'feedback-incorporate'] : []),
              'feedback-apply',
              'feedback-check',
              'feedback-add',
              'feedback-commit',
            ]) {
              const step = await response(input);
              assert.ok('toolCalls' in step);
              assert.equal(step.toolCalls?.[0]?.name, 'agent_system_git');
              if (stage === 'feedback-fetch')
                assert.deepEqual(JSON.parse(step.toolCalls![0]!.arguments).argv, [
                  'fetch',
                  'origin',
                  'fixture-pr-branch',
                ]);
              if (stage === 'feedback-incorporate')
                assert.deepEqual(JSON.parse(step.toolCalls![0]!.arguments).argv, [
                  'merge',
                  '--ff-only',
                  'FETCH_HEAD',
                ]);
              append(input, stage, { exitCode: 0, truncated: false });
            }
            assert.equal((await action(input, 'feedback')).operation, 'implementation-result');
            append(input, 'feedback-work-result', { status: 'recorded' });
            assert.equal((await action(input, 'feedback')).deliveryOperation, 'prepare');
            append(input, 'feedback-delivery-prepare', { status: 'prepared', digest });
            const delivered = await action(input, 'feedback');
            assert.equal(delivered.deliveryOperation, 'publish');
            assert.equal(delivered.digest, digest);
            if (initial) {
              append(input, 'feedback-delivery-publish', {
                status: 'waiting',
                code: 'github-delivery-linkage-unverified',
                nextAction: 'next',
              });
              const recovery = await action(input, 'feedback');
              assert.equal(recovery.deliveryOperation, 'prepare');
              assert.equal(recovery.id, id);
              assert.equal(recovery.eventId, eventId);
              const missingReceipt = structuredClone(input);
              append(missingReceipt, 'feedback-link-prepare-0', { status: 'prepared', digest });
              assert.equal(matchFixture([...scenario.fixtures], missingReceipt), null);
              append(input, 'feedback-link-prepare-0', {
                status: 'prepared',
                digest,
                operation: {
                  pullRequest: { pullRequestNodeId: 'PR_owned', pullRequestNumber: 456 },
                },
              });
              const retry = await action(input, 'feedback');
              assert.equal(retry.deliveryOperation, 'publish');
              assert.equal(retry.digest, digest);
              assert.equal(retry.id, id);
              assert.equal(retry.eventId, eventId);
              append(input, 'feedback-link-publish-0', { status: 'published' });
            } else append(input, 'feedback-delivery-publish', { status: 'published' });
            if (initial) {
              assert.equal((await action(input, 'feedback')).deliveryOperation, 'compose');
              append(input, 'feedback-delivery-compose', {
                status: 'composition-ready',
                digest,
                selection: { skill: { path: '/skills/reply/SKILL.md' } },
              });
              const selected = await response(input);
              assert.ok('toolCalls' in selected && selected.toolCalls?.[0]?.name === 'read');
              append(input, 'delivery-skill', { content: 'Reply skill instructions.' });
              assert.equal((await action(input, 'feedback')).deliveryOperation, 'candidate');
              append(input, 'feedback-delivery-candidate', {
                status: 'announcement-prepared',
                digest,
              });
              assert.equal((await action(input, 'feedback')).deliveryOperation, 'announce');
              append(input, 'feedback-delivery-announce', { status: 'announced' });
            }
          }
          const retained = await action(input, 'feedback');
          assert.equal(retained.operation, 'result');
          if (scenario.id !== 'openclaw-notifications-pr-delivery')
            assert.match(retained.privateText!, /implementation remains unstarted/);
          append(input, 'feedback-result', {
            status: 'recorded',
            presentation: 'Full private response',
          });
          if (scenario.id === 'openclaw-notifications-pr-delivery' && !initial) {
            assert.ok('content' in (await response(input)));
            input = request(
              `Resume the retained feedback reply only. Use operation context, id ${id}, eventId ${eventId}.`,
            );
            const resumed = await action(input, 'feedback');
            assert.equal(resumed.operation, 'context');
            assert.equal(resumed.resume, true);
            append(input, 'feedback-context', {
              status: 'verified',
              runtime: 'openclaw',
              publication: 'allowed',
              mode: 'work',
            });
          }
          assert.equal((await action(input, 'feedback')).operation, 'compose');
          append(input, 'feedback-compose', {
            status: 'composition-ready',
            digest,
            selection: { skill: { path: '/tmp/SKILL.md' } },
          });
          const read = await response(input);
          assert.ok('toolCalls' in read);
          assert.equal(read.toolCalls?.[0]?.name, 'read');
          append(input, 'feedback-skill', { text: 'Selected reply method' });
          const candidate = await action(input, 'feedback');
          assert.equal(candidate.operation, 'candidate');
          if (scenario.id !== 'openclaw-notifications-pr-delivery')
            assert.match(candidate.publicText!, /Implementation has not started/);
          append(input, 'feedback-candidate', { status: 'candidate-recorded' });
          assert.equal((await action(input, 'feedback')).digest, undefined);
          append(input, 'feedback-preview', { status: 'publication-ready', digest });
          assert.equal((await action(input, 'feedback')).digest, digest);
          append(input, 'feedback-publish', {
            status: 'published',
            presentation: 'Complete private and public presentation',
          });
          assert.deepEqual(await response(input), {
            content: 'Complete private and public presentation',
          });
        });
  });
}
