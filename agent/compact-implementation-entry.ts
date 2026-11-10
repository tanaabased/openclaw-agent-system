import type { ImplementationEntry } from './implementation-entry-state.ts';

export default function compactImplementationEntry(entry: ImplementationEntry) {
  for (const key of [
    'plan',
    'evidence',
    'authorizationText',
    'scopeText',
    'result',
    'resultSource',
  ] as const)
    delete entry[key];
}
