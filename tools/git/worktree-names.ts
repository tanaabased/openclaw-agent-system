import { createHash } from 'node:crypto';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 10);
}

function slug(value: string, fallback: string): string {
  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);
  return normalized || fallback;
}

export function gitWorktreeRepositoryDirectoryName(repositoryId: string): string {
  return `${slug(repositoryId, 'repository')}-${digest(repositoryId)}.git`;
}

export function gitWorktreeDirectoryName(repositoryId: string, workId: string): string {
  return `${slug(workId, 'work')}-${digest(`${repositoryId}\0${workId}`)}`;
}

export function gitHubIssueBranchSuffix(
  agentId: string,
  workspaceDir: string,
  repositoryId: string,
  workId: string,
): string {
  return createHash('sha256')
    .update([agentId, workspaceDir, repositoryId, workId].join('\0'))
    .digest('hex')
    .slice(0, 5);
}

export function gitHubIssueBranchName(number: number, title: string, suffix: string): string {
  const description = slug(title, 'issue').replace(/-+$/u, '') || 'issue';
  return `${number}-${description}-${suffix}`;
}

export function isGitHubIssueBranchName(branch: string, number: number, suffix: string): boolean {
  return new RegExp(`^${number}-[a-z0-9]+(?:-[a-z0-9]+)*-${suffix}$`, 'u').test(branch);
}
