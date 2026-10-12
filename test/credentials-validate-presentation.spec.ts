import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { captureCredentialValidationPreview } from './credentials-validate-presentation-fixtures.ts';

describe('cli/credentials-validate presentation', () => {
  it('should match fixture-backed previews for each validation outcome', async () => {
    const previews = ['illustrative fixture data; credentials and resource values are redacted\n'];
    for (const scenario of ['success', 'source', 'conflict', 'failure', 'invalidation'] as const) {
      const { events, exitCode } = await captureCredentialValidationPreview(scenario);
      previews.push(`## ${scenario} (exit ${exitCode})\n`);
      for (const { stream, text } of events) previews.push(`[${stream}]\n${text}`);
    }
    assert.equal(
      previews.join('\n'),
      await readFile(
        new URL('./credentials-validate-command-previews.txt', import.meta.url),
        'utf8',
      ),
    );
  });

  it('should keep invalidation trouble separate from validation failure and preserve redaction', async () => {
    const { events, exitCode } = await captureCredentialValidationPreview('invalidation');
    assert.equal(exitCode, 1);
    assert.deepEqual(
      events.map(({ stream }) => stream),
      ['stderr'],
    );
    const output = events.map(({ text }) => text).join('');
    assert.match(
      output,
      /error[\s\S]*op-credential-invalid[\s\S]*warning[\s\S]*credentials-gateway-invalidation-pending/u,
    );
    assert.match(output, /value=\[redacted\]/u);
    assert.doesNotMatch(output, /synthetic-secret-value/u);
  });

  it('should preserve the environment variable name and avoid implying a stored credential', async () => {
    const { events } = await captureCredentialValidationPreview('failure');
    const output = events.map(({ text }) => text).join('');
    assert.match(output, /OP_SERVICE_ACCOUNT_TOKEN/u);
    const source = await captureCredentialValidationPreview('source');
    assert.match(source.events.map(({ text }) => text).join(''), /source\s+process-environment/u);
    assert.doesNotMatch(source.events.map(({ text }) => text).join(''), /store\s/u);
  });
});
