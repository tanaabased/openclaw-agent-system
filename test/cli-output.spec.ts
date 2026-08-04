import assert from 'node:assert/strict';

import { reportManifestDiagnostics, reportManifestFailure } from '../lib/cli-output.ts';
import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';

function createOutput() {
  const error: string[] = [];
  const write: string[] = [];
  return {
    error,
    output: {
      error: (message: string) => error.push(message),
      write: (message: string) => write.push(message),
    },
    write,
  };
}

describe('lib/cli-output', () => {
  it('should format manifest diagnostics with severity, code, field, and message', () => {
    const result: AgentManifestLoadResult = {
      status: 'invalid',
      scope: { workspaceDir: '/workspace' },
      path: '/workspace/agent.yaml',
      diagnostics: [
        {
          code: 'manifest-schema',
          fieldPath: '/agent/id',
          message: 'Manifest value does not match the schema.',
          severity: 'error',
        },
      ],
    };
    const { error, output } = createOutput();

    reportManifestDiagnostics(result, output);

    assert.deepEqual(error, [
      'error: [manifest-schema] (/agent/id) Manifest value does not match the schema.\n',
    ]);
  });

  it('should report an unmanaged workspace', () => {
    const { error, output } = createOutput();

    reportManifestFailure(
      { status: 'unmanaged', scope: { workspaceDir: '/workspace' }, diagnostics: [] },
      output,
    );

    assert.deepEqual(error, ['error: no Agent System manifest found in /workspace\n']);
  });

  it('should report an invalid manifest before its diagnostics', () => {
    const { error, output } = createOutput();

    reportManifestFailure(
      {
        status: 'invalid',
        scope: { workspaceDir: '/workspace' },
        path: '/workspace/agent.yaml',
        diagnostics: [
          { code: 'manifest-read', message: 'Manifest could not be read.', severity: 'error' },
        ],
      },
      output,
    );

    assert.deepEqual(error, [
      'error: invalid Agent System manifest at /workspace/agent.yaml\n',
      'error: [manifest-read] Manifest could not be read.\n',
    ]);
  });

  it('should report an unresolved agent workspace before its diagnostics', () => {
    const { error, output } = createOutput();

    reportManifestFailure(
      {
        status: 'unresolved',
        diagnostics: [
          {
            code: 'agent-workspace-resolution',
            message: 'The workspace could not be resolved.',
            severity: 'error',
          },
        ],
      },
      output,
    );

    assert.deepEqual(error, [
      'error: an OpenClaw agent workspace could not be resolved\n',
      'error: [agent-workspace-resolution] The workspace could not be resolved.\n',
    ]);
  });
});
