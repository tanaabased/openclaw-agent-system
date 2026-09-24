import { Value } from 'typebox/value';

import {
  inspectModelRouting,
  projectRoutingProfile,
  resolveModelRouting,
  RoutingError,
} from './model-routing.ts';
import type { AgentModelsConfiguration } from '../manifest/models-schema.ts';
import { modelRoutingRequestSchema } from '../tools/model-routing/tool-schema.ts';

/** runtime bindings supply the profiles; task context can never choose a workspace. */
export default function resolveModelRoutingRequest(
  models: AgentModelsConfiguration | undefined,
  manifestDigest: string,
  request: unknown,
  runtime: 'codex' | 'openclaw',
) {
  if (!Value.Check(modelRoutingRequestSchema, request)) {
    throw new RoutingError(
      'model-routing-request-invalid',
      'Supply inspect or a bounded resolve request. Unknown fields are rejected.',
    );
  }
  if (request.action === 'inspect')
    return { ...inspectModelRouting(models, runtime), manifestDigest };
  if (request.manifestDigest !== manifestDigest) {
    throw new RoutingError(
      'model-routing-manifest-changed',
      'The bound profiles changed. Inspect them and reassess before resolving.',
    );
  }
  if (!models)
    return { status: 'unavailable' as const, code: 'model-routing-not-configured', manifestDigest };
  const overrides =
    request.overrides?.model && runtime === 'codex' && !request.overrides.model.includes('/')
      ? { ...request.overrides, model: `openai/${request.overrides.model}` }
      : request.overrides;
  const decision = resolveModelRouting(models, request.assessment, { ...request, overrides });
  if (overrides?.model || overrides?.effort) {
    const explicit = projectRoutingProfile(
      {
        model: overrides.model ?? decision.selection?.model ?? models.default.model,
        effort: overrides.effort ?? decision.selection?.effort ?? models.default.effort,
      },
      runtime,
    );
    if (
      explicit.status === 'unsupported' &&
      (overrides.model || explicit.code === 'codex-model-effort-unsupported')
    )
      throw new RoutingError(explicit.code, explicit.message);
  }
  const candidate = decision.selection
    ? projectRoutingProfile(decision.selection, runtime)
    : undefined;
  if (candidate?.status === 'unsupported')
    throw new RoutingError(candidate.code, candidate.message);
  return {
    ...decision,
    manifestDigest,
    ...(candidate ? { candidate } : {}),
    application: 'not-requested' as const,
    execution: 'unverified' as const,
  };
}
