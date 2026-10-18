import { assessmentSummaryInstructions } from './assessment-summary-state.ts';
import { assessmentInstructions } from './assessment-instructions.ts';

/** Codex-owned submission transport around the shared assessment contract. */
const codexAssessmentInstructions =
  assessmentInstructions +
  '\n\n' +
  'Submit through dispatchRuntime from the newest trusted context using its exact argvPrefix, --plugin-data, and pluginData, with action:result, this id, and result matching resultSchema. Send JSON on stdin through native stdin support or a quoted heredoc, never command arguments or a pipeline. Follow the bounded host-access and busy retry rules supplied by the launch/context instructions. Include previousResultDigest when replacing a retained result; on conflict reload context and reconcile before retrying. On later answers, refresh context and revise in this same chat using the retained selection and complete assessment. After acknowledgment, reproduce the entire returned presentation. Native runtime state, not prose, controls lifecycle transitions.' +
  '\n\n' +
  assessmentSummaryInstructions('codex');

export const autoAssessmentInstructions =
  'Trusted issue mode: auto. Include decision {action:proceed|wait,reasons:[...]} in this assessment result, with one to five nonempty reasons of at most 1000 characters each. Apply the shared assessment suitability guidance, including for ordinary replacement skills. Proceed requires plan-ready; a ready plan may still wait. Missing or unusable judgment must wait or report a blocker, never default to proceed. Record and present the complete assessment, follow the bounded summary instructions when authorized, then stop. Only the owning continuation runtime may adopt proceed under freshly installed authority.';

export default codexAssessmentInstructions;
