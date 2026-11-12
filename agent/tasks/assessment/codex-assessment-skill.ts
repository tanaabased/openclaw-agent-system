import { basename, isAbsolute } from 'node:path';

import { nativeObject } from '../../automations/automation-gateway.ts';
import type { CodexThreadRequest } from '../../codex-thread-client.ts';
import { normalizeAssessmentSkillId } from '../../../manifest/assessment-schema.ts';
import assessmentSkillSource, { type AssessmentSkill } from './assessment-skill-source.ts';

/** resolve one active host-discovered local skill, never a manifest-supplied path. */
export default async function codexAssessmentSkill(
  request: CodexThreadRequest,
  cwd: string,
  id: string,
): Promise<AssessmentSkill> {
  return codexSkillResolver(request, cwd)(id);
}

/** keep discovery local to one context request; selected files are still read independently. */
export function codexSkillResolver(request: CodexThreadRequest, cwd: string) {
  let catalog: ReturnType<typeof readCatalog> | undefined;
  return async (id: string): Promise<AssessmentSkill> => {
    const selected = normalizeAssessmentSkillId(id);
    const skills = await (catalog ??= readCatalog(request, cwd).catch((error) => {
      catalog = undefined;
      throw error;
    }));
    return selectSkill(skills, selected);
  };
}

async function readCatalog(request: CodexThreadRequest, cwd: string) {
  const response = await request('skills/list', { cwds: [cwd], forceReload: true });
  const entries = Array.isArray(response.data)
    ? response.data.filter((entry) => nativeObject(entry) && entry.cwd === cwd)
    : [];
  const entry = entries[0];
  if (
    entries.length !== 1 ||
    !nativeObject(entry) ||
    !Array.isArray(entry.skills) ||
    !Array.isArray(entry.errors)
  )
    throw new Error('dispatch-assessment-skill-discovery-invalid');
  return entry.skills;
}

async function selectSkill(skills: unknown[], selected: string) {
  const matches = skills.filter(
    (skill) =>
      nativeObject(skill) &&
      typeof skill.name === 'string' &&
      (selected.includes(':')
        ? skill.name === selected
        : skill.name.split(':').at(-1) === selected) &&
      skill.enabled === true,
  );
  if (!matches.length) throw new Error('dispatch-assessment-skill-unavailable');
  if (matches.length !== 1) throw new Error('dispatch-assessment-skill-ambiguous');
  const skill = matches[0];
  if (
    !nativeObject(skill) ||
    typeof skill.path !== 'string' ||
    !isAbsolute(skill.path) ||
    basename(skill.path) !== 'SKILL.md' ||
    typeof skill.scope !== 'string'
  )
    throw new Error('dispatch-assessment-skill-source-unsupported');
  if (typeof skill.name !== 'string' || normalizeAssessmentSkillId(skill.name) !== skill.name)
    throw new Error('dispatch-assessment-skill-discovery-invalid');
  return assessmentSkillSource({ name: skill.name, path: skill.path, scope: skill.scope });
}
