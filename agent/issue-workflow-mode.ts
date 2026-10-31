import type { ProjectWork } from './project-pickup-authority.ts';
import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';

type Mode = 'plan' | 'work' | 'auto';

/** only first admission can supply project work; live configuration never promotes old issues. */
export default function issueWorkflowMode(
  policy: GitHubNotificationPolicy | undefined,
  record: { manualIssue?: { selections?: { mode?: Mode } }; projectWork?: ProjectWork },
): Mode {
  return (
    record.manualIssue?.selections?.mode ??
    (record.projectWork ? 'work' : (policy?.issueAssignment?.mode ?? 'auto'))
  );
}
