import { nativeAssessmentInstructions } from './assessment-instructions.ts';

/** Codex-owned submission transport around the shared assessment contract. */
const codexAssessmentInstructions =
  nativeAssessmentInstructions('codex') +
  '\n\n' +
  'For optional assessment recording, submit through dispatchRuntime using resultSubmission.request plus result matching resultSchema. Send JSON on stdin. Include previousResultDigest when revising saved history; reconcile uncertain submissions. Show the acknowledged presentation when used. Do not require recording before implementation, clarification answers, or PR delivery.';

export const autoAssessmentInstructions =
  'Trusted issue mode: auto. Make a bounded proceed/wait decision from the actual task and current direction. Use continuationRuntime context with decision {mode:plan|work,reasons:[...]} when requesting implementation permission; no saved assessment is required. Missing judgment never defaults to Work. A Plan decision waits in native conversation without coordinator nudges.';

export default codexAssessmentInstructions;
