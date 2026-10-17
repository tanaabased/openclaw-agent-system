import { basename, isAbsolute } from 'node:path';

import { nativeObject } from './automation-gateway.ts';
import type { CodexThreadRequest } from './codex-thread-client.ts';
import { normalizeAssessmentSkillId } from '../manifest/assessment-schema.ts';
import assessmentSkillSource from './assessment-skill-source.ts';

export interface CodexAssessmentSkill {
  name: string;
  path: string;
  scope: string;
  digest: string;
}

/** resolve one active host-discovered local skill, never a manifest-supplied path. */
export default async function codexAssessmentSkill(
  request: CodexThreadRequest,
  cwd: string,
  id: string,
): Promise<CodexAssessmentSkill> {
  const selected = normalizeAssessmentSkillId(id);
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
  const matches = entry.skills.filter(
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
