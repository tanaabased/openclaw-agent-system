import { omit } from 'lodash-es';
import { assessmentResultFormat } from './assessment-result.ts';
import implementationMaterial, {
  type ImplementationMaterialRead,
} from '../implementation/implementation-material.ts';

export default function assessmentMaterial<T extends Record<string, unknown>>(
  context: T,
  request: Record<string, unknown>,
  read?: ImplementationMaterialRead,
) {
  const contextFields = omit(context, ['resultSchema', 'routing']);
  const evidence = context.evidence as { source?: string } | undefined;
  const projected = {
    ...contextFields,
    evidence: { source: evidence?.source ?? context.target },
    resultFormat: assessmentResultFormat,
  };
  return implementationMaterial(projected, request, read, {
    purpose: 'assessment-material',
    controls: ['mode', 'entry', 'currentTurnId', 'presentationRequest'],
    instruction:
      'Read any remaining configured guidance through its returned requests. Follow next, concatenate pages in offset order and parse JSON. Restore paths shallowest-first, then aliases. Refresh stale context; never mix versions. Read the task itself through evidence.source.',
  });
}
