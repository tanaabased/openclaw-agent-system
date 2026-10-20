import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';

import isFilesystemAccessError from '../utils/is-filesystem-access-error.ts';
import type { CodexAssessmentSkill } from './codex-assessment-skill.ts';

/** Bounded source read shared by runtime-owned skill discovery adapters. */
export default async function assessmentSkillSource(
  skill: Omit<CodexAssessmentSkill, 'digest'>,
): Promise<CodexAssessmentSkill> {
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
  } catch (error) {
    if (isFilesystemAccessError(error)) throw error;
    throw new Error('dispatch-assessment-skill-unreadable', { cause: error });
  }
  return {
    name: skill.name,
    path,
    scope: skill.scope,
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
}
