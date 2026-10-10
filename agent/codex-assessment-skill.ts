import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

import { nativeObject } from './automation-gateway.ts';
import type { CodexThreadRequest } from './codex-thread-client.ts';
import { normalizeAssessmentSkillId } from '../manifest/assessment-schema.ts';

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
  let path: string;
  let bytes: Buffer;
  try {
    path = await realpath(skill.path);
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error('invalid file');
      const buffer = Buffer.alloc(256 * 1024 + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await file.read(buffer, size, buffer.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (!size || size > 256 * 1024) throw new Error('invalid size');
      bytes = buffer.subarray(0, size);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!content.trim() || content.includes('\0')) throw new Error('invalid text');
    } finally {
      await file.close();
    }
  } catch {
    throw new Error('dispatch-assessment-skill-unreadable');
  }
  return {
    name: skill.name,
    path,
    scope: skill.scope,
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
}
