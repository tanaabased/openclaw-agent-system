import assert from 'node:assert/strict';

import {
  createAgentSystemLogger,
  formatDiagnostic,
  reportManifestDiagnostics,
} from '../lib/logger.ts';

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
  it('should derive one namespace from the plugin id and preserve log levels', () => {
    const test = createLogger();
    const logger = createAgentSystemLogger(test.logger, 'agent-system');

    logger.debug?.('manifest_absent');
    logger.info('manifest_loaded');
    logger.warn('manifest_shadowed');
    logger.error('manifest_invalid');

    assert.deepEqual(test.records, {
      debug: ['[agent-system] manifest_absent'],
      error: ['[agent-system] manifest_invalid'],
      info: ['[agent-system] manifest_loaded'],
      warn: ['[agent-system] manifest_shadowed'],
    });
  });

  it('should remove one leading openclaw prefix and avoid a repeated namespace', () => {
    const test = createLogger();
    const logger = createAgentSystemLogger(test.logger, 'openclaw-devguard');

    logger.info('ready');
    logger.info('[devguard] already attributed');

    assert.deepEqual(test.records.info, ['[devguard] ready', '[devguard] already attributed']);
  });

  it('should omit the namespace when the host already attributes the plugin', () => {
    const test = createLogger();
    const logger = createAgentSystemLogger(test.logger, 'agent-system', {
      hostAttributed: true,
    });

    logger.info('manifest_loaded');

    assert.deepEqual(test.records.info, ['manifest_loaded']);
  });

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
