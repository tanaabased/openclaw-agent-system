import type { ProjectPickupFilters } from '../channels/github/project-pickup-schema.ts';

export default function projectPickupLabels(labels: string[], filters?: ProjectPickupFilters) {
  const present = new Set(labels.map((label) => label.toLowerCase()));
  return (
    (filters?.labels ?? []).every((label) => present.has(label.toLowerCase())) &&
    !(filters?.excludeLabels ?? []).some((label) => present.has(label.toLowerCase()))
  );
}
