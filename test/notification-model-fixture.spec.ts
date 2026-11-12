import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import implementationMaterial, {
  type ImplementationMaterialRead,
} from '../agent/tasks/implementation/implementation-material.ts';
import {
  bindNativeMaterial,
  nativeMaterialResponse,
} from '../agent/tasks/context/native-material.ts';
import nativeTaskInstructions from '../agent/tasks/context/native-task-instructions.ts';
import openclawIntakeJobs from '../agent/automations/openclaw-intake-policy.ts';
import waitForAssessmentRelease from '../examples/openclaw-issue-intake/assessment-barrier.ts';
import { intakeFixture } from './github-intake-fixture.ts';

import { matchFixture, type ChatCompletionRequest } from '@copilotkit/aimock';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import renderNativeAssessment from '../agent/tasks/assessment/assessment-render.ts';
import {
  assessmentResultContextSchema,
  assessmentResultFormat,
} from '../agent/tasks/assessment/assessment-result.ts';
import type { OpenClawDispatchRecord } from '../agent/tasks/dispatch/openclaw-dispatch-state.ts';
import openclawTurnContext from '../agent/tasks/context/openclaw-turn-context.ts';
import {
  createIntakeExampleScenario,
  intakeExampleScenario,
} from '../examples/openclaw-issue-intake/model-fixture.ts';
import { issueExampleScenario } from '../examples/openclaw-issue-conversation/issue-model.ts';
import {
  progressionExampleScenario,
  createProgressionScenario,
  retainedPlan,
} from '../examples/openclaw-issue-auto-plan/progression-model.ts';
import { retirementExampleScenario } from '../examples/openclaw-notifications-retirement/model-fixture.ts';
import { prDiscoveryExampleScenario } from '../examples/openclaw-pr-discovery/model-fixture.ts';
import { prExampleScenario } from '../examples/openclaw-pr-journey/model-fixture.ts';
import resolveExampleModelScenario from '../scripts/example-model-scenarios.ts';
import { dispatchModelParameters } from '../tools/dispatch/tool-schema.ts';
import { intakeParameters } from '../tools/intake/tool-schema.ts';

describe('examples/pr discovery inspection fixture', () => {
  it('should request the installed native inspection and return only its observed result', async () => {
    const target = 'https://github.com/tanaabased/big-test-bucket/issues/69';
    const input: ChatCompletionRequest = {
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: 'Name: Notification Tanaabot' },
        { role: 'user', content: `Inspect saved discovery for ${target}` },
      ],
      tools: [{ type: 'function', function: { name: 'agent_system_dispatch' } }],
    };
    const respond = async () => {
      const fixture = matchFixture([...prDiscoveryExampleScenario.fixtures], input);
      assert.ok(fixture);
      return typeof fixture.response === 'function'
        ? await fixture.response(input)
        : fixture.response;
    };
    const first = await respond();
    assert.ok('toolCalls' in first && first.toolCalls?.length === 1);
    const call = first.toolCalls[0]!;
    assert.equal(call.name, 'agent_system_dispatch');
    assert.deepEqual(JSON.parse(call.arguments), { action: 'inspect', target, limit: 1 });
    assert.ok(Value.Check(dispatchModelParameters, JSON.parse(call.arguments)));
    const observed = {
      status: 'ready',
      total: 1,
      records: [{ id: 'a'.repeat(64), feedback: { code: 'feedback-discovery-no-progress' } }],
    };
    input.messages.push({
      role: 'tool',
      tool_call_id: call.id + '_fc-native',
      content: JSON.stringify(observed),
    });
    const complete = matchFixture(
      [...prDiscoveryExampleScenario.dynamicFinalResponseFixtures!],
      input,
    );
    assert.ok(complete && typeof complete.response === 'function');
    assert.deepEqual(await complete.response(input), { content: JSON.stringify(observed) });
  });
});

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
  const hookAssessment = ['openclaw-pr-journey', 'openclaw-issue-auto-plan'].includes(scenario.id);

  function supplyFacts(input: ChatCompletionRequest, values: Record<string, unknown>) {
    const marker = 'Agent System model-only current-turn facts (keep private):\n';
    const existing = input.messages.findLast(
      (message) => typeof message.content === 'string' && message.content.includes(marker),
    );
    const previous = existing
      ? JSON.parse(String(existing.content).split(marker)[1]!.split('\n')[0]!)
      : {};
    const content =
      'OpenClaw runtime context:\n' +
      marker +
      JSON.stringify({
        contextProbe: { version: 1, runtime: 'openclaw', hook: 'before_prompt_build' },
        receipt: id,
        stage: 'assessment',
        ...previous,
        ...values,
      });
    if (existing) existing.content = content;
    else input.messages.push({ role: 'user', content });
  }

  function assessmentContract() {
    return {
      entry: 'managed',
      resultSchema: assessmentResultContextSchema,
      resultFormat: assessmentResultFormat,
    };
  }

  function request(prompt: string): ChatCompletionRequest {
    return {
      model: 'gpt-5.5',
      messages: [
        {
          role: 'system',
          content:
            'Name: Notification Tanaabot\nAgent System Git context for GitHub repositories (keep private):\n{"git":{"protocol":"ssh"}}',
        },
        { role: 'user', content: prompt },
        ...(prompt.includes(
          'Agent System: assess this admitted issue and retain its complete plan.',
        ) || prompt.includes('action feedback, operation context, id ')
          ? [
              {
                role: 'user' as const,
                content:
                  'OpenClaw runtime context:\n' +
                  openclawTurnContext(
                    {
                      id,
                      threadId: 'issue',
                      request: { key: 'issue', agentId: 'receiver' },
                      sessionCreation: { verified: true, sessionId: 'incarnation' },
                      ...(prompt.includes('action feedback')
                        ? {
                            feedback: {
                              baseline: {},
                              events: [
                                {
                                  id: 'e'.repeat(64),
                                  number: 123,
                                  itemType: 'issue',
                                  source: JSON.stringify({ databaseId: 42 }),
                                  turn: { runId: 'current' },
                                },
                              ],
                            },
                          }
                        : { nativeTurns: [{ role: 'assessment', turn: { runId: 'current' } }] }),
                    } as OpenClawDispatchRecord,
                    {
                      agentId: 'receiver',
                      sessionKey: 'issue',
                      sessionId: 'incarnation',
                      runId: 'current',
                      repository: 'tanaabased/big-test-bucket',
                    },
                  )!.appendContext,
              },
            ]
          : []),
      ],
      tools: [
        'agent_system_intake',
        'agent_system_dispatch',
        'agent_system_context',
        'agent_system_git',
        'agent_system_github',
        'read',
      ].map((name) => ({
        type: 'function',
        function: { name },
      })),
    };
  }

  if (
    ['openclaw-issue-conversation', 'openclaw-pr-journey', 'openclaw-issue-auto-plan'].includes(
      scenario.id,
    )
  ) {
    it('should start from native context or the no-argument recovery tool without a visible recipe', async () => {
      const input = request('> ## 📥 Issue assigned\n>\n> Assess this issue and prepare a plan.');
      const context = openclawTurnContext(
        {
          id,
          threadId: 'issue',
          request: { key: 'issue', agentId: 'receiver' },
          sessionCreation: { verified: true, sessionId: 'incarnation' },
          nativeTurns: [{ role: 'assessment', turn: { runId: 'assessment' } }],
        } as OpenClawDispatchRecord,
        { agentId: 'receiver', sessionKey: 'issue', sessionId: 'incarnation', runId: 'assessment' },
      )!;
      input.messages.push({
        role: 'user',
        content: 'OpenClaw runtime context:\n' + context.appendContext,
      });
      if (hookAssessment)
        supplyFacts(input, {
          status: 'verified',
          runtime: 'openclaw',
          project: { path: '/fixture' },
          assessment: { defaultSkill: true, skill: { path: '/fixture/SKILL.md' } },
          resultFormat: assessmentResultFormat,
        });
      const next = await response(input);
      assert.ok('toolCalls' in next);
      assert.equal(
        next.toolCalls![0]!.name,
        hookAssessment ? 'agent_system_git' : 'agent_system_context',
      );
      assert.deepEqual(
        JSON.parse(next.toolCalls![0]!.arguments),
        hookAssessment ? { argv: ['rev-parse', '--show-toplevel'] } : {},
      );
      assert.ok(!String(input.messages[1]!.content).includes(id));
    });
  }

  function append(input: ChatCompletionRequest, stage: string, result: unknown) {
    if (stage === 'context' && hookAssessment) {
      supplyFacts(input, result as Record<string, unknown>);
      return;
    }
    if (stage === 'feedback-context') {
      supplyFacts(input, { stage: 'feedback', feedback: result });
      return;
    }
    input.messages.push({
      role: 'tool',
      tool_call_id: `call_notifications_${['next', 'prepare', 'assess', 'reconcile'].includes(stage) ? stage + '-0' : stage}_fc-native`,
      content: JSON.stringify(result),
    });
  }

  async function response(input: ChatCompletionRequest, selectedScenario = scenario) {
    const fixture = matchFixture([...selectedScenario.fixtures], input);
    assert.ok(fixture);
    return typeof fixture.response === 'function'
      ? await fixture.response(input)
      : fixture.response;
  }

  async function readRoutingSource(input: ChatCompletionRequest, index = 0) {
    const next = await response(input);
    assert.ok('toolCalls' in next && next.toolCalls?.[0]?.name === 'agent_system_github');
    assert.deepEqual(JSON.parse(next.toolCalls[0].arguments).argv, [
      'issue',
      'view',
      source,
      '--json',
      'title,body,comments',
    ]);
    append(input, `routing-source-${index}`, {
      exitCode: 0,
      truncated: false,
      stdout: JSON.stringify({
        body: 'disposable Agent System notification-flow fixture',
        comments: [],
      }),
    });
  }

  async function appendPagedContext(
    input: ChatCompletionRequest,
    value: Record<string, unknown>,
    request: Record<string, unknown> = { action: 'implementation-context' },
  ) {
    const receipts: unknown[] = [];
    const output = (response: unknown, args: Record<string, unknown>) => {
      const projected = nativeMaterialResponse(response, 'agent_system_dispatch', args);
      receipts.unshift(projected);
      return projected;
    };
    append(input, 'work-context', output(implementationMaterial(value, request), request));
    let pages = 0;
    for (; pages < 64; pages++) {
      const next = await response(input);
      if ('content' in next) break;
      assert.ok('toolCalls' in next && next.toolCalls?.length === 1);
      const args = JSON.parse(next.toolCalls[0]!.arguments);
      if (!args.material) break;
      assert.ok(Value.Check(dispatchModelParameters, args));
      assert.ok('material' in args);
      append(
        input,
        `work-material-${pages}`,
        output(
          implementationMaterial(
            value,
            request,
            (
              await bindNativeMaterial(
                'agent_system_dispatch',
                args,
                (async function* () {
                  yield* receipts;
                })(),
              )
            ).material as ImplementationMaterialRead,
          ),
          args,
        ),
      );
    }
    assert.ok(pages > 0 && pages < 64);
  }

  type Action = Static<typeof dispatchModelParameters> | { action: 'scan'; policyDigest: string };

  async function action<A extends Action['action']>(
    input: ChatCompletionRequest,
    expected: A,
    selectedScenario = scenario,
  ) {
    const next = await response(input, selectedScenario);
    assert.ok('toolCalls' in next && next.toolCalls?.length === 1);
    const call = next.toolCalls[0]!;
    const args = JSON.parse(call.arguments);
    if (call.name === 'agent_system_context') {
      assert.equal(expected, 'context');
      assert.deepEqual(args, {});
      return args as Extract<Action, { action: A }>;
    }
    assert.equal(args.action, expected);
    assert.ok(
      Value.Check(
        call.name === 'agent_system_intake' ? intakeParameters : dispatchModelParameters,
        args,
      ),
    );
    return args as Extract<Action, { action: A }>;
  }

  async function readAssessmentSource(
    input: ChatCompletionRequest,
    selectedScenario = scenario,
    body = 'Close disposable issues after evidence capture.',
  ) {
    const next = await response(input, selectedScenario);
    assert.ok('toolCalls' in next && next.toolCalls?.[0]?.name === 'agent_system_github');
    const call = next.toolCalls[0];
    assert.deepEqual(JSON.parse(call.arguments).argv.slice(-2), ['--json', 'title,body,comments']);
    append(input, 'assessment-source', {
      exitCode: 0,
      truncated: false,
      stdout: JSON.stringify({
        title: 'Cleanup',
        body,
        comments: [],
      }),
    });
  }

  async function publishNativePlan(
    input: ChatCompletionRequest,
    selectedScenario = scenario,
    continues = false,
    sourceBody?: string,
  ) {
    const target = 'https://github.com/owner/repo/issues/3';
    await readAssessmentSource(input, selectedScenario, sourceBody);
    const formatting = await action(input, 'assessment', selectedScenario);
    assert.equal(formatting.operation, 'render');
    const formatted = renderNativeAssessment(formatting);
    assert.equal(formatted.status, 'formatted');
    assert.equal(formatted.retained, false);
    append(input, 'native-plan-render', formatted);
    const privatePlan = await response(input, selectedScenario);
    assert.ok('content' in privatePlan);
    assert.equal(privatePlan.content, formatted.presentation);
    assert.match(String(privatePlan.content), /disposable (?:test )?issues/i);
    const observed = await action(input, 'reply', selectedScenario);
    assert.equal(observed.operation, 'context');
    assert.equal(observed.target, target);
    append(input, 'native-plan-context', { status: 'status-update-context', observation: digest });
    const composed = await action(input, 'reply', selectedScenario);
    assert.equal(composed.operation, 'compose');
    assert.match(composed.privateText!, /disposable (?:test )?issues/);
    append(input, 'native-plan-compose', {
      status: 'composition-ready',
      id,
      digest,
      selection: { defaultSkill: true, skill: { path: '/fixture/reply/SKILL.md' } },
    });
    const read = await response(input, selectedScenario);
    assert.ok('toolCalls' in read && read.toolCalls?.[0]?.name === 'read');
    append(input, 'plan-reply-skill', 'Reply guidance');
    assert.equal((await action(input, 'reply', selectedScenario)).operation, 'candidate');
    append(input, 'native-plan-candidate', {
      status: 'candidate-recorded',
      publication: 'workflow-authorized',
    });
    assert.equal((await action(input, 'reply', selectedScenario)).operation, 'publish');
    append(input, 'native-plan-publish', {
      status: 'published',
      presentation: 'Question published.',
    });
    if (!continues)
      assert.deepEqual(await response(input, selectedScenario), { content: 'Question published.' });
  }

  describe(`examples/${scenario.id} model fixture`, () => {
    if (scenario.id === 'openclaw-notifications-retirement')
      it('should retry the selected waiting assignment without internal identifiers', async () => {
        const input = request(`Retry waiting assignment ${source}`);
        const next = await response(input);
        assert.ok('toolCalls' in next && next.toolCalls?.length === 1);
        const call = next.toolCalls[0]!;
        assert.deepEqual(JSON.parse(call.arguments), { action: 'retry', target: source });
        input.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ status: 'routing-required' }),
        });
        assert.deepEqual(await response(input), {
          content: 'Waiting assignment retry accepted; coordinator must obtain fresh evidence.',
        });
      });
    if (scenario.id === 'openclaw-notifications-retirement')
      it('should retire the current task across native runtime context', async () => {
        const input = request(`Retire this managed task now ${'b'.repeat(64)}`);
        input.messages.push(
          { role: 'assistant', content: 'Earlier task retired.' },
          { role: 'user', content: `Retire this managed task now ${id}` },
          {
            role: 'user',
            content:
              'OpenClaw runtime context:\nCurrent runtime facts.\nEnd OpenClaw runtime context.',
          },
        );
        const next = await response(input);
        assert.ok('toolCalls' in next && next.toolCalls?.[0]);
        assert.deepEqual(JSON.parse(next.toolCalls[0].arguments), {
          action: 'retire',
          preview: true,
        });
      });

    if (scenario.id === 'openclaw-issue-conversation')
      it('should correct one rejected direct assessment shape without repeating investigation or changing source', async () => {
        const input = request(`Direct issue assessment target: ${source} checkout: /tmp/owned`);
        assert.equal((await action(input, 'assessment')).operation, 'context');
        append(input, 'direct-assessment-context', {
          status: 'verified',
          runtime: 'openclaw',
          entry: 'direct',
          target: source,
          evidence: { source },
          resultSchema: assessmentResultContextSchema,
          resultFormat: assessmentResultFormat,

          assessment: { skill: { path: '/fixture/SKILL.md' } },
        });
        await readAssessmentSource(input);
        const read = await response(input);
        assert.ok('toolCalls' in read && read.toolCalls?.[0]?.name === 'read');
        append(input, 'direct-assessment-skill', 'Complete selected method.');
        const rejected = await response(input);
        assert.ok('toolCalls' in rejected && rejected.toolCalls?.[0]);
        const malformed = JSON.parse(rejected.toolCalls[0].arguments);
        assert.equal(malformed.result.plan, undefined);
        const hostRequire = createRequire(
          createRequire(import.meta.url).resolve('openclaw/plugin-sdk/plugin-entry'),
        );
        const { validateToolArguments } = await import(
          hostRequire.resolve('@openclaw/ai/validation')
        );
        let diagnostic = '';
        assert.throws(
          () =>
            validateToolArguments(
              { name: 'agent_system_dispatch', parameters: dispatchModelParameters },
              { name: 'agent_system_dispatch', arguments: malformed },
            ),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            diagnostic = error.message;
            return true;
          },
        );
        append(input, 'direct-assessment-invalid', diagnostic);
        const corrected = await action(input, 'assessment');
        assert.equal(corrected.operation, 'render');
        assert.deepEqual(corrected, {
          ...malformed,
          result: { ...malformed.result, summary: 'Assess cleanup documentation only.' },
        });
        append(input, 'direct-assessment-result', {
          status: 'formatted',
          retained: false,
          presentation: 'Formatted complete assessment.',
        });
        assert.deepEqual(await response(input), { content: 'Formatted complete assessment.' });
      });

    if (scenario.id === 'openclaw-notifications-retirement')
      it('should scope helper spawning to the current native input', async () => {
        const input = request('Spawn retirement checkout helper at /managed/issue-checkout');
        const spawn = await response(input);
        assert.ok('toolCalls' in spawn && spawn.toolCalls?.length === 1);
        assert.equal(spawn.toolCalls[0]!.name, 'sessions_spawn');
        const args = JSON.parse(spawn.toolCalls[0]!.arguments);
        assert.equal(args.cwd, '/managed/issue-checkout');
        assert.equal(args.cleanup, 'keep');
        assert.equal(args.expectsCompletionMessage, false);
        input.messages.push({ role: 'user', content: args.task });
        const completed = await response(input);
        assert.ok('content' in completed && !('toolCalls' in completed));
      });

    if (scenario.id === 'openclaw-pr-journey')
      it('should report a retained provider obstacle without retrying it or losing the diagnostic to strict matching', async () => {
        const input = request(intakePrompt);
        append(input, 'scan', { status: 'ready' });
        append(input, 'next-0', {
          status: 'waiting',
          code: 'github-account-identity-failed',
          nextAction: 'next',
        });
        assert.equal((await action(input, 'next')).action, 'next');
        append(input, 'next-1', { status: 'waiting', code: 'github-account-identity-failed' });
        assert.equal((await action(input, 'report')).action, 'report');
        append(input, 'report', {
          status: 'reported',
          response: 'The account identity read failed.',
        });
        assert.deepEqual(await response(input), { content: 'The account identity read failed.' });
      });
    if (scenario.id === 'openclaw-issue-intake') {
      it('should release the current native receipt without an id in tool arguments', async () => {
        const input = request(
          'Agent System: assess this admitted issue and retain its complete plan.',
        );
        input.messages.unshift({
          role: 'user',
          content:
            'Agent System model-only current-turn facts (keep private):\n' +
            JSON.stringify({ receipt: 'old-receipt' }),
        });
        const released: string[] = [];
        const selected = createIntakeExampleScenario(async (receipt) => {
          released.push(receipt);
        });
        assert.deepEqual(await action(input, 'context', selected), {});
        assert.deepEqual(released, [id]);
      });
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
    }

    // these wrappers reuse the conversation driver; their distinct behavior is checked above.
    if (['openclaw-issue-intake', 'openclaw-notifications-retirement'].includes(scenario.id))
      return;

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
        target: source,
        id,
        digest,
        context: { source, body: 'disposable Agent System notification-flow fixture' },
      };
      const paths: Array<Array<[string, unknown]>> = [
        [],
        [['next', routing]],
        [['next', { status: 'assessment-required', id }]],
        [['next', { status: 'reconcile-required', target: source, id }]],
        [
          ['next', { status: 'reconcile-required', target: source, id }],
          ['reconcile', { status: 'session-created', id }],
        ],
      ];
      for (const path of paths) {
        const input = request(
          `Fill initially available intake slots in one bounded pass. Policy digest: ${digest}`,
        );
        append(input, 'scan', { status: 'ready' });
        for (const [stage, result] of path) append(input, stage, result);
        if (path.some(([, value]) => value === routing)) await readRoutingSource(input);
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
      if (scenario.id === 'openclaw-pr-journey')
        assert.throws(
          () => matchFixture([...scenario.fixtures], missing),
          /native hook must retain task facts/,
        );
      else assert.equal(matchFixture([...scenario.fixtures], missing), null);
    });

    if (!['openclaw-pr-journey', 'openclaw-issue-auto-plan'].includes(scenario.id))
      it('should consume fresh later evidence after recovery', async () => {
        const later = request('Initial assessment.');
        append(later, 'assessment-source', {
          exitCode: 0,
          truncated: false,
          stdout: JSON.stringify({ body: 'notification-hidden-initial-fact', comments: [] }),
        });
        later.messages.push({
          role: 'user',
          content: `Refresh native assessment for managed issue ${id}`,
        });
        assert.equal(matchFixture([...scenario.fixtures], later), null);
        later.messages.push({
          role: 'user',
          content:
            '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> Agent System model-only current-turn facts',
        });
        assert.equal('id' in (await action(later, 'context')), false);
        append(later, 'refresh-context', {
          status: 'verified',
          id,
          ...assessmentContract(),
          currentTurnId: 'native-refresh',
          evidence: {
            source: 'https://github.com/owner/repo/issues/3',
          },
        });
        const unchanged = structuredClone(later);
        await readAssessmentSource(unchanged, scenario, 'notification-hidden-initial-fact');
        assert.equal(matchFixture([...scenario.fixtures], unchanged), null);
        await publishNativePlan(later, scenario, false, 'notification-hidden-later-fact');
      });

    if (!hookAssessment)
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
              scenario.id === 'openclaw-issue-conversation'
                ? { skill: { name: 'generic-assessment', path: '/fixture/SKILL.md' } }
                : {},
            resultFormat: assessmentResultFormat,
          });
          if (scenario.id === 'openclaw-issue-conversation') {
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

    it('should format a native plan only after context and git verify its worktree', async () => {
      const input = request(
        `Agent System: assess this admitted issue and retain its complete plan. Call agent_system_dispatch with action context and id ${id}`,
      );
      if (!hookAssessment) assert.equal('id' in (await action(input, 'context')), false);
      const context = {
        status: 'verified',
        runtime: 'openclaw',
        ...assessmentContract(),
        id,
        currentTurnId: 'initial',
        evidence: { source: 'https://github.com/owner/repo/issues/3' },
        project: { path: '/tmp/managed-worktree' },
        assessment: {
          defaultSkill: scenario.id !== 'openclaw-issue-conversation',
          skill:
            scenario.id === 'openclaw-issue-conversation'
              ? { name: 'generic-assessment', path: '/fixture/SKILL.md' }
              : { path: '/fixture/SKILL.md' },
        },
        resultFormat: assessmentResultFormat,
      };
      append(input, 'context', context);
      if (scenario.id === 'openclaw-issue-conversation') {
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
      if (scenario.id === 'openclaw-pr-journey') {
        const read = await response(input);
        assert.ok('toolCalls' in read && read.toolCalls?.[0]?.name === 'read');
        append(input, 'assessment-skill', 'Default assessment.');
        await publishNativePlan(input);
        return;
      }
      await publishNativePlan(input);
      for (const value of [
        { ...context, runtime: 'codex' },
        { ...context, resultFormat: undefined },
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
        target: source,
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
        resultFormat: assessmentResultFormat,
      });
      append(invalid, 'git', { exitCode: 0, stdout: '/tmp/other', truncated: false });
      assert.equal(matchFixture([...scenario.fixtures], invalid), null);
    });
    if (scenario.id === 'openclaw-issue-auto-plan') {
      it('should ask an auto clarification in native chat without recording another assessment', async () => {
        const selected = resolveExampleModelScenario('openclaw-issue-auto-plan');
        const input = request(
          `Consider current plan for managed issue ${id}: decide whether to implement.`,
        );
        const question = await response(input, selected);
        assert.ok('content' in question && !('toolCalls' in question));
        assert.match(question.content!, /cleanup.*evidence/i);
        const followup = request(
          `Continue plan for managed issue ${id}: Implement the retained plan; ask about cleanup timing if needed. Do not push or publish a PR.`,
        );
        const context = await action(followup, 'implementation-context', selected);
        assert.equal('id' in context, false);
        assert.equal(context.scope, 'local');
      });
      for (const interrupted of [false, true])
        it(`should select auto work in native context with interruption ${interrupted}`, async () => {
          const selected = interrupted
            ? createProgressionScenario('interrupted-fixture', true)
            : scenario;
          const input = request(
            `Consider current plan for managed issue ${id}: decide whether to implement.`,
          );
          if (interrupted) {
            const first = await response(input, selected);
            assert.ok('content' in first && !('toolCalls' in first));
            input.messages[1]!.content += ' Resume the discussion.';
          }
          const context = await action(input, 'implementation-context', selected);
          assert.equal('id' in context, false);
          assert.equal(context.decision?.mode, 'work');
          assert.ok(context.decision?.reasons.length);
        });
      for (const direct of [false, true])
        it(`should ask clarification during automatic work and resume an answer with direct handoff ${direct}`, async () => {
          const automatic = request(
            direct
              ? `Consider current plan for managed issue ${id}: proceed with the bounded plan.`
              : `Continue this issue through implementation. Call agent_system_dispatch action implementation-context with id ${id}.`,
          );
          assert.equal((await action(automatic, 'implementation-context')).scope, undefined);
          await appendPagedContext(automatic, {
            id,
            plan: retainedPlan,
            status: 'verified',
            runtime: 'openclaw',
            publicationAuthorized: true,
            instructions: nativeTaskInstructions('openclaw'),
            project: { path: '/tmp/owned' },
          });
          const question = await response(automatic);
          assert.deepEqual(question, {
            content: 'Should cleanup happen after evidence is captured?',
          });
          const answer = request(
            `Answer for managed issue ${id}: Yes, after evidence is captured. Do not push or publish a PR.`,
          );
          const answerContext = await action(answer, 'implementation');
          assert.equal(answerContext.operation, 'context');
          assert.equal(answerContext.scope, 'local');
          await appendPagedContext(
            answer,
            {
              id,
              plan: retainedPlan,
              status: 'verified',
              runtime: 'openclaw',
              publicationAuthorized: false,
              project: { path: '/tmp/owned' },
            },
            { action: 'implementation', operation: 'context' },
          );
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
            status: 'native',
            presentation: 'Committed locally.',
            handoff: { next: 'delivery' },
          });
          assert.deepEqual(await response(answer), { content: 'Committed locally.' });
        });
    }
    if (scenario.id === 'openclaw-pr-journey') {
      it('should answer a post-delivery question through the native retained context without tools', async () => {
        const input = request(
          `Operator request for managed issue ${id}: Implement the retained plan and open a linked pull request.`,
        );
        input.messages[1]!.content +=
          '\nAgent System model-only current-turn facts (keep private):\n' +
          JSON.stringify({ receipt: id, worktree: '/checkout', stage: 'assessment' });
        append(input, 'delivery-present', {
          status: 'presented',
          presentation: 'Previous PR card.',
        });
        input.messages.push(
          { role: 'assistant', content: 'Previous PR card.' },
          { role: 'user', content: 'Explain the completed PR in this ordinary conversation.' },
        );
        const context = openclawTurnContext(
          {
            id,
            threadId: 'issue',
            worktree: '/checkout',
            request: { key: 'issue', agentId: 'receiver' },
            sessionCreation: { verified: true, sessionId: 'incarnation' },
            delivery: {
              reconciled: true,
              pullRequest: { pullRequestNumber: 7 },
              binding: { branch: 'retained-branch' },
            },
            work: {},
            nativeTurns: [{ role: 'assessment', turn: { runId: 'assessment' } }],
          } as OpenClawDispatchRecord,
          {
            runId: 'question',
            agentId: 'receiver',
            sessionKey: 'issue',
            sessionId: 'incarnation',
          },
        )!;
        const question = input.messages.at(-1)!;
        const prompt = question.content;
        question.content += '\n\n' + context.appendContext;
        input.messages.push({
          role: 'user',
          content:
            'OpenClaw runtime context:\nCurrent runtime facts.\nEnd OpenClaw runtime context.',
        });
        assert.deepEqual(await response(input), {
          content:
            'The linked PR contains the completed cleanup note. No further work was requested.',
        });
        input.messages[1]!.content += '\n' + context.appendContext;
        question.content = prompt;
        assert.throws(
          () => matchFixture([...scenario.fixtures], input),
          /native hook must retain task facts/,
        );
      });
      it('should not report delivery success from rejected or uncertain publication evidence', async () => {
        const input = request(
          `Operator request for managed issue ${id}: Add a follow-up commit and update the existing PR title and body.`,
        );
        supplyFacts(input, {
          stage: 'implementation',
          worktree: '/tmp/owned',
          branch: 'retained-branch',
          pullRequest: { pullRequestNumber: 456 },
        });
        for (const stage of ['apply', 'check', 'add', 'commit'])
          append(input, stage, { exitCode: 0, truncated: false, stdout: '' });
        append(input, 'delivery-prepare', { status: 'prepared' });
        append(input, 'delivery-repeat', { status: 'announced' });
        append(input, 'delivery-present', { status: 'presented', presentation: 'Published PR' });
        const published = structuredClone(input);
        append(published, 'delivery-publish', { status: 'published' });
        assert.deepEqual(await response(published), { content: 'Published PR' });

        const waiting = {
          status: 'waiting',
          code: 'github-delivery-head-not-observed',
          pullRequest: { pullRequestNodeId: 'PR_owned', pullRequestNumber: 456 },
        };
        for (const obstacle of [
          { ...waiting, status: 'blocked' },
          { ...waiting, code: 'github-delivery-binding-head-changed' },
        ]) {
          const rejected = structuredClone(input);
          append(rejected, 'delivery-publish', obstacle);
          const stopped = await response(rejected);
          assert.equal('toolCalls' in stopped, false);
          assert.ok('content' in stopped);
          assert.match(String(stopped.content), /notification-delivery-stopped/u);
          assert.match(String(stopped.content), new RegExp(obstacle.code, 'u'));
          assert.doesNotMatch(String(stopped.content), /Published PR/u);
        }
        const unbound = structuredClone(input);
        append(unbound, 'delivery-publish', { ...waiting, pullRequest: undefined });
        assert.equal(matchFixture([...scenario.fixtures], unbound), null);

        append(input, 'delivery-publish', waiting);
        assert.equal((await action(input, 'delivery')).operation, 'prepare');
        for (let index = 0; index < 3; index++) {
          append(input, `delivery-link-prepare-${index}`, { status: 'prepared' });
          append(input, `delivery-link-publish-${index}`, waiting);
        }
        assert.deepEqual(await response(input), {
          content:
            'notification-delivery-reconciliation-exhausted: github-delivery-head-not-observed',
        });
      });

      it('should stop when native authority rejects direct implementation context', async () => {
        const input = request(
          `Operator request for managed issue ${id}: Implement the retained plan and open a linked pull request.`,
        );
        append(input, 'work-context', { status: 'blocked', code: 'dispatch-operator-required' });
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
    if (scenario.id === 'openclaw-issue-conversation')
      it('should finish an already-current update without composing or publishing again', async () => {
        const input = request(`Check current status target: ${source}`);
        append(input, 'update-context', {
          status: 'status-update-context',
          composeRequest: {
            action: 'reply',
            operation: 'compose',
            purpose: 'status-update',
            target: source,
            update: { facts: [] },
          },
        });
        append(input, 'update-compose', {
          status: 'already-current',
          presentation: 'Already current.',
        });
        assert.deepEqual(await response(input), { content: 'Already current.' });
      });
    if (scenario.id === 'openclaw-issue-conversation')
      it('should select queued feedback by its received source before composing a source-bound reply', async () => {
        const input = request(`> Explain the plan. [Comment](${source}#issuecomment-42)`);
        const privateContext = openclawTurnContext(
          {
            id,
            threadId: 'issue',
            request: { key: 'issue', agentId: 'receiver' },
            sessionCreation: { verified: true, sessionId: 'incarnation' },
            feedback: {
              baseline: {},
              events: [
                {
                  id: 'f'.repeat(64),
                  number: 123,
                  itemType: 'issue',
                  source: JSON.stringify({ databaseId: 41 }),
                  turn: { runId: 'earlier-delivery' },
                },
                {
                  id: 'e'.repeat(64),
                  number: 123,
                  itemType: 'issue',
                  source: JSON.stringify({ databaseId: 42 }),
                  turn: { runId: 'delivery' },
                },
              ],
            },
          } as OpenClawDispatchRecord,
          {
            agentId: 'receiver',
            sessionKey: 'issue',
            sessionId: 'incarnation',
            runId: 'queued-feedback',
            repository: 'tanaabased/big-test-bucket',
          },
        )!;
        input.messages.push({
          role: 'user',
          content: 'OpenClaw runtime context:\n' + privateContext.appendContext,
        });
        assert.deepEqual(await action(input, 'feedback'), {
          action: 'feedback',
          operation: 'context',
          source: `${source}#issuecomment-42`,
        });
        append(input, 'feedback-context', {
          status: 'verified',
          runtime: 'openclaw',
          id,
          eventId: 'e'.repeat(64),
          publication: 'allowed',
          replyTarget: source,
        });
        const composed = await action(input, 'reply');
        assert.equal(composed.operation, 'compose');
        assert.equal(composed.target, source);
      });
    if (scenario.id === 'openclaw-pr-journey')
      it('should recheck the exact retained reply source and require confirmed publication', async () => {
        const input = request(
          `Publish retained reply: ${JSON.stringify({ target: source, publicText: 'Retained answer.' })}`,
        );
        const selectedScenario = prDiscoveryExampleScenario;
        for (const stage of ['feedback-resume-context', 'feedback-resume-context-repeat']) {
          const invalid = structuredClone(input);
          append(invalid, stage, { status: 'verified', replyTarget: source + '#issuecomment-999' });
          assert.throws(
            () => matchFixture([...selectedScenario.fixtures], invalid),
            assert.AssertionError,
          );
          const denied = structuredClone(input);
          append(denied, stage, { status: 'blocked', replyTarget: source });
          assert.throws(
            () => matchFixture([...selectedScenario.fixtures], denied),
            assert.AssertionError,
          );
          append(input, stage, { status: 'verified', replyTarget: source });
        }
        const publish = await action(input, 'reply', selectedScenario);
        assert.deepEqual(publish, {
          action: 'reply',
          operation: 'publish',
          target: source,
          publicText: 'Retained answer.',
        });
        for (const status of ['blocked', 'waiting']) {
          const unconfirmed = structuredClone(input);
          append(unconfirmed, 'feedback-publish', { status, presentation: 'Not confirmed' });
          assert.equal(matchFixture([...selectedScenario.fixtures], unconfirmed), null);
        }
        append(input, 'feedback-publish', { status: 'published', presentation: 'Confirmed reply' });
        assert.deepEqual(await response(input, selectedScenario), { content: 'Confirmed reply' });
      });
  });
}
