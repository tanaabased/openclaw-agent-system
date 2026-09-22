import assert from 'node:assert/strict';

import SetupLifecycleService from '../agent/setup-lifecycle.ts';
import type SetupCommandService from '../agent/setup-command-service.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';
import { normalizeAgentSetup, type AgentSetupRuntime } from '../manifest/setup-schema.ts';

function context(value: unknown, runtime: AgentSetupRuntime = 'openclaw') {
  const normalized = normalizeAgentSetup(value);
  assert.equal(normalized.status, 'valid');
  return {
    runtime,
    manifest: { schemaVersion: 1 as const, agent: { id: 'emori' }, setup: normalized.setup },
    workspaceDir: '/workspace/emori',
  };
}

function fixture(results: Array<number | null | Error | 'timeout'>) {
  const calls: Array<{ command: unknown; target: unknown }> = [];
  const commands: Pick<SetupCommandService, 'run'> = {
    async run(command, target) {
      calls.push({ command, target });
      assert.ok(results.length, 'unexpected command');
      const result = results.shift();
      if (result instanceof Error) throw result;
      return {
        exitCode: result === 'timeout' ? 0 : (result ?? null),
        timedOut: result === 'timeout',
        truncated: false,
      };
    },
  };
  return { calls, service: new SetupLifecycleService(commands) };
}

describe('agent/setup-lifecycle', () => {
  for (const runtime of ['openclaw', 'codex'] as const) {
    it(`should filter ${runtime} checks and applies while retaining shared steps and order`, async () => {
      const other = runtime === 'openclaw' ? 'codex' : 'openclaw';
      const input = context(
        {
          steps: [
            { id: 'excluded', runtimes: [other], check: 'excluded check', apply: 'excluded apply' },
            { id: 'shared', check: 'shared check', apply: 'shared apply' },
            {
              id: 'selected',
              runtimes: [runtime],
              check: 'selected check',
              apply: 'selected apply',
            },
            { id: 'both', runtimes: ['codex', 'openclaw'], apply: 'both apply' },
            { id: 'excluded-unchecked', runtimes: [other], apply: 'excluded unchecked' },
          ],
        },
        runtime,
      );
      const inspection = fixture([0, 1]);
      const findings = await inspection.service.inspect(input);
      assert.deepEqual(
        findings.map(({ stepId, status }) => [stepId, status]),
        [
          ['excluded', 'skipped'],
          ['shared', 'healthy'],
          ['selected', 'drift'],
          ['both', 'manual'],
          ['excluded-unchecked', 'skipped'],
        ],
      );
      assert.ok(
        findings
          .filter(({ status }) => status === 'skipped')
          .every(
            ({ code, remediation }) => code === 'setup-not-applicable' && remediation === undefined,
          ),
      );
      const installation = fixture([1, 0, 0, 0, 0]);
      const result = await installation.service.reconcile(input);
      assert.deepEqual(
        result.outcomes.map(({ stepId, status }) => [stepId, status]),
        [
          ['excluded', 'skipped'],
          ['shared', 'updated'],
          ['selected', 'unchanged'],
          ['both', 'updated'],
          ['excluded-unchecked', 'skipped'],
        ],
      );
      assert.deepEqual(
        installation.calls.map(({ command }) => command),
        [
          input.manifest.setup.steps[1]!.check,
          input.manifest.setup.steps[1]!.apply,
          input.manifest.setup.steps[1]!.check,
          input.manifest.setup.steps[2]!.check,
          input.manifest.setup.steps[3]!.apply,
        ],
      );
    });

    it(`should avoid setup preparation and credential access when no steps match ${runtime}`, async () => {
      const input = context(
        {
          runtimes: [runtime === 'openclaw' ? 'codex' : 'openclaw'],
          check: 'private check',
          apply: 'private apply',
        },
        runtime,
      );
      let preparations = 0;
      let executions = 0;
      const service = new SetupLifecycleService({
        async prepare() {
          preparations++;
          throw new Error('unavailable credentials');
        },
        async run() {
          executions++;
          throw new Error('unavailable tool');
        },
      });
      const installed = await service.reconcile(input);
      const findings = await service.inspect(input);
      assert.equal(preparations, 0);
      assert.equal(executions, 0);
      assert.equal(installed.outcomes[0]?.status, 'skipped');
      assert.equal(installed.outcomes[0]?.code, 'setup-not-applicable');
      assert.deepEqual(findings, installed.outcomes);
      assert.deepEqual(installed.warnings, []);
      assert.doesNotMatch(JSON.stringify(installed), /private/u);
    });
  }

  it('should inspect every check, preserve step ids, and leave unchecked steps manual', async () => {
    const { service, calls } = fixture([0, 1, 2, null, 'timeout', new Error('private output')]);
    const input = context({
      steps: ['healthy', 'drift', 'failed', 'signal', 'timeout', 'unavailable', 'manual'].map(
        (id) => ({
          id,
          apply: `private apply ${id}`,
          ...(id === 'manual' ? {} : { check: `private check ${id}` }),
        }),
      ),
    });
    const findings = await service.inspect(input);
    assert.deepEqual(
      findings.map(({ stepId, status }) => [stepId, status]),
      [
        ['healthy', 'healthy'],
        ['drift', 'drift'],
        ['failed', 'blocked'],
        ['signal', 'blocked'],
        ['timeout', 'blocked'],
        ['unavailable', 'blocked'],
        ['manual', 'manual'],
      ],
    );
    assert.equal(calls.length, 6);
    assert.ok(
      calls.every(({ target }) => {
        assert.deepEqual(target, {
          agentId: 'emori',
          workspaceDir: input.workspaceDir,
          mode: 'check',
        });
        return true;
      }),
    );
    assert.doesNotMatch(JSON.stringify(findings), /private/u);
  });

  it('should skip healthy applies and apply then recheck drift in declaration order', async () => {
    const { service, calls } = fixture([0, 1, 0, 0, 0]);
    const input = context({
      steps: [
        { id: 'ready', check: 'ready check', apply: 'ready apply' },
        { id: 'drift', check: 'drift check', apply: 'drift apply' },
        { id: 'manual', apply: 'manual apply' },
      ],
    });
    const result = await service.reconcile(input);
    assert.deepEqual(
      calls.map(({ command }) => command),
      [
        input.manifest.setup.steps[0]!.check,
        input.manifest.setup.steps[1]!.check,
        input.manifest.setup.steps[1]!.apply,
        input.manifest.setup.steps[1]!.check,
        input.manifest.setup.steps[2]!.apply,
      ],
    );
    assert.deepEqual(
      result.outcomes.map(({ stepId, status }) => [stepId, status]),
      [
        ['ready', 'unchanged'],
        ['drift', 'updated'],
        ['manual', 'updated'],
      ],
    );
    assert.deepEqual(
      calls.map(({ target }) => (target as { mode: string }).mode),
      ['check', 'check', 'apply', 'check', 'apply'],
    );
  });

  it('should run unchecked applies on every install', async () => {
    const { service, calls } = fixture([0, 0]);
    const input = context('private script');
    for (let index = 0; index < 2; index++) {
      const result = await service.reconcile(input);
      assert.equal(result.outcomes[0]?.status, 'updated');
      assert.equal(result.outcomes[0]?.stepId, 'default');
      assert.doesNotMatch(JSON.stringify(result), /private script/u);
    }
    assert.equal(calls.length, 2);
  });

  for (const { name, results, code, count } of [
    { name: 'blocked check', results: [2], code: 'setup-check-blocked', count: 1 },
    { name: 'failed apply', results: [1, 1], code: 'setup-apply-failed', count: 2 },
    { name: 'timed out apply', results: [1, 'timeout'], code: 'setup-apply-failed', count: 2 },
    {
      name: 'unavailable apply',
      results: [1, new Error('private error')],
      code: 'setup-apply-failed',
      count: 2,
    },
    { name: 'nonconvergent apply', results: [1, 0, 1], code: 'setup-not-converged', count: 3 },
    { name: 'blocked recheck', results: [1, 0, 2], code: 'setup-check-blocked', count: 3 },
  ] as const) {
    it(`should stop later steps after a ${name}`, async () => {
      const { service, calls } = fixture([...results]);
      const input = context({
        steps: [
          { id: 'first', check: 'private check', apply: 'private apply' },
          { id: 'later', apply: 'must not run' },
        ],
      });
      await assert.rejects(service.reconcile(input), (error: unknown) => {
        assert.ok(error instanceof AgentSystemLifecycleError);
        assert.equal(error.component, 'setup');
        assert.equal(error.stepId, 'first');
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /private/u);
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(calls.length, count);
    });
  }
});
