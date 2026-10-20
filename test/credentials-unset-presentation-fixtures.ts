import unsetCredentialsAgentSystem from '../cli/credentials-unset.ts';
import { createCliStyles } from '../cli/output.ts';
import type { CredentialUnsetResult } from '../credentials/op-manager.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import type { ManifestDiagnostic } from '../manifest/types.ts';

// illustrative results only; previews never read credentials or mutate host stores.
export const unsetAgentId = 'MixedCaseAgent';
export const unsetFixtures = {
  'one-store': { status: 'removed', storeIds: ['FileStore'], gatewayInvalidation: 'confirmed' },
  'all-stores': {
    status: 'removed',
    storeIds: ['Keychain', 'FileStore'],
    gatewayInvalidation: 'confirmed',
  },
  'one-missing': { status: 'missing', storeIds: ['FileStore'] },
  'all-missing': { status: 'missing', storeIds: ['Keychain', 'FileStore'] },
  'partial-removal': {
    status: 'removed',
    storeIds: ['FileStore'],
    unavailableStoreIds: ['Keychain'],
    gatewayInvalidation: 'confirmed',
  },
  'missing-unavailable': {
    status: 'missing',
    storeIds: ['FileStore'],
    unavailableStoreIds: ['Keychain'],
  },
  'pending-invalidation': {
    status: 'removed',
    storeIds: ['FileStore'],
    unavailableStoreIds: ['Keychain'],
    gatewayInvalidation: 'pending',
  },
  'unavailable-store': {
    status: 'invalid',
    code: 'credential-store-unavailable',
    message: 'External MixedCaseError: FileStore is unavailable.',
    gatewayInvalidation: 'confirmed',
  },
  'uncertain-mutation': {
    status: 'invalid',
    code: 'op-credential-mutation-uncertain',
    message:
      'External MixedCaseError: Inspect FileStore before retrying; mutation was not replayed.',
    gatewayInvalidation: 'pending',
  },
} as const;

export type UnsetPreview = keyof typeof unsetFixtures;

export async function captureUnsetPreview(
  preview: UnsetPreview,
  {
    environment = { NO_COLOR: '1' },
    terminalColumns = 120,
    diagnostics = [],
    credential = 'op',
    manifestFailure = false,
  }: {
    environment?: NodeJS.ProcessEnv;
    terminalColumns?: number;
    diagnostics?: ManifestDiagnostic[];
    credential?: string;
    manifestFailure?: boolean;
  } = {},
) {
  const fixture = unsetFixtures[preview];
  const result: CredentialUnsetResult =
    fixture.status === 'invalid'
      ? fixture
      : {
          agentId: unsetAgentId,
          ...fixture,
          storeIds: [...fixture.storeIds],
          unavailableStoreIds:
            'unavailableStoreIds' in fixture ? [...fixture.unavailableStoreIds] : [],
        };
  const loaded: AgentManifestLoadResult = manifestFailure
    ? {
        status: 'invalid',
        diagnostics,
        scope: { workspaceDir: '/IllustrativeWorkspace' },
        path: '/IllustrativeWorkspace/agent.yaml',
      }
    : {
        status: 'loaded',
        manifest: { schemaVersion: 1, agent: { id: unsetAgentId } },
        scope: { workspaceDir: '/IllustrativeWorkspace' },
        path: '/IllustrativeWorkspace/agent.yaml',
        digest: 'fixture',
        diagnostics,
        validationChecks: [],
      };
  const events: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  const mutations: Array<{ agentId: string; storeId?: string }> = [];
  const selections: string[] = [];
  let exitCode = 0;
  const storeId = ['one-store', 'one-missing', 'unavailable-store', 'uncertain-mutation'].includes(
    preview,
  )
    ? 'FileStore'
    : undefined;
  await unsetCredentialsAgentSystem({
    agentId: unsetAgentId,
    credential,
    storeId,
    credentialManager: {
      async unset(agentId, selectedStoreId) {
        mutations.push({ agentId, storeId: selectedStoreId });
        return result;
      },
    },
    manifestService: {
      async loadForAgentId(agentId) {
        selections.push(agentId);
        return loaded;
      },
      async loadForCommandDirectory(directory) {
        selections.push(directory);
        return loaded;
      },
    },
    output: {
      writeStdout: (text) => events.push({ stream: 'stdout', text }),
      writeStderr: (text) => events.push({ stream: 'stderr', text }),
    },
    setExitCode: (code) => {
      exitCode = code;
    },
    styles: createCliStyles(environment),
    terminalColumns,
    workspaceDir: '/IllustrativeWorkspace',
  });
  return {
    events,
    exitCode,
    mutations,
    selections,
    stdout: events
      .filter(({ stream }) => stream === 'stdout')
      .map(({ text }) => text)
      .join(''),
    stderr: events
      .filter(({ stream }) => stream === 'stderr')
      .map(({ text }) => text)
      .join(''),
  };
}
