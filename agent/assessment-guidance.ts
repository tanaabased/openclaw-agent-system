import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  maximumAssessmentGuidanceBytes,
  type AssessmentConfiguration,
} from '../manifest/assessment-schema.ts';
import isPathContained from '../utils/is-path-contained.ts';

export interface AssessmentGuidance {
  source: 'inline' | 'file';
  path?: string;
  content: string;
  digest: string;
}

/** load only after trusted binding; files are relative to the stable agent workspace. */
export default async function assessmentGuidance(
  workspace: string,
  guidance: AssessmentConfiguration['guidance'],
): Promise<AssessmentGuidance | undefined> {
  if (guidance === undefined) return;
  let content: string;
  let path: string | undefined;
  if (typeof guidance === 'string') content = guidance;
  else {
    const reference = guidance.file;
    if (
      isAbsolute(reference) ||
      /^[a-z][a-z0-9+.-]*:/iu.test(reference) ||
      reference.includes('\\') ||
      /[\0\r\n]/u.test(reference) ||
      reference.split('/').some((part) => part === '..' || part === '.' || !part)
    )
      throw new Error('dispatch-assessment-guidance-path-invalid');
    try {
      const root = await realpath(workspace);
      path = resolve(root, reference);
      if (!isPathContained(root, path))
        throw new Error('dispatch-assessment-guidance-path-invalid');
      let current = root;
      for (const part of reference.split('/')) {
        current = join(current, part);
        if ((await lstat(current)).isSymbolicLink())
          throw new Error('dispatch-assessment-guidance-symlink');
      }
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        if (!(await file.stat()).isFile())
          throw new Error('dispatch-assessment-guidance-not-regular');
        if ((await realpath(path)) !== path)
          throw new Error('dispatch-assessment-guidance-symlink');
        const bytes = Buffer.alloc(maximumAssessmentGuidanceBytes + 1);
        let size = 0;
        while (size < bytes.length) {
          const read = await file.read(bytes, size, bytes.length - size, null);
          if (!read.bytesRead) break;
          size += read.bytesRead;
        }
        if (size > maximumAssessmentGuidanceBytes)
          throw new Error('dispatch-assessment-guidance-too-large');
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
        } catch {
          throw new Error('dispatch-assessment-guidance-encoding');
        }
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('dispatch-assessment-guidance-'))
        throw error;
      throw new Error('dispatch-assessment-guidance-unreadable', { cause: error });
    }
  }
  if (Buffer.byteLength(content) > maximumAssessmentGuidanceBytes)
    throw new Error('dispatch-assessment-guidance-too-large');
  if (!content.trim() || content.includes('\0'))
    throw new Error('dispatch-assessment-guidance-content-invalid');
  return {
    source: typeof guidance === 'string' ? 'inline' : 'file',
    ...(path ? { path } : {}),
    content,
    digest: createHash('sha256').update(content).digest('hex'),
  };
}
