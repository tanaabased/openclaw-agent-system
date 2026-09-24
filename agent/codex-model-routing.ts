import { inspectCodexWorkspaceBinding } from './codex-workspace-binding.ts';
import { RoutingError } from './model-routing.ts';
import resolveModelRoutingRequest from './model-routing-request.ts';

/** inspect only the persisted codex binding and non-secret manifest profiles. */
export default async function codexModelRouting(pluginData: string, request: unknown) {
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
  return resolveModelRoutingRequest(loaded.manifest.models, loaded.digest, request, 'codex');
}
