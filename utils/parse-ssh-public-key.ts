import { createHash } from 'node:crypto';

export interface ParsedSshPublicKey {
  algorithm: string;
  fingerprint: string;
  key: string;
}

const supportedAlgorithms = new Set([
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ecdsa-sha2-nistp256@openssh.com',
  'sk-ssh-ed25519@openssh.com',
  'ssh-ed25519',
  'ssh-rsa',
]);

interface SshField {
  nextOffset: number;
  value: Buffer<ArrayBufferLike>;
}

function readSshField(payload: Buffer<ArrayBufferLike>, offset: number): SshField {
  if (offset + 4 > payload.length) throw new Error('The SSH public key payload is malformed.');
  const length = payload.readUInt32BE(offset);
  const start = offset + 4;
  const nextOffset = start + length;
  if (length < 1 || nextOffset > payload.length) {
    throw new Error('The SSH public key payload is malformed.');
  }
  return { nextOffset, value: payload.subarray(start, nextOffset) };
}

function bitLength(value: Buffer<ArrayBufferLike>): number {
  const firstNonzero = value.findIndex((byte) => byte !== 0);
  if (firstNonzero < 0) return 0;
  const first = value[firstNonzero] ?? 0;
  return (value.length - firstNonzero - 1) * 8 + (32 - Math.clz32(first));
}

function validatePayload(
  algorithm: string,
  payload: Buffer<ArrayBufferLike>,
  offset: number,
): void {
  const fields: Buffer<ArrayBufferLike>[] = [];
  while (offset < payload.length) {
    const field = readSshField(payload, offset);
    fields.push(field.value);
    offset = field.nextOffset;
  }

  if (algorithm === 'ssh-ed25519') {
    if (fields.length !== 1 || fields[0]?.length !== 32) {
      throw new Error('The SSH Ed25519 public key payload is malformed.');
    }
    return;
  }
  if (algorithm === 'ssh-rsa') {
    if (fields.length !== 2 || bitLength(fields[1] ?? Buffer.alloc(0)) < 2048) {
      throw new Error('The SSH RSA public key must contain a key of at least 2048 bits.');
    }
    return;
  }

  const securityKey = algorithm.startsWith('sk-');
  const ecdsaAlgorithm = (securityKey ? algorithm.slice(3) : algorithm).split('@')[0] ?? '';
  if (ecdsaAlgorithm === 'ssh-ed25519') {
    if (fields.length !== 2 || fields[0]?.length !== 32 || fields[1]?.length === 0) {
      throw new Error('The SSH security-key public key payload is malformed.');
    }
    return;
  }

  const curve = ecdsaAlgorithm.replace('ecdsa-sha2-', '');
  const expectedPointBytes = curve === 'nistp256' ? 65 : curve === 'nistp384' ? 97 : 133;
  if (
    fields.length !== (securityKey ? 3 : 2) ||
    fields[0]?.toString('utf8') !== curve ||
    fields[1]?.length !== expectedPointBytes ||
    fields[1]?.[0] !== 4 ||
    (securityKey && fields[2]?.length === 0)
  ) {
    throw new Error('The SSH ECDSA public key payload is malformed.');
  }
}

export function looksLikeSshPublicKey(value: string): boolean {
  const trimmed = value.trimStart();
  const separator = trimmed.search(/\s/u);
  if (separator < 0) return supportedAlgorithms.has(trimmed);
  return /^(?:ecdsa-|sk-|ssh-)/u.test(trimmed.slice(0, separator));
}

/** Parse one supported OpenSSH public key line into canonical key material and fingerprint. */
export default function parseSshPublicKey(value: string): ParsedSshPublicKey {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/u.test(trimmed)) {
    throw new Error('The SSH public key must contain exactly one non-empty line.');
  }

  const [algorithm, encoded] = trimmed.split(/\s+/u, 3);
  if (!algorithm || !supportedAlgorithms.has(algorithm)) {
    throw new Error('The SSH public key algorithm is not supported by GitHub.');
  }
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 === 1) {
    throw new Error('The SSH public key payload is not valid base64.');
  }

  const payload = Buffer.from(encoded, 'base64');
  if (
    payload.length < 5 ||
    payload.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')
  ) {
    throw new Error('The SSH public key payload is not valid base64.');
  }
  const algorithmBytes = payload.readUInt32BE(0);
  if (algorithmBytes < 1 || algorithmBytes > payload.length - 4) {
    throw new Error('The SSH public key payload is malformed.');
  }
  if (payload.subarray(4, 4 + algorithmBytes).toString('utf8') !== algorithm) {
    throw new Error('The SSH public key algorithm does not match its payload.');
  }
  validatePayload(algorithm, payload, 4 + algorithmBytes);

  return {
    algorithm,
    fingerprint: `SHA256:${createHash('sha256').update(payload).digest('base64').replace(/=+$/u, '')}`,
    key: `${algorithm} ${payload.toString('base64')}`,
  };
}
