import AssessmentEntryStore, {
  DirectEntryStore,
  type AssessmentEntryBinding,
} from '../agent/assessment-entry-store.ts';
import { implementationEntriesSchema } from '../agent/implementation-entry-state.ts';
import compactImplementationEntry from '../agent/compact-implementation-entry.ts';

/** scoped native custody permits trimming copies without replacing current delivery ownership. */
export default async function cutover638Local(root: string, binding: AssessmentEntryBinding) {
  const assessments = new AssessmentEntryStore(root, binding);
  await assessments.exclusive(async (entries, save) => {
    entries.splice(0);
    await save(true);
  });
  const implementations = new DirectEntryStore(
    root,
    binding,
    implementationEntriesSchema,
    'implementation',
  );
  await implementations.exclusive(async (entries, save) => {
    for (const entry of entries) compactImplementationEntry(entry);
    await save(true);
  });
  return [assessments.path, implementations.path];
}
