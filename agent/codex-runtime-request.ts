const actions: Record<string, readonly string[]> = {
  dispatch: [
    'launch',
    'assessment',
    'implementation',
    'inspect',
    'observe-denials',
    'next',
    'prepare',
    'reconcile',
    'context',
    'present',
    'result',
    'summary',
    'handoff',
    'report',
    'retry-denied',
    'reset',
    'retire',
    'recover',
  ],
  continuation: [
    'next',
    'reconcile',
    'context',
    'result',
    'cancel',
    'delivery',
    'retry',
    'retry-denied',
  ],
  delivery: [
    'bind',
    'prepare',
    'publish',
    'reconcile',
    'compose',
    'candidate',
    'announce',
    'present',
  ],
  feedback: [
    'reply',
    'implementation-context',
    'implementation-result',
    'next',
    'context',
    'result',
    'compose',
    'candidate',
    'publish',
    'publish-approved',
    'reconcile',
  ],
};

/** expose the effect in argv without allowing stdin to substitute another operation. */
export default function codexRuntimeRequest(route: string, args: string[], input: unknown) {
  const index = args.indexOf('--plugin-data');
  if (index < 0 || index > 2 || args.length !== index + 2 || !args[index + 1])
    throw new Error('workflow-command-invalid');
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('workflow-request-invalid');
  const request = { ...input } as Record<string, unknown>;
  const [action, operation] = args.slice(0, index);
  if (!action) {
    if (
      (route === 'feedback' && request.action === 'reply') ||
      (route === 'dispatch' &&
        ['assessment', 'implementation', 'launch'].includes(String(request.action)))
    )
      throw new Error('workflow-command-operation-required');
    return { pluginData: args[index + 1]!, request };
  }
  if (!actions[route]?.includes(action)) throw new Error('workflow-command-action-invalid');
  if (request.action !== undefined && request.action !== action)
    throw new Error('workflow-command-action-mismatch');
  request.action = action;
  if (route === 'continuation' && action === 'delivery') {
    if (!operation || !actions.delivery!.includes(operation))
      throw new Error('workflow-command-operation-invalid');
    const delivery = request.delivery;
    if (
      delivery !== undefined &&
      (!delivery || typeof delivery !== 'object' || Array.isArray(delivery))
    )
      throw new Error('workflow-request-invalid');
    const nested = { ...delivery } as Record<string, unknown>;
    if (nested.action !== undefined && nested.action !== operation)
      throw new Error('workflow-command-action-mismatch');
    request.delivery = { ...nested, action: operation };
  } else if (
    route === 'dispatch' &&
    action === 'implementation' &&
    ['prepare', 'publish', 'reconcile', 'delivery-present'].includes(operation ?? '')
  ) {
    const effect = operation === 'delivery-present' ? 'present' : operation;
    if (
      (request.operation !== undefined && request.operation !== 'delivery') ||
      (request.deliveryOperation !== undefined && request.deliveryOperation !== effect)
    )
      throw new Error('workflow-command-action-mismatch');
    request.operation = 'delivery';
    request.deliveryOperation = effect;
  } else if (operation) {
    if (
      !(
        (route === 'dispatch' &&
          ['summary', 'assessment', 'implementation', 'launch'].includes(action)) ||
        (route === 'feedback' && action === 'reply')
      ) ||
      !(
        ['assessment', 'implementation', 'launch'].includes(action)
          ? action === 'launch'
            ? ['context', 'prepare', 'reconcile']
            : ['context', 'result', 'present']
          : action === 'reply'
            ? ['context', 'compose', 'candidate', 'publish', 'reconcile']
            : ['compose', 'candidate', 'publish', 'reconcile']
      ).includes(operation)
    )
      throw new Error('workflow-command-operation-invalid');
    if (request.operation !== undefined && request.operation !== operation)
      throw new Error('workflow-command-action-mismatch');
    request.operation = operation;
  } else if (
    (route === 'dispatch' &&
      ['summary', 'assessment', 'implementation', 'launch'].includes(action)) ||
    (route === 'feedback' && action === 'reply')
  ) {
    throw new Error('workflow-command-operation-required');
  }
  return { pluginData: args[index + 1]!, request };
}
