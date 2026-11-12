import { nativeAssessmentInstructions } from './assessment-instructions.ts';

/** Codex-owned submission transport around the shared assessment contract. */
const codexAssessmentInstructions = nativeAssessmentInstructions();

export const autoAssessmentInstructions =
  'Trusted issue mode: auto. Make a bounded proceed/wait decision from the actual task and current direction. Send the complete continuationRequest to continuationRuntime context in this turn, preserving its action and id and adding decision {mode:plan|work,reasons:[...]}; no saved assessment is required. On a verified Work decision, follow the returned implementation guidance and continue through scoped implementation, validation and authorized PR delivery in this same turn. Missing judgment never defaults to Work. A Plan decision waits in native conversation without coordinator nudges. Newer user restrictions and native denials still govern.';

export default codexAssessmentInstructions;
