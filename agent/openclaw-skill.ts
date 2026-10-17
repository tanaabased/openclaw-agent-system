import { basename, isAbsolute } from 'node:path';
import assessmentSkillSource from './assessment-skill-source.ts';
import { sessionObject } from './openclaw-session-create.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';
/** resolve one exact eligible skill from the enrolled native catalog. */
export default async function openClawSkill(
  request: DispatchRequest,
  expected: { agentId: string; key: string },
  id: string,
) {
  const name = [
    'agent-system:agent-system-feedback-reply',
    'agent-system:agent-system-issue-assessment',
  ].includes(id)
    ? id.split(':').at(-1)!
    : id;
  const report = sessionObject(
    await request('skills.status', { agentId: expected.agentId, sessionKey: expected.key }),
  );
  if (!Array.isArray(report.skills)) throw new Error('dispatch-assessment-skill-discovery-invalid');
  const matches = report.skills
    .map(sessionObject)
    .filter(
      (entry) =>
        entry.name === name &&
        entry.eligible === true &&
        entry.modelVisible === true &&
        entry.disabled !== true,
    );
  if (matches.length !== 1) throw new Error('dispatch-assessment-skill-unavailable');
  const selected = matches[0]!;
  if (
    typeof selected.filePath !== 'string' ||
    !isAbsolute(selected.filePath) ||
    basename(selected.filePath) !== 'SKILL.md' ||
    typeof selected.source !== 'string'
  )
    throw new Error('dispatch-assessment-skill-source-unsupported');
  return assessmentSkillSource({
    name,
    path: selected.filePath,
    scope: selected.source,
  });
}
