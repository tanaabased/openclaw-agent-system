import assert from 'node:assert/strict';

import openClawImportFailures from '../scripts/plugin-sdk-import-failures.ts';

describe('openclaw api policy', () => {
  it('should detect deprecated, private, unknown, dynamic, and re-exported imports', () => {
    const source = [
      "import { issueDeviceBootstrapToken, listDevicePairing, revokeDeviceBootstrapToken } from 'openclaw/plugin-sdk/device-bootstrap';",
      "import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';",
      "export { acquireFileLock } from 'openclaw/plugin-sdk/file-lock';",
      "export * from 'openclaw/plugin-sdk/config-types';",
      "const runtime = import('openclaw/plugin-sdk/agent-runtime');",
      "type Runtime = import('openclaw/plugin-sdk/types').PluginRuntime;",
      "import { redactSensitiveText } from 'openclaw/plugin-sdk/security-runtime';",
    ].join('\n');

    assert.deepEqual(openClawImportFailures(source, 'fixture.ts'), [
      { category: 'deprecated', specifier: 'openclaw/plugin-sdk/config-runtime' },
      { category: 'private', specifier: 'openclaw/plugin-sdk/file-lock' },
      { category: 'unsupported', specifier: 'openclaw/plugin-sdk/config-types' },
      { category: 'deprecated', specifier: 'openclaw/plugin-sdk/agent-runtime' },
      { category: 'private', specifier: 'openclaw/plugin-sdk/types' },
      { category: 'unsupported', specifier: 'openclaw/plugin-sdk/security-runtime' },
    ]);
  });

  it('should accept reviewed focused public imports', () => {
    const source = [
      "import { issueDeviceBootstrapToken, listDevicePairing, revokeDeviceBootstrapToken } from 'openclaw/plugin-sdk/device-bootstrap';",
      "import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';",
      "import { getGlobalHookRunner } from 'openclaw/plugin-sdk/plugin-runtime';",
      "import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';",
      "import { createAccountStatusSink } from 'openclaw/plugin-sdk/channel-outbound';",
      "import { redactSensitiveText } from 'openclaw/plugin-sdk/logging-core';",
      "import { createAgentToAgentPolicy, resolveSessionToolsVisibility } from 'openclaw/plugin-sdk/session-visibility';",
      "import { createClackPrompter } from 'openclaw/plugin-sdk/setup-runtime';",
      "import { resolveSecretRefValues } from 'openclaw/plugin-sdk/secret-ref-runtime';",
      "import { listSkillCommandsForWorkspace } from 'openclaw/plugin-sdk/skill-commands-runtime';",
    ].join('\n');

    assert.deepEqual(openClawImportFailures(source, 'fixture.ts'), []);
  });
});
