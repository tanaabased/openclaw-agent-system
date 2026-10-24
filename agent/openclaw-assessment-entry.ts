import assessmentEntry from './assessment-entry.ts';
import openClawEntryContext from './openclaw-entry-context.ts';

export default function openClawAssessmentEntry(input: Parameters<typeof openClawEntryContext>[0]) {
  return openClawEntryContext(input, (deps) => assessmentEntry(input.action, deps));
}
