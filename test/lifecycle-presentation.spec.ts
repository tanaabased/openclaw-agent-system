import assert from 'node:assert/strict';

import lifecyclePresentationLines, {
  lifecycleTableLines,
  orderDoctorFindings,
} from '../core/lifecycle-presentation.ts';
import { doctorFindings, installOutcomes } from './lifecycle-presentation-fixtures.ts';

describe('core/lifecycle-presentation', () => {
  it('should present non-applicable setup quietly without recommending repair', () => {
    const skipped = {
      component: 'setup',
      stepId: 'codex-only',
      code: 'setup-not-applicable',
      status: 'skipped' as const,
      message: 'Setup step codex-only does not apply to openclaw.',
    };
    assert.deepEqual(lifecycleTableLines([skipped]), [
      {
        attention: false,
        quiet: true,
        component: 'setup',
        label: 'skipped',
        style: 'field',
        value: skipped.message,
      },
    ]);
    const ordered = orderDoctorFindings([skipped, ...doctorFindings]);
    assert.ok(ordered.indexOf(skipped) > ordered.findIndex(({ status }) => status === 'drift'));
  });

  it('should assign attention and quiet roles without reordering lifecycle items', () => {
    const items = [...doctorFindings, ...installOutcomes];
    const lines = lifecycleTableLines(items);
    assert.deepEqual(
      lines.map(({ label }) => label),
      items.map(({ status }) => status),
    );
    assert.deepEqual(
      lines.filter(({ attention }) => attention).map(({ label }) => label),
      ['warning', 'blocked', 'manual', 'drift', 'blocked'],
    );
    assert.deepEqual(
      lines.filter(({ quiet }) => quiet).map(({ label }) => label),
      ['healthy', 'healthy', 'unchanged', 'unchanged'],
    );
  });

  it('should stably group a display copy while preserving the original findings', () => {
    const original = structuredClone(doctorFindings);
    const findings = Object.freeze(structuredClone(doctorFindings));
    assert.deepEqual(
      orderDoctorFindings(findings).map(({ code }) => code),
      [
        'git-blocked',
        'github-blocked',
        'security-warning',
        'notifications-manual',
        'path-drift',
        'agent-ready',
        'access-ready',
      ],
    );
    assert.deepEqual(findings, original);
  });

  it('should map lifecycle statuses to semantic summary styles', () => {
    const statuses = [
      'blocked',
      'created',
      'drift',
      'healthy',
      'manual',
      'removed',
      'unchanged',
      'updated',
      'valid',
      'warning',
    ] as const;

    assert.deepEqual(
      lifecyclePresentationLines(
        statuses.map((status) => ({ component: 'github', message: status, status })),
      ).map(({ style }) => style),
      [
        'error',
        'action',
        'warning',
        'status',
        'field',
        'action',
        'status',
        'action',
        'status',
        'warning',
      ],
    );
  });
});
