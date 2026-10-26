import { homedir } from 'node:os';
import { join } from 'node:path';

import codexAssessmentSkill from './codex-assessment-skill.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import { inspectCodexWorkspaceBinding } from './codex-workspace-binding.ts';
import { RoutingError } from './model-routing.ts';
import initialModelRouting from './initial-model-routing.ts';

/** use portable binding, guidance, and native skill discovery without OpenClaw credentials. */
export default async function codexModelRouting(
  pluginData: string,
  request: unknown,
  dependencies: {
    connect?: typeof connectCodexThreads;
    codexHome?: string;
  } = {},
) {
  const inspection = await inspectCodexWorkspaceBinding(pluginData);
  if (inspection.status === 'unbound')
    return { status: 'unavailable' as const, code: 'codex-workspace-unbound' };
  if (inspection.status === 'invalid') throw new RoutingError(inspection.code, inspection.message);
  if (inspection.preview.status !== 'ready')
    throw new RoutingError(inspection.preview.code, inspection.preview.message);
  const loaded = inspection.preview.manifest;
  if (loaded.status === 'unmanaged')
    return { status: 'unavailable' as const, code: 'manifest-missing' };
  if (loaded.status !== 'loaded')
    throw new RoutingError('manifest-invalid', 'The bound workspace manifest is invalid.');
  return initialModelRouting({
    models: loaded.manifest.models,
    manifestDigest: loaded.digest,
    request,
    runtime: 'codex',
    workspace: inspection.preview.workspaceDir,
    resolveSkill: async (id) => {
      const connection = await (dependencies.connect ?? connectCodexThreads)(
        inspection.preview.workspaceDir,
        dependencies.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      );
      try {
        return await codexAssessmentSkill(connection.request, inspection.preview.workspaceDir, id);
      } finally {
        await connection.close();
      }
    },
  });
}
