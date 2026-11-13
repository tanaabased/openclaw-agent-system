import type { IssuePickupFilters } from '../channels/github/issue-pickup-schema.ts';
import type { ProjectCandidate } from '../channels/github/provider/issue-pickup-client.ts';

import issuePickupLabels from './issue-pickup-labels.ts';

export default function issuePickupFilters(
  candidate: Pick<ProjectCandidate, 'labels' | 'issueType'>,
  filters?: IssuePickupFilters,
) {
  const types = filters?.types ?? [];
  if (types.length) {
    const issueType = candidate.issueType;
    if (issueType === undefined) throw new Error('issue-pickup-type-unavailable');
    if (issueType === null) return false;
    if (!types.some((type) => type.toLowerCase() === issueType.name.toLowerCase())) return false;
  }
  return issuePickupLabels(candidate.labels, filters);
}
