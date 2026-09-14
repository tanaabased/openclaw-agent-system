import { memorySecretProviderAlias } from '../agent/memory-configuration-plan.ts';

export interface MemorySecretProviderRequest {
  ids: string[];
  protocolVersion: 1;
  provider: string;
}

export interface MemorySecretProviderResponse {
  errors?: Record<string, { code: 'NOT_FOUND' }>;
  protocolVersion: 1;
  values: Record<string, string>;
}

export interface MemorySecretProviderDependencies {
  resolveBinding(agentId: string, binding: string): Promise<string | undefined>;
}

const secretIdPattern = /^agents\/([a-z0-9][a-z0-9-]*)\/environment\/([A-Za-z_][A-Za-z0-9_]*)$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseMemorySecretProviderRequest(input: string): MemorySecretProviderRequest {
  const parsed: unknown = JSON.parse(input);
  if (
    !isRecord(parsed) ||
    parsed.protocolVersion !== 1 ||
    parsed.provider !== memorySecretProviderAlias ||
    !Array.isArray(parsed.ids) ||
    parsed.ids.length === 0 ||
    parsed.ids.length > 32 ||
    parsed.ids.some((id) => typeof id !== 'string' || !secretIdPattern.test(id)) ||
    new Set(parsed.ids).size !== parsed.ids.length
  ) {
    throw new Error('Invalid Agent System secret-provider request.');
  }
  return {
    protocolVersion: 1,
    provider: memorySecretProviderAlias,
    ids: [...parsed.ids] as string[],
  };
}

/** Resolve only manifest-authorized agent environment bindings. */
export default async function resolveMemorySecretProviderRequest(
  request: MemorySecretProviderRequest,
  dependencies: MemorySecretProviderDependencies,
): Promise<MemorySecretProviderResponse> {
  const values: Record<string, string> = {};
  const errors: Record<string, { code: 'NOT_FOUND' }> = {};
  await Promise.all(
    request.ids.map(async (id) => {
      const match = secretIdPattern.exec(id);
      if (!match) {
        errors[id] = { code: 'NOT_FOUND' };
        return;
      }
      const [, agentId, binding] = match;
      try {
        const value = await dependencies.resolveBinding(agentId!, binding!);
        if (value === undefined || value === '') errors[id] = { code: 'NOT_FOUND' };
        else values[id] = value;
      } catch {
        errors[id] = { code: 'NOT_FOUND' };
      }
    }),
  );
  return {
    protocolVersion: 1,
    values,
    ...(Object.keys(errors).length === 0 ? {} : { errors }),
  };
}
