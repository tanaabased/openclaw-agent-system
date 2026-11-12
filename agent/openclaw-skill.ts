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
  return openClawSkillResolver(request, expected)(id);
}

/** keep discovery local to one context request; selected files are still read independently. */
export function openClawSkillResolver(
  request: DispatchRequest,
  expected: { agentId: string; key: string },
) {
  let catalog: ReturnType<typeof readCatalog> | undefined;
  return async (id: string) => {
    const skills = await (catalog ??= readCatalog(request, expected).catch((error) => {
      catalog = undefined;
      throw error;
    }));
    return selectSkill(skills, id);
  };
}

async function readCatalog(request: DispatchRequest, expected: { agentId: string; key: string }) {
  const report = sessionObject(
    await request('skills.status', { agentId: expected.agentId, sessionKey: expected.key }),
  );
  if (!Array.isArray(report.skills)) throw new Error('dispatch-assessment-skill-discovery-invalid');
  return report.skills;
}

async function selectSkill(skills: unknown[], id: string) {
  const name = [
    'agent-system:agent-system-github-reply',
    'agent-system:agent-system-task-assessment',
    'agent-system:agent-system-task-implementation',
  ].includes(id)
    ? id.split(':').at(-1)!
    : id;
  const matches = skills
    .map(sessionObject)
    .filter(
      (entry) =>
        (entry.name === name || entry.skillKey === id) &&
        entry.eligible === true &&
        entry.modelVisible === true &&
        entry.disabled !== true,
    );
  if (matches.length !== 1) throw new Error('dispatch-assessment-skill-unavailable');
  const selected = matches[0]!;
  if (
    typeof selected.name !== 'string' ||
    typeof selected.filePath !== 'string' ||
    !isAbsolute(selected.filePath) ||
    basename(selected.filePath) !== 'SKILL.md' ||
    typeof selected.source !== 'string'
  )
    throw new Error('dispatch-assessment-skill-source-unsupported');
  return assessmentSkillSource({
    name: selected.name,
    path: selected.filePath,
    scope: selected.source,
  });
}
