import assert from 'node:assert/strict';

import ansis from 'ansis';
import stringWidth from 'fast-string-width';

import {
  captureStatusFixture,
  statusFixtureAgent,
  statusFixtureNames,
  statusFixtureRepository,
  statusFixtureSelector,
} from './github-notification-status-fixtures.ts';

const compact = (text: string) => ansis.strip(text).replace(/\s/gu, '');

describe('channels/github/cli/status', () => {
  it('should show effective scope and agent-wide capacity without stretching summary columns', async () => {
    const all = await captureStatusFixture('healthy');
    assert.equal(all.exitCode, 0);
    assert.deepEqual(all.calls, [[statusFixtureAgent, undefined]]);
    assert.match(all.events[0]!.text, /agent {2,}Agent-MixedCase/u);
    assert.match(all.events[0]!.text, /\nitems\n\n/u);
    assert.match(all.events[0]!.text, /scope {2,}all items/u);
    assert.match(all.events[0]!.text, /capacity {2,}agent-wide active=1 queued=1 limit=2/u);
    const selected = await captureStatusFixture('filtered');
    assert.deepEqual(selected.calls, [[statusFixtureAgent, statusFixtureSelector]]);
    const text = selected.events[0]!.text;
    assert.match(
      text,
      /scope\s+issue MixedCaseOwner\/Long-Notification-Repository-With-MixedCase#12/u,
    );
    assert.match(text, /agent-wide active=0 queued=1 limit=2/u);
    assert.ok(!text.includes('tanaabased/example'));
    assert.ok(!text.includes('OtherOwner'));
    const missing = await captureStatusFixture('healthy', {
      selector: { ...statusFixtureSelector, number: 999 },
    });
    assert.match(missing.events[0]!.text, /no matching items/u);
    assert.match(missing.events[0]!.text, /agent-wide active=1 queued=1 limit=2/u);
    const empty = await captureStatusFixture('empty');
    assert.match(empty.events[0]!.text, /no items/u);
  });

  it('should separate waiting and cleanup detail and emphasize failures without coloring recovery prose', async () => {
    const degraded = await captureStatusFixture('degraded', { color: true });
    const stdout = degraded.events[0]!.text;
    assert.match(ansis.strip(stdout), /\nwaiting\s+github-notification-WaitReason-MixedCase/u);
    assert.match(ansis.strip(stdout), /\nfailure\s+github-notification-intake-failed/u);
    assert.ok(stdout.includes('\u001b[31mfailure'));
    assert.ok(stdout.includes('\u001b[31mdegraded'));
    assert.ok(stdout.includes('\u001b[33mwaiting'));
    assert.ok(!stdout.includes('check repository write access'));
    const cleanup = await captureStatusFixture('cleanup', { color: true });
    const text = compact(cleanup.events[0]!.text);
    for (const literal of [
      'session=archived',
      'cleanup-worktree=dirty',
      'cleanup-reason=github-notification-cleanup-worktree-dirty',
      'session=failed',
      'cleanup-worktree=failed',
      'session=missing',
      'cleanup-worktree=not-applicable',
    ])
      assert.ok(text.includes(literal));
    assert.ok(cleanup.events[0]!.text.includes('\u001b[33mcleanup'));
    assert.ok(cleanup.events[0]!.text.includes('\u001b[31mcleanup'));
    assert.equal(cleanup.exitCode, 0);
  });

  it('should collect one trailing severity-sorted messages section and retain machine diagnostics', async () => {
    const human = await captureStatusFixture('degraded');
    assert.equal(human.exitCode, 1);
    assert.deepEqual(
      human.events.map(({ stream }) => stream),
      ['stdout', 'stderr'],
    );
    const stderr = human.events[1]!.text;
    assert.equal(stderr.match(/\nmessages\n/gu)?.length, 1);
    assert.ok(stderr.indexOf('error') < stderr.indexOf('warning'));
    assert.equal(stderr.match(/check repository write access and retry refresh/gu)?.length, 1);
    assert.ok(stderr.includes('External Warning: MixedCase.yaml'));
    const machine = await captureStatusFixture('degraded', { json: true, color: true });
    assert.equal(
      machine.events[1]!.text,
      'manifest: External Warning: MixedCase.yaml is shadowed. code=manifest-shadowed\n',
    );
    assert.equal(machine.exitCode, 1);
  });

  it('should keep color previews equivalent at narrow and wide widths with complete literal data and redaction', async () => {
    for (const name of statusFixtureNames) {
      for (const columns of [40, 120]) {
        const plain = await captureStatusFixture(name, { columns });
        const color = await captureStatusFixture(name, { columns, color: true });
        assert.deepEqual(
          color.events.map(({ stream, text }) => ({ stream, text: ansis.strip(text) })),
          plain.events,
        );
        for (const { text } of plain.events) {
          assert.ok(text.split('\n').every((line) => stringWidth(line) <= columns));
          assert.ok(!text.includes('PrivateBranch') && !text.includes('/Private/'));
        }
        const text = compact(plain.events[0]!.text);
        assert.ok(text.includes(statusFixtureAgent));
        if (!['empty', 'pending'].includes(name))
          assert.ok(text.includes(`${statusFixtureRepository}#12`));
        assert.ok(plain.events[0]!.text.startsWith('\n') && plain.events[0]!.text.endsWith('\n\n'));
      }
    }
  });

  it('should preserve exact redacted json fields and exits independently of human presentation', async () => {
    for (const name of statusFixtureNames) {
      const { events, exitCode } = await captureStatusFixture(name, { json: true, color: true });
      assert.equal(exitCode, name === 'degraded' ? 1 : 0);
      assert.ok(events.every(({ text }) => !text.includes('\u001b') && !text.includes('messages')));
      const result = JSON.parse(events[0]!.text);
      assert.equal(result.schemaVersion, 2);
      assert.equal(result.agentId, statusFixtureAgent);
      assert.equal(
        result.status,
        name === 'degraded' ? 'degraded' : name === 'pending' ? 'pending' : 'ready',
      );
      assert.ok(
        !JSON.stringify(result).includes('PrivateBranch') &&
          !JSON.stringify(result).includes('/Private/'),
      );
      if (name === 'filtered') {
        assert.deepEqual(result.items, [
          {
            disposition: 'approved',
            failureCode: 'github-notification-intake-failed',
            itemType: 'issue',
            lifecycleId: 'issue',
            number: 12,
            reasonCode: 'assignment-approved',
            repository: statusFixtureRepository,
            scheduling: 'waiting',
            stage: 'prepared',
            waitingReason: 'github-notification-WaitReason-MixedCase',
            worktree: 'ready',
          },
        ]);
        assert.deepEqual(result.capacity, { active: 0, queued: 1, limit: 2 });
        assert.equal(result.itemFailures, undefined);
      }
      if (name === 'degraded') assert.equal(result.itemFailures.length, 2);
      if (name === 'cleanup')
        assert.deepEqual(result.items[0].cleanup, {
          reasonCode: 'github-notification-cleanup-worktree-dirty',
          session: 'archived',
          status: 'skipped',
          worktree: 'dirty',
        });
      if (name === 'healthy')
        assert.deepEqual(result.items[1].pullRequest, {
          baseRef: 'main',
          draft: false,
          headRef: 'notification-pr',
          headSha: 'a'.repeat(40),
        });
    }
  });

  it('should preserve option and manifest early failures with no status inspection', async () => {
    for (const json of [false, true]) {
      const invalid = await captureStatusFixture('healthy', {
        json,
        itemKind: 'invalid',
        color: true,
      });
      assert.equal(invalid.exitCode, 2);
      assert.deepEqual(invalid.calls, []);
      assert.deepEqual(
        invalid.events.map(({ stream }) => stream),
        ['stderr'],
      );
      assert.ok(invalid.events[0]!.text.includes('github-notification-status-options-invalid'));
      if (json) assert.ok(!invalid.events[0]!.text.includes('messages'));
      const unmanaged = await captureStatusFixture('healthy', {
        json,
        manifestStatus: 'unmanaged',
      });
      assert.equal(unmanaged.exitCode, 1);
      assert.deepEqual(unmanaged.calls, []);
      assert.deepEqual(
        unmanaged.events.map(({ stream }) => stream),
        ['stderr'],
      );
      assert.ok(unmanaged.events[0]!.text.includes('/Fixture/Workspace'));
    }
  });
});
