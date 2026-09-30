import assert from 'node:assert/strict';
import { stringify } from 'yaml';

import automationContent from '../manifest/automation-content.ts';
import normalizeAutomations, { type ResolvedAutomation } from '../manifest/automation-schema.ts';
import parseAgentManifest from '../manifest/parse.ts';

function normalize(jobs: unknown): ResolvedAutomation[] {
  const result = normalizeAutomations(jobs);
  assert.equal(result.status, 'valid', JSON.stringify(result.diagnostics));
  if (result.status !== 'valid') throw new Error('Expected valid automations.');
  return result.automations as ResolvedAutomation[];
}
const base = { id: 'daily-review', schedule: 'every 1 hour' };

describe('manifest/automation-schema', () => {
  it('should normalize equivalent payloads and defaults without changing literal content', () => {
    const script = '  echo "$HOME"\n';
    assert.deepEqual(
      normalize([{ ...base, run: script }]),
      normalize([
        {
          ...base,
          enabled: true,
          runtimes: ['codex', 'openclaw'],
          payload: { kind: 'command', run: script, shell: 'sh' },
        },
      ]),
    );
    assert.deepEqual(
      normalize([{ ...base, run: ['gh', 'api', '', '$HOME', 'two words'] }]),
      normalize([
        {
          ...base,
          payload: {
            kind: 'command',
            run: { command: 'gh', args: ['api', '', '$HOME', 'two words'] },
          },
        },
      ]),
    );
    assert.deepEqual(
      normalize([{ ...base, prompt: script }]),
      normalize([{ ...base, payload: { kind: 'prompt', prompt: script } }]),
    );
    assert.equal(normalize([{ ...base, run: script }])[0]?.timeoutSeconds, undefined);
    assert.deepEqual(normalize([]), []);
  });

  it('should reject malformed declarations with redacted diagnostic paths', () => {
    for (const job of [
      { ...base },
      { ...base, run: 'true', prompt: 'secret-marker' },
      { ...base, run: 'true', payload: { kind: 'command', run: 'secret-marker' } },
      { ...base, prompt: 'hello', shell: 'bash' },
      { ...base, shell: 'bash', payload: { kind: 'command', run: 'true' } },
      { ...base, run: [] },
      { ...base, run: ['../escape'] },
      { ...base, run: { command: 'echo', 'timeout-seconds': 5 } },
      { ...base, run: '\0' },
      { ...base, prompt: '   ' },
      { ...base, prompt: { file: '' } },
      { ...base, run: 'true', overrides: { codex: { model: 'secret-marker' } } },
      { ...base, prompt: 'hello', runtimes: [] },
      { ...base, prompt: 'hello', runtimes: ['codex', 'codex'] },
      { ...base, prompt: 'hello', 'timeout-seconds': 3601 },
      { ...base, prompt: 'hello', 'timeout-seconds': 0 },
      { ...base, prompt: 'hello', id: 'Wrong_ID' },
      { ...base, prompt: 'hello', cwd: '/tmp' },
      { ...base, prompt: 'hello', overrides: { codex: { agent: 'secret-marker' } } },
    ]) {
      const result = normalizeAutomations([job]);
      assert.equal(result.status, 'invalid', JSON.stringify(job));
      assert.ok(result.diagnostics.length);
      assert.ok(result.diagnostics.every((item) => item.fieldPath?.startsWith('/automations')));
      assert.ok(!JSON.stringify(result.diagnostics).includes('secret-marker'));
    }
    assert.equal(
      normalizeAutomations([
        { ...base, run: 'true' },
        { ...base, prompt: 'hello' },
      ]).status,
      'invalid',
    );
  });

  it('should parse inline and external declarations without reading references', () => {
    for (const automations of [
      [],
      [{ ...base, prompt: { file: './missing.md' } }],
      { file: './missing.yaml' },
    ]) {
      assert.equal(
        parseAgentManifest(stringify({ 'schema-version': 1, agent: { id: 'test' }, automations }))
          .status,
        'valid',
      );
    }
    assert.equal(
      parseAgentManifest(
        'schema-version: 1\nagent: {id: test}\nautomations: {file: ./jobs.yaml, extra: true}',
      ).status,
      'invalid',
    );
    assert.equal(
      parseAgentManifest(
        'schema-version: 1\nagent: {id: test}\nautomations: [{id: test, prompt: hi}]',
      ).status,
      'invalid',
    );
  });

  it('should keep shared syntax independent of native runtime support', () => {
    const job = normalize([
      {
        ...base,
        run: ['node', 'task.mjs'],
        runtimes: ['codex'],
        schedule: 'in 1 hour',
        'timeout-seconds': 30,
      },
    ])[0]!;
    assert.equal(job.schedule.kind, 'in');
    assert.equal(automationContent(job, 'codex').content.timeoutSeconds, 30);
  });

  it('should preserve command content and argv order in effective hashes', () => {
    const first = normalize([{ ...base, run: ['echo', 'first', 'second'] }])[0]!;
    const reordered = normalize([{ ...base, run: ['echo', 'second', 'first'] }])[0]!;
    assert.notEqual(
      automationContent(first, 'openclaw').hash,
      automationContent(reordered, 'openclaw').hash,
    );
    const script = normalize([{ ...base, run: 'echo first\n' }])[0]!;
    const changed = normalize([{ ...base, run: 'echo second\n' }])[0]!;
    assert.notEqual(
      automationContent(script, 'openclaw').hash,
      automationContent(changed, 'openclaw').hash,
    );
    assert.equal(
      automationContent(script, 'openclaw').triggerHash,
      automationContent(changed, 'openclaw').triggerHash,
    );
  });

  it('should project only the selected runtime overrides and canonical defaults', () => {
    const job = normalize([
      {
        ...base,
        prompt: 'hello',
        overrides: {
          openclaw: { model: 'first' },
          codex: { model: 'second', target: { thread: 'existing' } },
        },
      },
    ])[0]!;
    const first = automationContent(job, 'openclaw');
    assert.equal(first.content.timeoutSeconds, 1800);
    assert.equal(automationContent(job, 'codex').content.timeoutSeconds, 'native');
    job.overrides.codex!.model = 'changed';
    assert.equal(automationContent(job, 'openclaw').hash, first.hash);
    job.overrides.openclaw!.model = 'changed';
    assert.notEqual(automationContent(job, 'openclaw').hash, first.hash);
    const implicit = normalize([{ ...base, prompt: 'hello' }])[0]!;
    const explicit = normalize([
      {
        ...base,
        prompt: 'hello',
        'timeout-seconds': 1800,
        overrides: { openclaw: { target: 'independent' } },
      },
    ])[0]!;
    assert.equal(
      automationContent(implicit, 'openclaw').hash,
      automationContent(explicit, 'openclaw').hash,
    );
    assert.notEqual(
      automationContent(implicit, 'codex', { model: 'first' }).hash,
      automationContent(implicit, 'codex', { model: 'second' }).hash,
    );
  });

  it('should change content hashes without rearming unchanged triggers', () => {
    const job = normalize([{ ...base, schedule: 'in 1 hour', prompt: 'first' }])[0]!;
    const original = automationContent(job, 'openclaw');
    for (const update of [
      { enabled: false },
      { timeoutSeconds: 42 },
      { payload: { kind: 'prompt' as const, prompt: 'second' } },
    ]) {
      const changed = automationContent({ ...job, ...update }, 'openclaw');
      assert.notEqual(changed.hash, original.hash);
      assert.equal(changed.triggerHash, original.triggerHash);
    }
    const equivalent = normalize([
      { ...base, schedule: { in: '60 minutes' }, prompt: 'first' },
    ])[0]!;
    assert.equal(automationContent(equivalent, 'openclaw').triggerHash, original.triggerHash);
    const changed = normalize([{ ...base, schedule: 'in 2 hours', prompt: 'first' }])[0]!;
    assert.notEqual(automationContent(changed, 'openclaw').triggerHash, original.triggerHash);
  });
});
