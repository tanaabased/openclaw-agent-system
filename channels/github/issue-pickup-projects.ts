import type { IssuePickupPolicy } from './issue-pickup-schema.ts';

export type PickupProject = IssuePickupPolicy['projects'][number];

/** exact entries replace every wildcard setting, independent of declaration order. */
export function pickupProject(projects: PickupProject[], repository: string) {
  const path = repository.toLowerCase();
  return (
    projects.find((entry) => entry.repository.toLowerCase() === path) ??
    projects.find((entry) => entry.repository.toLowerCase() === `${path.split('/')[0]}/*`)
  );
}

export function pickupLimit(project: PickupProject) {
  return typeof project.limit === 'number'
    ? { quantity: project.limit, scope: 'selection' as const }
    : { quantity: project.limit.quantity, scope: project.limit.scope ?? ('selection' as const) };
}

/** one resolver for portable ids and the supported repository-local number spelling. */
export function pickupMilestones(project: PickupProject) {
  const milestone = project.milestone;
  if (!milestone) return [];
  const [owner, name] = project.repository.toLowerCase().split('/') as [string, string];
  const refs = [milestone.number, milestone.ids].flatMap((value) =>
    value === undefined ? [] : Array.isArray(value) ? value : [value],
  );
  if (!refs.length) throw new Error('issue-pickup-milestone-invalid');
  const result = new Map<string, { repository: string; number: number }>();
  for (const ref of refs) {
    const match =
      typeof ref === 'string'
        ? /^(?:([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/)?([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/u.exec(
            ref,
          )
        : undefined;
    if (typeof ref === 'string' && !match) throw new Error('issue-pickup-milestone-invalid');
    const repository = match
      ? `${match[1] ?? owner}/${match[2]}`.toLowerCase()
      : `${owner}/${name}`;
    const number = match ? Number(match[3]) : ref;
    if (
      !Number.isSafeInteger(number) ||
      Number(number) <= 0 ||
      (typeof ref === 'number' && name === '*') ||
      repository.split('/')[0] !== owner ||
      (name !== '*' && repository !== `${owner}/${name}`)
    )
      throw new Error('issue-pickup-milestone-invalid');
    result.set(`${repository}#${number}`, { repository, number: Number(number) });
  }
  return [...result.values()];
}
