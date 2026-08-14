import { isAbsolute, relative, sep } from 'node:path';

/** Check whether a path is the root itself or one of its lexical descendants. */
export default function isPathContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === '' ||
    (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}
