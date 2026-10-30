import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

describe('scripts/assert-automation-report', () => {
  const expected = { status: 'delivered', 'effective.model': 'aimock/gpt-5.5' };
  const check = (reports: unknown[], fields = expected) =>
    spawnSync(
      'jq',
      [
        '-e',
        '--argjson',
        'expected',
        JSON.stringify(fields),
        '-f',
        'scripts/assert-automation-report.jq',
      ],
      {
        input: JSON.stringify({ reports }),
        encoding: 'utf8',
      },
    );

  it('should require every expected field on the same report', () => {
    assert.equal(
      check([{ status: 'delivered', effective: { model: 'aimock/gpt-5.5' } }]).status,
      0,
    );
    const result = check([
      { status: 'delivered', effective: { model: 'other/model' } },
      { status: 'pending', effective: { model: 'aimock/gpt-5.5' } },
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /failedFields.*effective.model/);
    assert.match(result.stderr, /failedFields.*status/);
    assert.notEqual(check([]).status, 0);
  });

  it('should bound diagnostics and omit streams and unexpected values', () => {
    const result = check(
      Array.from({ length: 20 }, () => ({
        status: 'pending',
        code: 'automation-report-unavailable',
        reason: 'private-value',
        effective: { model: 'private-value' },
        stdout: 'private-value',
        messageId: 'private-value',
      })),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /automation-report-unavailable/);
    assert.match(result.stderr, /"reportCount":20/);
    assert.equal(result.stderr.includes('private-value'), false);
    assert.ok(result.stderr.length < 2500);
  });
});
