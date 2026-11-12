import { matchesGlob } from 'node:path';

/** return false only when neither this directory, its ancestors, nor descendants can match. */
export default function backupDirectoryRelevant(directory: string, patterns: string[]): boolean {
  const parts = directory.split('/');
  return patterns.some((pattern) => {
    if (parts.some((_, index) => matchesGlob(parts.slice(0, index + 1).join('/'), pattern)))
      return true;

    // syntax spanning separators cannot be compared one segment at a time.
    const groups: string[] = [];
    for (const character of pattern) {
      if ('[{('.includes(character)) groups.push(character);
      else if (']})'.includes(character)) {
        const opening = groups.pop();
        if (opening !== ({ ']': '[', '}': '{', ')': '(' } as Record<string, string>)[character])
          return true;
      } else if (character === '/' && groups.length) return true;
    }
    if (groups.length) return true;
    const segments = pattern.split('/').filter((part) => part && part !== '.');
    if (segments.some((part) => part !== '**' && part.includes('**'))) return true;

    function expand(states: Set<number>): Set<number> {
      const expanded = new Set(states);
      for (const state of expanded) {
        if (segments[state] === '**') expanded.add(state + 1);
      }
      return expanded;
    }
    let states = expand(new Set([0]));
    for (const part of parts) {
      const next = new Set<number>();
      for (const state of states) {
        const segment = segments[state];
        if (segment === undefined) return true;
        if (segment === '**') next.add(state);
        else if (matchesGlob(part, segment)) next.add(state + 1);
      }
      states = expand(next);
      if (states.size === 0) return false;
    }
    return states.size > 0;
  });
}
