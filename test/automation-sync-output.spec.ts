import assert from 'node:assert/strict';

import ansis from 'ansis';
import stringWidth from 'fast-string-width';

import type { AutomationError } from '../agent/automation-gateway.ts';
import { createCliStyles } from '../cli/output.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';
import {
  captureSyncFixture,
  syncFixtureAgent,
  syncFixtureNames,
  syncFixtureWorkspace,
} from './automation-sync-presentation-fixtures.ts';

const stream = (
  events: Awaited<ReturnType<typeof captureSyncFixture>>['events'],
  name: 'stdout' | 'stderr',
) =>
  events
    .filter(({ stream }) => stream === name)
    .map(({ text }) => text)
    .join('');
const compact = (text: string) => ansis.strip(text).replace(/\s/gu, '');

describe('cli/automation-sync presentation', () => {
  it('should retain operation order and resolved scope with padded lifecycle rows', async () => {
    const { events, result, calls, exitCode } = await captureSyncFixture('changes');
    assert.ok(!(result instanceof Error));
    assert.deepEqual(calls, [
      { agentId: syncFixtureAgent, workspaceDir: syncFixtureWorkspace, options: undefined },
    ]);
    assert.equal(exitCode, 0);
    const text = stream(events, 'stdout');
    assert.match(text, /agent +Agent-MixedCase/u);
    assert.match(text, /runtime +openclaw/u);
    assert.match(text, /sync +synchronized/u);
    assert.ok(text.startsWith('\n') && text.endsWith('\n\n'));
    assert.ok(text.includes('\nworkspace  ' + syncFixtureWorkspace + '\n'));
    const rows = text.split('\n').filter((line) => line.startsWith('automations/'));
    assert.deepEqual(
      rows.map((row) => row.trim().split(/\s+/u).slice(0, 2)),
      [
        ['automations/Review-MixedCase', 'created'],
        ['automations/Paused-Review', 'updated'],
        ['automations/Retired-Review', 'unchanged'],
      ],
    );
    assert.ok(text.includes('\n\nautomations/Paused-Review'));
    assert.equal(stream(events, 'stderr'), '');
    for (const { message } of result.outcomes) assert.ok(compact(text).includes(compact(message)));
  });

  it('should distinguish quiet unchanged and skipped work, empty alignment, and attention', async () => {
    const styles = createCliStyles({ FORCE_COLOR: '3' });
    const unchanged = await captureSyncFixture('unchanged', { color: true, columns: 240 });
    assert.ok(!(unchanged.result instanceof Error));
    const text = stream(unchanged.events, 'stdout');
    for (const { message } of unchanged.result.outcomes)
      assert.ok(text.includes(styles.field(message)));
    assert.ok(text.includes(styles.field('skipped')));
    const empty = await captureSyncFixture('empty');
    assert.match(stream(empty.events, 'stdout'), /automations +unchanged +.*already aligned/u);
    assert.equal(empty.exitCode, 0);
    const drift = await captureSyncFixture('drift-repaired');
    assert.match(stream(drift.events, 'stdout'), /automations\/Paused-Review +updated/u);
    const attention = await captureSyncFixture('attention');
    assert.match(stream(attention.events, 'stdout'), /sync +attention/u);
    assert.ok(stream(attention.events, 'stderr').includes('automation-requires-operator-sync'));
    // warnings do not alter the existing synchronized result or successful exit.
    assert.equal(attention.exitCode, 0);
  });

  it('should show completed and reported pending progress before one sorted messages section', async () => {
    const { events, result, exitCode } = await captureSyncFixture('partial-failure', {
      warnings: true,
    });
    assert.ok(result instanceof AgentSystemLifecycleError);
    assert.equal(exitCode, 1);
    assert.equal(events.at(-1)?.stream, 'stderr');
    assert.ok(events.slice(0, -1).every(({ stream }) => stream === 'stdout'));
    const primary = stream(events, 'stdout');
    const messages = stream(events, 'stderr');
    assert.match(primary, /Review-MixedCase[\s\S]*Paused-Review[\s\S]*automations +pending/u);
    assert.equal(
      primary.split('\n').filter((line) => /^automations +pending/u.test(line)).length,
      1,
    );
    assert.ok(!primary.includes('Retired-Review'));
    assert.ok(!primary.includes('automation-gateway-unavailable'));
    assert.equal(messages.match(/\nmessages\n/gu)?.length, 1);
    assert.ok(messages.indexOf('error') < messages.indexOf('warning'));
    assert.equal(messages.includes('ℹ info'), false);
    assert.equal(messages.match(/✖ error/gu)?.length, 1);
    for (const outcome of result.progress!.outcomes) assert.ok(!messages.includes(outcome.message));
    assert.ok(messages.includes('completed changes remain applied'));
    assert.ok(messages.includes('automation-gateway-unavailable'));
    assert.ok(messages.includes('automation-requires-operator-sync'));
    assert.ok(messages.includes('External Warning: MixedCase.yaml is shadowed.'));
    assert.ok(messages.includes('rerunning openclaw agent-system automations sync'));
    assert.equal(messages.match(/gateway diagnostic/gu)?.length, 1);
  });

  it('should keep unavailable gateway and unstructured failures fatal without exposing raw errors', async () => {
    for (const name of ['unavailable-gateway', 'failed'] as const) {
      const { events, exitCode } = await captureSyncFixture(name, { warnings: true });
      assert.equal(exitCode, 1);
      assert.match(stream(events, 'stdout'), /sync +failed/u);
      assert.match(
        stream(events, 'stdout'),
        name === 'failed' ? /automations +blocked/u : /automations +pending/u,
      );
      assert.equal(events.at(-1)?.stream, 'stderr');
      assert.ok(!events.some(({ text }) => /PrivateToken|PrivateHost/u.test(text)));
      if (name === 'unavailable-gateway') {
        assert.ok(stream(events, 'stderr').includes('automation-gateway-unavailable'));
        assert.ok(stream(events, 'stderr').includes('restore gateway connectivity'));
      }
    }
  });

  it('should preserve literal data and layout across narrow, colored, and no-color previews', async () => {
    for (const name of syncFixtureNames) {
      for (const columns of [40, 120]) {
        const plain = await captureSyncFixture(name, { columns, warnings: true });
        const color = await captureSyncFixture(name, { columns, color: true, warnings: true });
        assert.deepEqual(
          color.events.map(({ stream, text }) => ({ stream, text: ansis.strip(text) })),
          plain.events,
        );
        assert.ok(
          plain.events.every(({ text }) =>
            text.split('\n').every((line) => stringWidth(line) <= columns),
          ),
        );
        assert.ok(compact(stream(plain.events, 'stdout')).includes(syncFixtureAgent));
        assert.ok(compact(stream(plain.events, 'stdout')).includes(syncFixtureWorkspace));
        if (!(plain.result instanceof Error)) {
          for (const { stepId, message } of plain.result.outcomes) {
            assert.ok(compact(stream(plain.events, 'stdout')).includes(stepId!));
            assert.ok(compact(stream(plain.events, 'stdout')).includes(compact(message)));
          }
        }
        assert.ok(!plain.events.some(({ text }) => /PrivateToken|PrivateHost/u.test(text)));
      }
    }
  });

  it('should preserve exact json envelopes, plain machine diagnostics, and strict sync forwarding', async () => {
    for (const name of syncFixtureNames) {
      const { events, result, calls, exitCode } = await captureSyncFixture(name, {
        json: true,
        color: true,
        warnings: true,
      });
      assert.deepEqual(calls, [
        { agentId: syncFixtureAgent, workspaceDir: syncFixtureWorkspace, options: undefined },
      ]);
      const expected =
        result instanceof AgentSystemLifecycleError
          ? {
              status: 'failed',
              code: result.code,
              diagnostic: (result.cause as AutomationError).diagnostic,
              progress: result.progress,
            }
          : result instanceof Error
            ? { status: 'failed', code: 'automation-operation-failed' }
            : { runtime: 'openclaw', status: 'synchronized', ...result };
      assert.deepEqual(JSON.parse(stream(events, 'stdout')), expected);
      const messages = stream(events, 'stderr');
      const manifestWarning =
        'manifest: External Warning: MixedCase.yaml is shadowed. code=manifest-shadowed\n';
      if (!(result instanceof Error)) assert.equal(messages, manifestWarning);
      else {
        const code =
          result instanceof AgentSystemLifecycleError ? result.code : 'automation-operation-failed';
        const progress = result instanceof AgentSystemLifecycleError ? result.progress : undefined;
        const diagnostic =
          result instanceof AgentSystemLifecycleError
            ? (result.cause as AutomationError).diagnostic
            : undefined;
        assert.equal(
          messages,
          manifestWarning +
            (result instanceof AgentSystemLifecycleError
              ? `automations: automation operation stopped. code=${code}\n`
              : `automations: operation failed; upstream details withheld. cause=unknown code=${code}\n`) +
            (progress
              ? `partial progress: completed=${progress.outcomes.length} warnings=${progress.warnings.length} unattempted=${progress.unattempted.length}; ${progress.outcomes.length > 0 ? 'completed changes remain applied' : 'no completed changes reported'}; the stopped operation may have partial effects.\n`
              : '') +
            (diagnostic ? `gateway diagnostic: ${JSON.stringify(diagnostic)}\n` : '') +
            (code === 'automation-gateway-unavailable'
              ? 'restore gateway connectivity before rerunning openclaw agent-system automations sync.\n'
              : 'resolve the reported cause before rerunning openclaw agent-system automations sync.\n'),
        );
      }
      assert.equal(exitCode, result instanceof Error ? 1 : 0);
      assert.ok(
        events.every(
          ({ text }) =>
            !text.includes('\u001b') &&
            !text.includes('messages') &&
            !/PrivateToken|PrivateHost/u.test(text),
        ),
      );
    }
  });
});
