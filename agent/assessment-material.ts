import implementationMaterial, {
  type ImplementationMaterialRead,
} from './implementation-material.ts';

export default function assessmentMaterial<T extends Record<string, unknown>>(
  context: T,
  request: Record<string, unknown>,
  read?: ImplementationMaterialRead,
) {
  return implementationMaterial(context, request, read, {
    purpose: 'assessment-material',
    controls: [
      'mode',
      'entry',
      'currentTurnId',
      'previousResultDigest',
      'previousResultTurnId',
      'presentationRequest',
    ],
    instruction:
      'Read every contextMaterials field through its returned request before assessing or choosing a mode. Follow next; concatenate text in offset order, parse once, and restore each path shallowest-first, then aliases. Paths are data paths, not files. A stale digest requires fresh context; never mix versions. Use presentationRequest to format the complete assessment into native context without saving a revision.',
  });
}
