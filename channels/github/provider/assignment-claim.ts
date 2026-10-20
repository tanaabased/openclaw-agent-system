import type { GitHubCanonicalIssueComment } from './comment-admission.ts';

export interface AssignmentClaim {
  instanceId: string;
  assignmentEventId: string;
}

export const instanceIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export const instanceNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function normalizeInstanceName(value: string): string {
  const name = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, '-');
  if (name.length > 48 || !instanceNamePattern.test(name)) throw new Error('instance-name-invalid');
  return name;
}

export function claimBody(claim: AssignmentClaim, name: string, accepted = false): string {
  if (
    !instanceIdPattern.test(claim.instanceId) ||
    !claim.assignmentEventId ||
    claim.assignmentEventId.length > 256 ||
    /[\r\n\0]/u.test(claim.assignmentEventId)
  )
    throw new Error('assignment-claim-invalid');
  const displayName = normalizeInstanceName(name);
  const text = accepted
    ? `Assignment accepted on \`${displayName}\`.`
    : `Assignment claim registered on \`${displayName}\`. Awaiting ownership selection; work has not started.`;
  return `${text}\n\n<!-- agent-system-claim:v1\n${JSON.stringify(claim)}\n-->`;
}

/** only an entire canonical control comment is a claim; quoted markers are ordinary prose. */
export function parseAssignmentClaim(
  comment: GitHubCanonicalIssueComment,
): AssignmentClaim | undefined {
  if (comment.bodyTruncated) return;
  const match =
    /^Assignment (?:claim registered|accepted) on `([a-z0-9]+(?:-[a-z0-9]+)*)`\.(?: Awaiting ownership selection; work has not started\.)?\n\n<!-- agent-system-claim:v1\n(\{[^\r\n]+\})\n-->$/u.exec(
      comment.body,
    );
  if (!match) return;
  try {
    const value: unknown = JSON.parse(match[2]!);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'assignmentEventId,instanceId' ||
      typeof record.instanceId !== 'string' ||
      typeof record.assignmentEventId !== 'string'
    )
      return;
    const claim = { instanceId: record.instanceId, assignmentEventId: record.assignmentEventId };
    if (
      comment.body !== claimBody(claim, match[1]!) &&
      comment.body !== claimBody(claim, match[1]!, true)
    )
      return;
    return claim;
  } catch {
    return;
  }
}
