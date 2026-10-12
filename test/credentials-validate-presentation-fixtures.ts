import validateCredentialsAgentSystem from '../cli/credentials-validate.ts';
import { createCliStyles } from '../cli/output.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

const manifest: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
  status: 'loaded',
  scope: { workspaceDir: '/fixture/agent' },
  path: '/fixture/agent/agent.yaml',
  digest: 'fixture',
  manifest: {
    schemaVersion: 1,
    agent: { id: 'fixture-agent' },
    environment: { op: ['OP_SERVICE_ACCOUNT_TOKEN'] },
  },
  diagnostics: [],
  validationChecks: [],
};

export async function captureCredentialValidationPreview(
  scenario: 'success' | 'source' | 'conflict' | 'failure' | 'invalidation',
) {
  const events: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  let exitCode = 0;
  await validateCredentialsAgentSystem({
    credential: 'op',
    fromEnvironment: scenario === 'source' || scenario === 'conflict',
    ...(scenario === 'conflict' ? { storeId: 'fixture-store' } : {}),
    credentialManager: {
      async validate() {
        if (scenario === 'failure' || scenario === 'invalidation') {
          return {
            status: 'invalid' as const,
            code: 'op-credential-invalid',
            message: 'OP_SERVICE_ACCOUNT_TOKEN could not be validated; value=[redacted]',
            ...(scenario === 'invalidation' ? { gatewayInvalidation: 'pending' as const } : {}),
          };
        }
        return {
          status: 'valid' as const,
          agentId: 'fixture-agent',
          environmentCount: 1,
          secretCount: 2,
          source: scenario === 'source' ? 'process-environment' : 'store:fixture-store',
        };
      },
    } as never,
    manifestService: {
      loadForAgentId: async () => manifest,
      loadForCommandDirectory: async () => manifest,
    } as never,
    output: {
      writeStdout: (text) => events.push({ stream: 'stdout', text }),
      writeStderr: (text) => events.push({ stream: 'stderr', text }),
    },
    setExitCode: (code) => {
      exitCode = code;
    },
    styles: createCliStyles({ NO_COLOR: '1' }),
    terminalColumns: 80,
    workspaceDir: '/fixture/agent',
  });
  return { events, exitCode };
}
