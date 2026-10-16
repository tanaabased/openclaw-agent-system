import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { matchFixture, type ChatCompletionRequest } from '@copilotkit/aimock';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { notificationExampleScenario as scenario } from '../examples/openclaw-notifications/model-fixture.ts';
import parseAgentManifest from '../manifest/parse.ts';
import { dispatchParameters } from '../tools/dispatch/tool-schema.ts';
import { intakeParameters } from '../tools/intake/tool-schema.ts';

const id = 'a'.repeat(64);
const digest = 'b'.repeat(64);
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
    tool_call_id: `call_notifications_${stage}_fc-native`,
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
    const input = request(`Advance at most one issue per run. Policy digest: ${digest}`);
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
    assert.deepEqual(await response(input), { content: 'notification-intake-advanced' });
    input.messages.push({
      role: 'user',
      content: `Advance at most one issue per run. Policy digest: ${digest}`,
    });
    await action(input, 'scan');
  });

  it('should reconcile pending assessments and stop on native idle without fabricating work', async () => {
    for (const status of ['idle', 'reconcile-required']) {
      const input = request(`Advance at most one issue per run. Policy digest: ${digest}`);
      append(input, 'scan', { status: 'ready', admitted: 0 });
      append(input, 'next', { status, id });
      if (status === 'reconcile-required') {
        assert.equal((await action(input, 'reconcile')).id, id);
        append(input, 'reconcile', { status: 'assessment-completed', id });
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
      const input = request(`Advance at most one issue per run. Policy digest: ${digest}`);
      append(input, 'scan', { status: 'ready' });
      for (const [stage, result] of path) append(input, stage, result);
      const pending = await response(input);
      assert.ok('toolCalls' in pending && pending.toolCalls?.length === 1);
      const stage = JSON.parse(pending.toolCalls[0]!.arguments).action;
      append(input, stage, { status: 'busy', code: 'private-state-file-lock-busy', id });
      assert.deepEqual(await response(input), { content: 'notification-intake-busy' });
      input.messages.push({
        role: 'user',
        content: `Advance at most one issue per run. Policy digest: ${digest}`,
      });
      await action(input, 'scan');
    }
    const invalid = request(`Advance at most one issue per run. Policy digest: ${digest}`);
    append(invalid, 'scan', { status: 'ready' });
    append(invalid, 'next', { status: 'busy', code: 'unexpected-failure' });
    assert.equal(matchFixture([...scenario.fixtures], invalid), null);
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
    const scan = request(`Advance at most one issue per run. Policy digest: ${digest}`);
    append(scan, 'scan', { status: 'blocked' });
    assert.equal(matchFixture([...scenario.fixtures], scan), null);
    const unrelated = request(`Advance at most one issue per run. Policy digest: ${digest}`);
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
});
