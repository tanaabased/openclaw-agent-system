import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { matchFixture, type ChatCompletionRequest } from '@copilotkit/aimock';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { issueExampleScenario } from '../examples/openclaw-issue/model-fixture.ts';
import { prExampleScenario } from '../examples/openclaw-pr/model-fixture.ts';
import parseAgentManifest from '../manifest/parse.ts';
import { dispatchParameters } from '../tools/dispatch/tool-schema.ts';
import { intakeParameters } from '../tools/intake/tool-schema.ts';

for (const scenario of [issueExampleScenario, prExampleScenario]) {
  const issueOnly = scenario.id === 'openclaw-issue';
  const owner = issueOnly ? 'emori' : 'tanaabot';
  const ownerLogin = issueOnly ? 'emoriwan' : 'tanaabot';
  const actorFolder = issueOnly ? 'tanaabot' : 'emori';
  const actorLogin = issueOnly ? 'tanaabot' : 'emoriwan';
  const id = 'a'.repeat(64);
  const digest = 'b'.repeat(64);
  const source = 'https://github.com/tanaabased/big-test-bucket/issues/123';

  function request(prompt: string): ChatCompletionRequest {
    return {
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: `Name: Notification ${issueOnly ? 'EMORI' : 'Tanaabot'}` },
        { role: 'user', content: prompt },
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
      tool_call_id: `call_notifications_${stage}_fc-native`,
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

  describe(`examples/${scenario.id} model fixture`, () => {
    it('should declare native planning with feedback and unavailable reviews for capability isolation', async () => {
      const parsed = parseAgentManifest(
        await readFile(`examples/${scenario.id}/${owner}/agent.yaml`, 'utf8'),
      );
      assert.equal(parsed.status, 'valid');
      assert.equal(parsed.manifest?.github?.notifications?.schemaVersion, 2);
      assert.deepEqual(parsed.manifest?.github?.notifications?.runtimes, ['openclaw']);
      assert.equal(parsed.manifest?.github?.notifications?.issueAssignment?.mode, 'plan');
      assert.equal(parsed.manifest?.github?.notifications?.issueAssignment?.feedback, true);
      assert.equal(parsed.manifest?.github?.notifications?.reviewRequest?.enabled, true);
      assert.equal(parsed.manifest?.models?.default.model, 'aimock/gpt-5.5');
      assert.equal(parsed.manifest?.github?.username, ownerLogin);
      assert.equal(
        parsed.manifest?.github?.token,
        issueOnly ? 'GH_TOKEN_EMORI' : 'GH_TOKEN_TANAABOT',
      );
      assert.deepEqual(
        parsed.manifest?.github?.notifications?.issueAssignment?.allowed?.map(
          ({ login, nodeId }) => ({ login, nodeId }),
        ),
        [{ login: actorLogin, nodeId: '__ACTOR_NODE_ID__' }],
      );
      const actor = parseAgentManifest(
        await readFile(`examples/${scenario.id}/${actorFolder}/agent.yaml`, 'utf8'),
      );
      assert.equal(actor.status, 'valid');
      assert.equal(actor.manifest?.github?.username, actorLogin);
      assert.equal(
        actor.manifest?.github?.token,
        issueOnly ? 'GH_TOKEN_TANAABOT' : 'GH_TOKEN_EMORI',
      );
      assert.equal(actor.manifest?.github?.notifications, undefined);
    });

    it('should carry native scan and routing receipts through preparation and assessment', async () => {
      const input = request(
        `Advance at most one new issue or feedback turn per run. Policy digest: ${digest}`,
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
      assert.deepEqual(await response(input), { content: 'notification-intake-advanced' });
      input.messages.push({
        role: 'user',
        content: `Advance at most one new issue or feedback turn per run. Policy digest: ${digest}`,
      });
      await action(input, 'scan');
    });

    it('should reconcile pending assessments and stop on native idle without fabricating work', async () => {
      for (const status of ['idle', 'reconcile-required']) {
        const input = request(
          `Advance at most one new issue or feedback turn per run. Policy digest: ${digest}`,
        );
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
        const input = request(
          `Advance at most one new issue or feedback turn per run. Policy digest: ${digest}`,
        );
        append(input, 'scan', { status: 'ready' });
        for (const [stage, result] of path) append(input, stage, result);
        const pending = await response(input);
        assert.ok('toolCalls' in pending && pending.toolCalls?.length === 1);
        const stage = JSON.parse(pending.toolCalls[0]!.arguments).action;
        append(input, stage, { status: 'busy', code: 'private-state-file-lock-busy', id });
        assert.deepEqual(await response(input), { content: 'notification-intake-busy' });
        input.messages.push({
          role: 'user',
          content: `Advance at most one new issue or feedback turn per run. Policy digest: ${digest}`,
        });
        await action(input, 'scan');
      }
      const invalid = request(
        `Advance at most one new issue or feedback turn per run. Policy digest: ${digest}`,
      );
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
      const scan = request(
        `Advance at most one new issue or feedback turn per run. Policy digest: ${digest}`,
      );
      append(scan, 'scan', { status: 'blocked' });
      assert.equal(matchFixture([...scenario.fixtures], scan), null);
      const unrelated = request(
        `Advance at most one new issue or feedback turn per run. Policy digest: ${digest}`,
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
    if (scenario.id === 'openclaw-pr') {
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
    } else {
      it('should refuse implementation in the issue-only fixture', () => {
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
    it('should keep feedback private retention skill selection candidate and publication as distinct stages', async () => {
      const eventId = 'e'.repeat(64);
      const input = request(
        `Call agent_system_dispatch with action feedback, operation context, id ${id}, eventId ${eventId}`,
      );
      assert.equal((await action(input, 'feedback')).operation, 'context');
      append(input, 'feedback-context', {
        status: 'verified',
        runtime: 'openclaw',
        publication: 'allowed',
      });
      const retained = await action(input, 'feedback');
      assert.equal(retained.operation, 'result');
      if (scenario.id === 'openclaw-issue')
        assert.match(retained.privateText!, /implementation remains unstarted/);
      append(input, 'feedback-result', {
        status: 'recorded',
        presentation: 'Full private response',
      });
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
      if (scenario.id === 'openclaw-issue')
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
