import type { IssuePickupFilters } from '../channels/github/issue-pickup-schema.ts';

export function issuePickupLabelPatterns(filters?: IssuePickupFilters) {
  const patterns = filters?.labels ?? [];
  return {
    required: patterns.filter((pattern) => !pattern.startsWith('!')),
    excluded: patterns
      .filter((pattern) => pattern.startsWith('!'))
      .map((pattern) => pattern.slice(1)),
  };
}

function matches(label: string, pattern: string) {
  const parts = pattern.toLowerCase().split('*');
  if (parts.length === 1) return label === parts[0];
  const first = parts[0]!;
  const last = parts.at(-1)!;
  if (!label.startsWith(first) || !label.endsWith(last)) return false;
  let offset = first.length;
  for (const part of parts.slice(1, -1)) {
    const next = label.indexOf(part, offset);
    if (next === -1) return false;
    offset = next + part.length;
  }
  return offset <= label.length - last.length;
}

export default function issuePickupLabels(labels: string[], filters?: IssuePickupFilters) {
  const present = labels.map((label) => label.toLowerCase());
  const { required, excluded } = issuePickupLabelPatterns(filters);
  const any = (pattern: string) => present.some((label) => matches(label, pattern));
  return required.every(any) && !excluded.some(any);
}
