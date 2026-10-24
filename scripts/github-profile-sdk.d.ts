// The public JS entry omits declarations; reuse the host's matching command contract.
declare module 'openclaw/plugin-sdk/process-runtime' {
  import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

  export const runCommandWithTimeout: OpenClawPluginApi['runtime']['system']['runCommandWithTimeout'];
}
