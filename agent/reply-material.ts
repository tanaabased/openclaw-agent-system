import implementationMaterial, {
  type ImplementationMaterialRead,
} from './tasks/implementation/implementation-material.ts';

/** Deliver complete composer and progress inputs through their existing authorized read owner. */
export default function replyMaterial<T extends Record<string, unknown>>(
  context: T,
  request: Record<string, unknown>,
  read?: ImplementationMaterialRead,
  inputFields?: string[],
) {
  return implementationMaterial(context, request, read, {
    purpose: 'reply-material',
    ...(inputFields ? { inputFields } : {}),
    controls: [
      'digest',
      'observation',
      'composeRequest',
      'destination',
      'entry',
      'factsProvenance',
      'eventId',
    ],
    pagedFields: [
      'selection',
      'event',
      'source',
      'privateResponse',
      'verifiedOutcome',
      'publicContext',
      'pendingUpdates',
    ],
    instruction:
      'Read every contextMaterials field through its returned request before comparing progress or composing a reply. Follow next, concatenate JSON text in offset order, restore fields shallowest-first, then aliases. A stale digest or changed observation requires fresh context; never mix versions. Reading pages never publishes or authorizes another effect.',
  });
}
