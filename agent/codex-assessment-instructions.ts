import { nativeAssessmentInstructions } from './assessment-instructions.ts';

/** Codex-owned submission transport around the shared assessment contract. */
const codexAssessmentInstructions = nativeAssessmentInstructions();

export const autoAssessmentInstructions =
  'Trusted issue mode: auto. Make a bounded proceed/wait decision from the actual task and current direction. Send the complete continuationRequest to continuationRuntime context, preserving its action and id and adding decision {mode:plan|work,reasons:[...]}, when requesting implementation permission; no saved assessment is required. Missing judgment never defaults to Work. A Plan decision waits in native conversation without coordinator nudges.';

export default codexAssessmentInstructions;
