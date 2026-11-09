export function isNativeFeedbackRequest(route: string, input: Record<string, unknown>) {
  return (
    (route === 'dispatch' && input.action === 'feedback') ||
    (route === 'feedback' && !['next', 'reply', 'publish-approved'].includes(String(input.action)))
  );
}

/** bind current-task operations without accepting model-supplied ownership selectors. */
export function isNativeContextRequest(route: string, input: Record<string, unknown>) {
  return (
    (route === 'dispatch' &&
      [
        'context',
        'present',
        'summary',
        'handoff',
        'result',
        'implementation-context',
        'implementation-result',
        'delivery',
      ].includes(String(input.action))) ||
    (route === 'continuation' &&
      ['context', 'result', 'cancel', 'delivery', 'retry', 'retry-denied'].includes(
        String(input.action),
      )) ||
    route === 'delivery' ||
    isNativeFeedbackRequest(route, input)
  );
}

export function assertNativeContextInput(input: Record<string, unknown>) {
  for (const field of [
    'id',
    'agentId',
    'workspace',
    'threadId',
    'turnId',
    'sessionKey',
    'eventId',
    'digest',
    'previousResultDigest',
    'apply',
    'approvedCallId',
  ])
    if (Object.hasOwn(input, field)) throw new Error('native-context-binding-override');
}

/** Reject invocation plumbing at the raw command boundary, including legacy nested delivery. */
export function assertModelWorkflowInput(route: string, input: Record<string, unknown>) {
  const fields = { ...input };
  if (route === 'dispatch' && input.action === 'inspect') delete fields.id; // historical record selection
  assertNativeContextInput(fields);
  if (
    route === 'continuation' &&
    input.action === 'delivery' &&
    input.delivery &&
    typeof input.delivery === 'object' &&
    !Array.isArray(input.delivery)
  )
    assertNativeContextInput(input.delivery as Record<string, unknown>);
}

export function nativeContextRequest(
  input: Record<string, unknown>,
  owner: { id: string; retired?: unknown; reset?: unknown; supersededBy?: unknown } | undefined,
): Record<string, unknown> & { id: string } {
  assertNativeContextInput(input);
  if (!owner || owner.retired || owner.reset || owner.supersededBy)
    throw new Error('native-context-owner-unavailable');
  return { ...input, id: owner.id, ...(input.action === 'handoff' ? { apply: true } : {}) };
}

/** project prepared read requests, never provider content or retained effect records. */
export function nativeContextResponse<T>(value: T, route: string, source?: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const response = { ...value } as Record<string, unknown>;
  const project = (request: unknown, requestRoute = route) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return request;
    const input = request as Record<string, unknown>;
    if (!isNativeContextRequest(requestRoute, input)) return request;
    const semantic = { ...input };
    delete semantic.id;
    delete semantic.eventId;
    return {
      ...semantic,
      ...(isNativeFeedbackRequest(requestRoute, input) && source ? { source } : {}),
    };
  };
  for (const field of [
    'contextRequest',
    'continuationRequest',
    'deliveryPrepareRequest',
    'publishRequest',
    'linkRequest',
  ])
    if (response[field])
      response[field] = project(
        response[field],
        field === 'continuationRequest'
          ? 'continuation'
          : field === 'deliveryPrepareRequest'
            ? (response[field] as Record<string, unknown>).action === 'delivery'
              ? route
              : 'delivery'
            : route,
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
