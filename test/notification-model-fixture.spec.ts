import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import waitForAssessmentRelease from '../examples/openclaw-notifications/assessment-barrier.ts';

import { matchFixture, type ChatCompletionRequest } from '@copilotkit/aimock';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { notificationExampleScenario as scenario } from '../examples/openclaw-notifications/model-fixture.ts';
import openclawIntakeJobs from '../agent/openclaw-intake-policy.ts';
import { intakeFixture } from './github-intake-fixture.ts';
import parseAgentManifest from '../manifest/parse.ts';
import { dispatchParameters } from '../tools/dispatch/tool-schema.ts';
import { intakeParameters } from '../tools/intake/tool-schema.ts';

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
const digest = /Policy digest: ([a-f0-9]{64})/u.exec(intakePrompt)![1]!;
const source = 'https://github.com/tanaabased/big-test-bucket/issues/123';

function request(prompt: string): ChatCompletionRequest {
  return {
    model: 'gpt-5.5',
    messages: [
      { role: 'system', content: 'Name: Notification Tanaabot' },
      { role: 'user', content: prompt },
    ],
    tools: ['agent_system_intake', 'agent_system_dispatch', 'agent_system_git'].map((name) => ({
      type: 'function',
      function: { name },
    })),
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
  return typeof fixture.response === 'function' ? await fixture.response(input) : fixture.response;
}

type Action = Static<typeof dispatchParameters> | { action: 'scan'; policyDigest: string };

async function action<A extends Action['action']>(input: ChatCompletionRequest, expected: A) {
  const next = await response(input);
  assert.ok('toolCalls' in next && next.toolCalls?.length === 1);
  const call = next.toolCalls[0]!;
  const args = JSON.parse(call.arguments);
  assert.equal(args.action, expected);
  assert.ok(
    Value.Check(call.name === 'agent_system_intake' ? intakeParameters : dispatchParameters, args),
  );
  return args as Extract<Action, { action: A }>;
}

describe('examples/openclaw-notifications model fixture', () => {
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

  it('should declare native planning with unavailable feedback and reviews for capability isolation', async () => {
    const parsed = parseAgentManifest(
      await readFile('examples/openclaw-notifications/tanaabot/agent.yaml', 'utf8'),
    );
    assert.equal(parsed.status, 'valid');
    assert.equal(parsed.manifest?.github?.notifications?.schemaVersion, 2);
    assert.deepEqual(parsed.manifest?.github?.notifications?.runtimes, ['openclaw']);
    assert.equal(parsed.manifest?.github?.notifications?.issueAssignment?.mode, 'plan');
    assert.equal(parsed.manifest?.github?.notifications?.issueAssignment?.feedback, true);
    assert.equal(parsed.manifest?.github?.notifications?.reviewRequest?.enabled, true);
    assert.equal(parsed.manifest?.models?.default.model, 'aimock/gpt-5.5');
    assert.equal(parsed.manifest?.github?.username, 'tanaabot');
    assert.equal(parsed.manifest?.github?.token, 'GH_TOKEN_TANAABOT');
    assert.deepEqual(
      parsed.manifest?.github?.notifications?.issueAssignment?.allowed?.map(
        ({ login, nodeId }) => ({ login, nodeId }),
      ),
      [{ login: 'emoriwan', nodeId: '__ACTOR_NODE_ID__' }],
    );
    const actor = parseAgentManifest(
      await readFile('examples/openclaw-notifications/emori/agent.yaml', 'utf8'),
    );
    assert.equal(actor.status, 'valid');
    assert.equal(actor.manifest?.github?.username, 'emoriwan');
    assert.equal(actor.manifest?.github?.token, 'GH_TOKEN_EMORI');
    assert.equal(actor.manifest?.github?.notifications, undefined);
  });

  it('should carry native scan and routing receipts through preparation and assessment', async () => {
    const input = request(intakePrompt);
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
    assert.deepEqual(await response(input), { content: 'notification-intake-pass-completed' });
    input.messages.push({
      role: 'user',
      content: intakePrompt,
    });
    await action(input, 'scan');
  });

  it('should reconcile pending assessments and stop on native idle without fabricating work', async () => {
    for (const status of ['idle', 'reconcile-required']) {
      const input = request(intakePrompt);
      append(input, 'scan', { status: 'ready', admitted: 0 });
      append(input, 'next', { status, id });
      if (status === 'reconcile-required') {
        assert.equal((await action(input, 'reconcile')).id, id);
        append(input, 'reconcile', { status: 'assessment-completed', id });
        await action(input, 'next');
        append(input, 'next-1', { status: 'pass-completed' });
      }
      const final = await response(input);
      assert.ok('content' in final);
    }
  });

  it('should stop on journal contention and let a later coordinator turn scan again', async () => {
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
      const input = request(intakePrompt);
      append(input, 'scan', { status: 'ready' });
      for (const [stage, result] of path) append(input, stage, result);
      const pending = await response(input);
      assert.ok('toolCalls' in pending && pending.toolCalls?.length === 1);
      const stage = JSON.parse(pending.toolCalls[0]!.arguments).action;
      append(input, stage, { status: 'busy', code: 'private-state-file-lock-busy', id });
      assert.deepEqual(await response(input), { content: 'notification-intake-busy' });
      input.messages.push({
        role: 'user',
        content: intakePrompt,
      });
      await action(input, 'scan');
    }
    const invalid = request(intakePrompt);
    append(invalid, 'scan', { status: 'ready' });
    append(invalid, 'next', { status: 'busy', code: 'unexpected-failure' });
    assert.equal(matchFixture([...scenario.fixtures], invalid), null);
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
    assert.deepEqual(await response(input), { content: 'notification-intake-pass-completed' });
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
      assert.deepEqual(await response(input), { content: 'notification-intake-at-capacity' });
    }
  });

  it('should retain a plan only after native context and git verify its worktree', async () => {
    const input = request(
      `Stop before implementation. Call agent_system_dispatch with action context and id ${id}`,
    );
    assert.equal((await action(input, 'context')).id, id);
    const context = {
      status: 'verified',
      runtime: 'openclaw',
      id,
      project: { path: '/tmp/managed-worktree' },
      assessment: { skill: {} },
      resultContract: 'assessment-result/v1',
    };
    append(input, 'context', context);
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
    append(input, 'result', {
      status: 'recorded',
      presentation: 'The complete retained presentation.',
    });
    assert.deepEqual(await response(input), { content: 'The complete retained presentation.' });
    for (const value of [
      { ...context, runtime: 'codex' },
      { ...context, id: 'c'.repeat(64) },
      { ...context, status: 'blocked' },
    ]) {
      const invalid = request(
        `Stop before implementation. Call agent_system_dispatch with action context and id ${id}`,
      );
      append(invalid, 'context', value);
      assert.equal(matchFixture([...scenario.fixtures], invalid), null);
    }
  });

  it('should reject failed scans unrelated issues and an execution outside the verified worktree', async () => {
    const scan = request(intakePrompt);
    append(scan, 'scan', { status: 'blocked' });
    assert.deepEqual(await response(scan), { content: 'notification-intake-blocked' });
    const unrelated = request(intakePrompt);
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
      `Stop before implementation. Call agent_system_dispatch with action context and id ${id}`,
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
  it('should wait for native handoff before implementation and use the same delivery for an operator retry', async () => {
    const input = request(
      `Operator request for managed issue ${id}: Implement the retained plan and open a linked pull request.`,
    );
    assert.equal((await action(input, 'handoff')).permission, 'implementation-and-publication');
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
    append(input, 'work-result', { status: 'recorded' });
    assert.equal((await action(input, 'delivery')).operation, 'prepare');
    append(input, 'delivery-prepare', { status: 'prepared', digest });
    assert.equal((await action(input, 'delivery')).digest, digest);
    append(input, 'delivery-publish', { status: 'published' });
    assert.equal((await action(input, 'delivery')).operation, 'reconcile');
    append(input, 'delivery-reconcile', { status: 'ready' });
    assert.equal((await action(input, 'delivery')).operation, 'present');
    append(input, 'delivery-present', { status: 'presented', presentation: '> PR card' });
    assert.deepEqual(await response(input), { content: '> PR card' });
    const retry = request(
      `Operator request for managed issue ${id}: Reconcile the existing PR and show its card again.`,
    );
    assert.equal((await action(retry, 'delivery')).operation, 'prepare');
  });

  it('should stop when native authority rejects the operator handoff', async () => {
    const input = request(
      `Operator request for managed issue ${id}: Implement the retained plan and open a linked pull request.`,
    );
    append(input, 'handoff-preview', { status: 'blocked', code: 'dispatch-operator-required' });
    assert.equal(matchFixture([...scenario.fixtures], input), null);
  });
});
