export const defaultManagedGroup = 'AGENT SYSTEM';

/** normalize only desired names; existing native containers retain their exact spelling. */
export default function managedGroupName(value: string, maximumCodePoints?: number): string {
  if (/[\p{Cc}\u2028\u2029]/u.test(value)) throw new Error('managed-group-control-character');
  const name = value.trim().toUpperCase();
  if (!name) throw new Error('managed-group-blank');
  if (maximumCodePoints !== undefined && [...name].length > maximumCodePoints)
    throw new Error('managed-group-too-long');
  return name;
}
