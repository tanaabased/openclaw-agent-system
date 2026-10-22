import assessmentEntry from './assessment-entry.ts';
import codexEntryContext from './codex-entry-context.ts';
import type { CodexFeedbackDependencies } from './codex-feedback.ts';

export default function codexAssessmentEntry(
  pluginData: string,
  input: unknown,
  deps: CodexFeedbackDependencies,
) {
  return codexEntryContext(pluginData, input, deps, (context) => assessmentEntry(input, context));
}
