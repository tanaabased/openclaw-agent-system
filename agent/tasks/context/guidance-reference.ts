import type { AssessmentGuidance } from '../assessment/assessment-guidance.ts';

/** file validation and receipts stay with their owners; native tools read the content. */
export default function guidanceReference(guidance: AssessmentGuidance) {
  if (guidance.source !== 'file') return guidance;
  return {
    source: guidance.source,
    path: guidance.path,
    digest: guidance.digest,
    instruction:
      'Read the whole file at its supplied absolute path, following truncated reads. Resolve relative references from the file naming them, not the checkout. Compare a failed read with the supplied path and correct an identifiable mistake once before reporting guidance unavailable. Never skip required guidance or bypass denied access.',
  };
}
