export type ModelRuntimeAuthStatus = 'indeterminate' | 'missing' | 'usable';

export type ModelRuntimeStatusIssue =
  | {
      kind: 'incompatible' | 'indeterminate';
      message: string;
      model: string;
      provider: string;
    }
  | {
      authRequirement: string;
      kind: 'missing-auth';
      message: string;
      model: string;
      provider: string;
    };

export type ModelRuntimeStatusRoute = {
  authStatus?: ModelRuntimeAuthStatus;
  provider: string;
  runtime: string;
  runtimeDetail?: string;
  status: ModelRuntimeAuthStatus | 'unavailable';
};

export interface ModelRuntimeStatusSnapshot {
  issues: ModelRuntimeStatusIssue[];
  routes: ModelRuntimeStatusRoute[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAuthStatus(value: unknown): value is ModelRuntimeAuthStatus {
  return value === 'indeterminate' || value === 'missing' || value === 'usable';
}

function parseIssue(value: unknown): ModelRuntimeStatusIssue {
  if (!isRecord(value)) throw new Error('OpenClaw models status returned an invalid route issue.');
  const { authRequirement, kind, message, model, provider } = value;
  if (
    (kind !== 'incompatible' && kind !== 'indeterminate' && kind !== 'missing-auth') ||
    typeof message !== 'string' ||
    typeof model !== 'string' ||
    typeof provider !== 'string'
  ) {
    throw new Error('OpenClaw models status returned an invalid route issue.');
  }
  if (kind === 'missing-auth') {
    if (typeof authRequirement !== 'string') {
      throw new Error('OpenClaw models status returned an invalid route issue.');
    }
    return { authRequirement, kind, message, model, provider };
  }
  return { kind, message, model, provider };
}

function parseRoute(value: unknown): ModelRuntimeStatusRoute {
  if (!isRecord(value))
    throw new Error('OpenClaw models status returned an invalid runtime route.');
  const { authStatus, provider, runtime, runtimeDetail, status } = value;
  if (
    typeof provider !== 'string' ||
    typeof runtime !== 'string' ||
    (runtimeDetail !== undefined && typeof runtimeDetail !== 'string')
  ) {
    throw new Error('OpenClaw models status returned an invalid runtime route.');
  }
  if (status === 'unavailable') {
    if (!isAuthStatus(authStatus)) {
      throw new Error('OpenClaw models status returned an invalid runtime route.');
    }
    return {
      authStatus,
      provider,
      runtime,
      ...(runtimeDetail === undefined ? {} : { runtimeDetail }),
      status,
    };
  }
  if (!isAuthStatus(status)) {
    throw new Error('OpenClaw models status returned an invalid runtime route.');
  }
  return {
    provider,
    runtime,
    ...(runtimeDetail === undefined ? {} : { runtimeDetail }),
    status,
  };
}

/** Parse the stable, secret-free model route subset emitted by OpenClaw status JSON. */
export default function parseModelRuntimeStatus(stdout: string): ModelRuntimeStatusSnapshot {
  const parsed: unknown = JSON.parse(stdout);
  if (!isRecord(parsed) || !isRecord(parsed.auth)) {
    throw new Error('OpenClaw models status returned an invalid JSON result.');
  }
  const { modelRouteIssues, runtimeAuthRoutes } = parsed.auth;
  if (!Array.isArray(modelRouteIssues) || !Array.isArray(runtimeAuthRoutes)) {
    throw new Error('OpenClaw models status returned an invalid JSON result.');
  }
  return {
    issues: modelRouteIssues.map(parseIssue),
    routes: runtimeAuthRoutes.map(parseRoute),
  };
}
