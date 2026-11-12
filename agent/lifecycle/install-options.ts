export interface InstallSetupOptions {
  skipSetup?: boolean;
  skipSetupHost?: boolean;
  skipSetupAgent?: boolean;
}

export function selectedSetupPhases(options: InstallSetupOptions): {
  skipSetupHost: boolean;
  skipSetupAgent: boolean;
} {
  return {
    skipSetupHost: options.skipSetup === true || options.skipSetupHost === true,
    skipSetupAgent: options.skipSetup === true || options.skipSetupAgent === true,
  };
}
