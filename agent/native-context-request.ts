/** bind current-task reads without accepting model-supplied ownership selectors. */
export function isNativeContextRequest(route: string, input: Record<string, unknown>) {
  return (
    (route === 'dispatch' &&
      ['context', 'implementation-context'].includes(String(input.action))) ||
    (route === 'continuation' && input.action === 'context')
  );
}

export function assertNativeContextInput(input: Record<string, unknown>) {
  for (const field of ['id', 'agentId', 'workspace', 'threadId', 'turnId', 'sessionKey', 'eventId'])
    if (Object.hasOwn(input, field)) throw new Error('native-context-binding-override');
}

export function nativeContextRequest(
  input: Record<string, unknown>,
  owner: { id: string; retired?: unknown; reset?: unknown; supersededBy?: unknown } | undefined,
) {
  assertNativeContextInput(input);
  if (!owner || owner.retired || owner.reset || owner.supersededBy)
    throw new Error('native-context-owner-unavailable');
  return { ...input, id: owner.id };
}

/** project prepared read requests, never provider content or retained effect records. */
export function nativeContextResponse<T>(value: T, route: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const response = { ...value } as Record<string, unknown>;
  const project = (request: unknown, requestRoute = route) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return request;
    const input = request as Record<string, unknown>;
    if (!isNativeContextRequest(requestRoute, input)) return request;
    const { id: _id, ...semantic } = input;
    return semantic;
  };
  for (const field of ['contextRequest', 'continuationRequest'])
    if (response[field])
      response[field] = project(
        response[field],
        field === 'continuationRequest' ? 'continuation' : route,
      );
  if (response.next) response.next = project(response.next);
  const materials = response.contextMaterials;
  if (materials && typeof materials === 'object' && !Array.isArray(materials)) {
    const metadata = materials as Record<string, unknown>;
    if (Array.isArray(metadata.fields))
      response.contextMaterials = {
        ...metadata,
        fields: metadata.fields.map((field: Record<string, unknown>) => ({
          ...field,
          request: project(field.request),
        })),
      };
  }
  return response as T;
}
