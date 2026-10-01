import { valid } from 'semver';

export interface CodexPluginRequirement {
  spec: string;
  version: string;
  minimumHostVersion: string;
}

/** read only agent system's release-owned prerequisite, never workspace configuration. */
export default function codexPluginRequirement(metadata: {
  openclaw?: {
    agentSystem?: { codexPlugin?: string };
    compat?: { minGatewayVersion?: string };
  };
}): CodexPluginRequirement | undefined {
  const spec = metadata.openclaw?.agentSystem?.codexPlugin;
  const version =
    typeof spec === 'string' && spec.startsWith('@openclaw/codex@')
      ? spec.slice('@openclaw/codex@'.length)
      : undefined;
  const minimumHostVersion = metadata.openclaw?.compat?.minGatewayVersion;
  if (
    !version ||
    valid(version) !== version ||
    typeof minimumHostVersion !== 'string' ||
    valid(minimumHostVersion) !== minimumHostVersion
  )
    return undefined;
  return { spec: spec!, version, minimumHostVersion };
}
