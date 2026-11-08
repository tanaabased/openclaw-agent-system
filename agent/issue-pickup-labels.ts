import type { IssuePickupFilters } from '../channels/github/issue-pickup-schema.ts';

export default function issuePickupLabels(labels: string[], filters?: IssuePickupFilters) {
  const present = new Set(labels.map((label) => label.toLowerCase()));
  return (
    (filters?.labels ?? []).every((label) => present.has(label.toLowerCase())) &&
    !(filters?.excludeLabels ?? []).some((label) => present.has(label.toLowerCase()))
  );
}
