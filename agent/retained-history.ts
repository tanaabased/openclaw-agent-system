import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

export const retainedHistoryLimit = 8192;
export const retainedEvidenceBytes = 4 * 1024 * 1024;
export const retainedDecodedBytes = 64 * 1024 * 1024;
export const retainedEvidenceSchema = Type.Object(
  {
    version: Type.Literal(1),
    digest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    bytes: Type.Integer({ minimum: 1, maximum: retainedEvidenceBytes }),
    data: Type.String({ maxLength: retainedEvidenceBytes * 2 }),
  },
  { additionalProperties: false },
);
export type RetainedEvidence = Static<typeof retainedEvidenceSchema>;

export class RetainedHistoryError extends Error {
  constructor(
    readonly code: string,
    readonly retentionDiagnostic: {
      journal: string;
      record: string;
      reason: string;
      limit?: number;
      actual?: number;
    },
  ) {
    super(code);
  }
}

function digest(value: Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}

/** packing never truncates evidence; the previous journal remains authoritative on failure. */
export function packRetained(value: unknown, record: string): RetainedEvidence {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > retainedEvidenceBytes)
    throw new RetainedHistoryError('retained-evidence-oversize', {
      journal: 'retained-history',
      record,
      reason: 'required-evidence',
      limit: retainedEvidenceBytes,
      actual: bytes.length,
    });
  return {
    version: 1,
    digest: digest(bytes),
    bytes: bytes.length,
    data: deflateRawSync(bytes).toString('base64'),
  };
}

/** bounded decoding verifies both the exact byte length and content identity. */
export function unpackRetained(evidence: RetainedEvidence): unknown {
  try {
    if (!Value.Check(retainedEvidenceSchema, evidence)) throw new Error();
    const packed = Buffer.from(evidence.data, 'base64');
    if (packed.toString('base64') !== evidence.data) throw new Error();
    const bytes = inflateRawSync(packed, { maxOutputLength: evidence.bytes });
    if (bytes.length !== evidence.bytes || digest(bytes) !== evidence.digest) throw new Error();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new RetainedHistoryError('retained-evidence-invalid', {
      journal: 'retained-history',
      record: evidence.digest,
      reason: 'restore-verified-evidence',
    });
  }
}

export function checkRetainedCount(count: number, journal: string, record: string) {
  if (count > retainedHistoryLimit)
    throw new RetainedHistoryError('retained-history-capacity', {
      journal,
      record,
      reason: 'duplicate-prevention-identities',
      limit: retainedHistoryLimit,
      actual: count,
    });
}

export function retainedDecodeBudget(journal: string, record: string) {
  let decoded = 0;
  const counted = new Set<object>();
  const check = (value: unknown): void => {
    if (!value || typeof value !== 'object' || counted.has(value)) return;
    counted.add(value);
    if (
      'digest' in value &&
      'bytes' in value &&
      'data' in value &&
      Value.Check(retainedEvidenceSchema, value)
    ) {
      decoded += value.bytes;
      if (decoded > retainedDecodedBytes)
        throw new RetainedHistoryError('retained-history-capacity', {
          journal,
          record,
          reason: 'bounded-evidence-decoding',
          limit: retainedDecodedBytes,
          actual: decoded,
        });
    } else for (const child of Object.values(value)) check(child);
  };
  return check;
}
