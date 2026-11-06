import type { AssessmentGuidance } from './assessment-guidance.ts';

/** file validation and receipts stay with their owners; native tools read the content. */
export default function guidanceReference(guidance: AssessmentGuidance) {
  if (guidance.source !== 'file') return guidance;
  return {
    source: guidance.source,
    path: guidance.path,
    digest: guidance.digest,
    instruction:
      'Read this entire file at its absolute path using the native file-reading tool before proceeding. Follow any continuation of a truncated read. Apply its guidance with the selected skill. If the read fails, report the required guidance as unavailable; do not silently skip it.',
  };
}
