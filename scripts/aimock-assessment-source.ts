import assert from 'node:assert/strict';
import type { FixtureResponse } from '@copilotkit/aimock';

export default function assessmentSource(
  context: Record<string, unknown>,
  result: (stage: string) => Record<string, unknown> | undefined,
  call: (stage: string, name: string, input: Record<string, unknown>) => FixtureResponse,
  stage = 'assessment-source',
): FixtureResponse | undefined {
  const target = (context.evidence as { source?: string })?.source;
  assert.ok(target);
  const read = result(stage);
  if (!read)
    return call(stage, 'agent_system_github', {
      argv: [
        target.includes('/pull/') ? 'pr' : 'issue',
        'view',
        target,
        '--json',
        'title,body,comments',
      ],
    });
  assert.equal(read.exitCode, 0);
  assert.equal(read.truncated, false);
  const issue = JSON.parse(String(read.stdout));
  assert.equal(typeof issue.body, 'string');
  assert.ok(issue.body.length > 0);
  assert.ok(Array.isArray(issue.comments));
}
