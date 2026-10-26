import { satisfies } from 'semver';

import metadata from '../package.json' with { type: 'json' };

export class CodexNodeVersionError extends Error {
  readonly code = 'codex-node-version-unsupported';

  constructor(version: string) {
    super(
      `Node.js ${version} is unsupported; this plugin requires ${metadata.engines.node}. Select a compatible node on the configured host PATH and retry; no automation rewrite is needed.`,
    );
  }
}

/** check the executing runtime before accessing installation or workflow state. */
export default function assertCodexNodeVersion(version = process.versions.node): void {
  if (!satisfies(version, metadata.engines.node)) throw new CodexNodeVersionError(version);
}
