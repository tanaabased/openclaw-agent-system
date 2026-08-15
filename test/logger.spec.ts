import assert from 'node:assert/strict';

import { formatDiagnostic, reportManifestDiagnostics } from '../lib/logger.ts';

function createLogger() {
  const records = {
    debug: [] as string[],
    error: [] as string[],
    info: [] as string[],
    warn: [] as string[],
  };
  return {
    logger: {
      debug: (message: string) => records.debug.push(message),
      error: (message: string) => records.error.push(message),
      info: (message: string) => records.info.push(message),
      warn: (message: string) => records.warn.push(message),
    },
    records,
  };
}

describe('lib/logger', () => {
  it('should format diagnostic identity as metadata instead of another namespace', () => {
    assert.equal(
      formatDiagnostic({
        code: 'op-credential-missing',
        component: 'credentials',
        message: 'An OP credential is required.',
      }),
      'credentials: An OP credential is required. code=op-credential-missing',
    );
  });

  it('should route manifest diagnostics through their original levels', () => {
    const test = createLogger();

    reportManifestDiagnostics(
      {
        status: 'invalid',
        scope: { workspaceDir: '/workspace' },
        diagnostics: [
          {
            code: 'manifest-schema',
            fieldPath: '/agent/id',
            message: 'Manifest value does not match the schema.',
            severity: 'error',
          },
          {
            code: 'manifest-shadowed',
            message: 'A shorthand manifest is shadowed.',
            severity: 'warning',
          },
        ],
      },
      test.logger,
    );

    assert.deepEqual(test.records.error, [
      'manifest: Manifest value does not match the schema. code=manifest-schema field=/agent/id',
    ]);
    assert.deepEqual(test.records.warn, [
      'manifest: A shorthand manifest is shadowed. code=manifest-shadowed',
    ]);
  });
});
