import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import type { CredentialKey, CredentialStore } from './types.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';
import { sessionDispatchScopes } from '../agent/session-dispatch-requirements.ts';

const recordSchema = Type.Object(
  {
    version: Type.Literal(1),
    device: Type.Object(
      {
        deviceId: Type.String({ pattern: '^[a-f0-9]{64}$' }),
        publicKeyPem: Type.String({ minLength: 1 }),
        privateKeyPem: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    token: Type.Optional(Type.String({ minLength: 1 })),
    bootstrap: Type.Optional(
      Type.Object(
        {
          token: Type.String({ minLength: 1 }),
          expiresAtMs: Type.Number(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type DispatchCredential = Static<typeof recordSchema>;
export interface DispatchAuthority {
  signal?: AbortSignal;
  assertCurrent?(): Promise<void>;
  assertEnrollmentCurrent?(): void;
  sessionDispatchConsent?: boolean;
}
export type DispatchRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export interface DispatchPairing {
  paired: boolean;
  usable: boolean;
  requestId?: string;
}
export interface DispatchCredentialDependencies {
  store: CredentialStore;
  key: CredentialKey;
  lock<T>(operation: (assertHeld: () => void) => Promise<T>): Promise<T>;
  pairing(deviceId: string): Promise<DispatchPairing>;
  issue(assertCurrent: () => void): Promise<{ token: string; expiresAtMs: number }>;
  revoke(token: string): Promise<unknown>;
  connect(
    record: DispatchCredential,
    bootstrap: boolean,
    authority: DispatchAuthority,
  ): Promise<{ token?: string; scopes: string[] }>;
  use?<T>(
    record: DispatchCredential,
    authority: DispatchAuthority,
    operation: (request: DispatchRequest, scopes: string[]) => Promise<T>,
  ): Promise<T>;
  now?(): number;
}

export function dispatchCredentialError(code: string, message: string): never {
  throw new AgentSystemLifecycleError('session-dispatch', code, message);
}

/** retain enrollment intent before issuance; never replace an unusable credential silently. */
export default class SessionDispatchCredential {
  constructor(private readonly dependencies: DispatchCredentialDependencies) {}

  async needsEnrollment() {
    const record = await this.read();
    return !record?.token;
  }

  async inspect() {
    const record = await this.read();
    if (!record)
      return {
        code: 'session-dispatch-credential-missing',
        status: 'drift' as const,
        message: 'Session dispatch credential is missing.',
        remediation: 'Run Install and approve session dispatch enrollment.',
      };
    const pairing = await this.dependencies.pairing(record.device.deviceId);
    const deviceId = record.device.deviceId;
    const suffix = ` Device ${deviceId}.`;
    if (!record.token)
      return {
        code: 'session-dispatch-pairing-pending',
        status: 'blocked' as const,
        message: `Session dispatch enrollment is incomplete.${suffix}`,
        remediation: pairing.requestId
          ? `Approve request ${pairing.requestId} in Devices or with openclaw devices approve ${pairing.requestId}, then rerun Install.`
          : 'Rerun Install with enrollment consent to resume the retained identity.',
      };
    if (!pairing.paired || !pairing.usable)
      return {
        code: 'session-dispatch-credential-revoked',
        status: 'blocked' as const,
        message: `Session dispatch device authorization is missing, revoked, or lacks required scopes.${suffix}`,
        remediation: `Remove this exact device in Devices, then run openclaw agent-system session-dispatch reset ${deviceId} before explicitly re-enrolling.`,
      };
    try {
      const connected = await this.dependencies.connect(record, false, {});
      this.verifyScopes(connected.scopes);
    } catch {
      return {
        code: 'session-dispatch-verification-unavailable',
        status: 'blocked' as const,
        message: `Session dispatch device-only connection could not be verified.${suffix}`,
        remediation:
          'Check Gateway availability; do not replace the credential based on a connection failure.',
      };
    }
    return {
      code: 'session-dispatch-ready',
      status: 'healthy' as const,
      message: `Session dispatch credential verified using device-only authentication.${suffix}`,
    };
  }

  async enroll(authority: DispatchAuthority) {
    return this.dependencies.lock(async (assertHeld) => {
      const assertCurrent = () => {
        assertHeld();
        authority.signal?.throwIfAborted();
        authority.assertEnrollmentCurrent?.();
      };
      const guard = async () => {
        assertCurrent();
        await authority.assertCurrent?.();
        assertCurrent();
      };
      await guard();
      let record = await this.read();
      if (record?.token) {
        const finding = await this.inspect();
        if (finding.status !== 'healthy')
          dispatchCredentialError(finding.code, `${finding.message} ${finding.remediation ?? ''}`);
        await guard();
        if (record.bootstrap) {
          await this.dependencies.revoke(record.bootstrap.token);
          delete record.bootstrap;
          await guard();
          await this.write(record);
        }
        return {
          code: 'session-dispatch-unchanged',
          status: 'unchanged' as const,
          message: finding.message,
        };
      }
      if (!authority.sessionDispatchConsent)
        dispatchCredentialError(
          'session-dispatch-approval-required',
          'Session dispatch enrollment requires explicit Install consent; use interactive Install or --yes.',
        );
      if (!record) {
        const pair = generateKeyPairSync('ed25519');
        const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
        record = {
          version: 1,
          device: {
            deviceId: createHash('sha256')
              .update(
                createPublicKey(publicKeyPem).export({ format: 'der', type: 'spki' }).subarray(-32),
              )
              .digest('hex'),
            publicKeyPem,
            privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
          },
        };
        await guard();
        await this.write(record);
      }
      if (
        record.bootstrap &&
        record.bootstrap.expiresAtMs <= (this.dependencies.now?.() ?? Date.now())
      ) {
        await guard();
        await this.dependencies.revoke(record.bootstrap.token);
        delete record.bootstrap;
        await this.write(record);
      }
      if (!record.bootstrap) {
        await guard();
        const bootstrap = await this.dependencies.issue(assertCurrent);
        record.bootstrap = bootstrap;
        try {
          await guard();
          await this.write(record);
        } catch (error) {
          await this.dependencies.revoke(bootstrap.token);
          throw error;
        }
      }
      await guard();
      let connected;
      try {
        connected = await this.dependencies.connect(record, true, authority);
      } catch {
        await guard();
        const pairing = await this.dependencies.pairing(record.device.deviceId);
        dispatchCredentialError(
          pairing.requestId
            ? 'session-dispatch-pairing-pending'
            : 'session-dispatch-enrollment-unverified',
          pairing.requestId
            ? `Approve device ${record.device.deviceId}, request ${pairing.requestId}, in Devices or with openclaw devices approve ${pairing.requestId}; rerun Install to resume.`
            : `Enrollment could not be verified for device ${record.device.deviceId}; rerun Install to resume this identity.`,
        );
      }
      this.verifyScopes(connected.scopes);
      if (!connected.token)
        dispatchCredentialError(
          'session-dispatch-token-missing',
          'Gateway returned no session dispatch device credential.',
        );
      record.token = connected.token;
      await guard();
      await this.write(record);
      await this.dependencies.revoke(record.bootstrap.token);
      delete record.bootstrap;
      await guard();
      await this.write(record);
      const finding = await this.inspect();
      if (finding.status !== 'healthy') dispatchCredentialError(finding.code, finding.message);
      await guard();
      return {
        code: 'session-dispatch-enrolled',
        status: 'created' as const,
        message: finding.message,
      };
    });
  }

  /** use retained device-only authority; never enroll or return credential material. */
  async use<T>(authority: DispatchAuthority, operation: (request: DispatchRequest) => Promise<T>) {
    const guard = async () => {
      authority.signal?.throwIfAborted();
      await authority.assertCurrent?.();
      authority.signal?.throwIfAborted();
    };
    await guard();
    const record = await this.read();
    if (!record?.token)
      dispatchCredentialError(
        'session-dispatch-credential-missing',
        'Run Install to enroll first.',
      );
    const pairing = await this.dependencies.pairing(record.device.deviceId);
    if (!pairing.paired || !pairing.usable)
      dispatchCredentialError(
        'session-dispatch-credential-revoked',
        'Device authorization is unavailable.',
      );
    if (!this.dependencies.use)
      dispatchCredentialError(
        'session-dispatch-transport-unavailable',
        'Session transport is unavailable.',
      );
    await guard();
    return this.dependencies.use(record, authority, async (request, scopes) => {
      this.verifyScopes(scopes);
      await guard();
      return operation(async (method, params) => {
        await guard();
        return request(method, params);
      });
    });
  }

  async reset(deviceId: string) {
    return this.dependencies.lock(async (assertHeld) => {
      const record = await this.read();
      if (!record || record.device.deviceId !== deviceId)
        dispatchCredentialError(
          'session-dispatch-reset-mismatch',
          'The exact retained session dispatch device ID is required.',
        );
      const pairing = await this.dependencies.pairing(deviceId);
      if (pairing.paired || pairing.requestId)
        dispatchCredentialError(
          'session-dispatch-reset-still-authorized',
          'Remove this exact device and any pending request in Devices before clearing local enrollment.',
        );
      assertHeld();
      if (record.bootstrap) await this.dependencies.revoke(record.bootstrap.token);
      assertHeld();
      const result = await this.dependencies.store.remove(this.dependencies.key);
      if (result.status !== 'removed' && result.status !== 'missing')
        dispatchCredentialError(
          'session-dispatch-storage-unavailable',
          'Protected session dispatch storage could not be cleared.',
        );
      if (await this.read())
        dispatchCredentialError(
          'session-dispatch-reset-unverified',
          'Local enrollment reset could not be verified.',
        );
      return { status: 'removed', deviceId };
    });
  }

  private verifyScopes(scopes: string[]) {
    if (
      scopes.length !== sessionDispatchScopes.length ||
      !sessionDispatchScopes.every((scope) => scopes.includes(scope))
    )
      dispatchCredentialError(
        'session-dispatch-scope-mismatch',
        'Gateway session dispatch grants differ from the approved read/write scopes.',
      );
  }

  private async read(): Promise<DispatchCredential | undefined> {
    const result = await this.dependencies.store.read(this.dependencies.key);
    if (result.status === 'missing') return;
    if (result.status !== 'found')
      dispatchCredentialError(
        'session-dispatch-storage-unavailable',
        'Protected session dispatch credential storage is unavailable; no file fallback is used.',
      );
    try {
      const value: unknown = JSON.parse(result.value);
      if (!Value.Check(recordSchema, value)) throw new Error();
      const publicKey = createPublicKey(value.device.privateKeyPem)
        .export({ format: 'pem', type: 'spki' })
        .toString();
      const id = createHash('sha256')
        .update(createPublicKey(publicKey).export({ format: 'der', type: 'spki' }).subarray(-32))
        .digest('hex');
      if (publicKey !== value.device.publicKeyPem || id !== value.device.deviceId)
        throw new Error();
      return value;
    } catch {
      dispatchCredentialError(
        'session-dispatch-storage-invalid',
        'Retained session dispatch enrollment is invalid; it was not overwritten.',
      );
    }
  }

  private async write(record: DispatchCredential) {
    const value = JSON.stringify(record);
    const result = await this.dependencies.store.write(this.dependencies.key, value);
    if (!['stored', 'unchanged'].includes(result.status))
      dispatchCredentialError(
        'session-dispatch-storage-unavailable',
        'Session dispatch enrollment could not be stored securely.',
      );
    const check = await this.dependencies.store.read(this.dependencies.key);
    if (check.status !== 'found' || check.value !== value)
      dispatchCredentialError(
        'session-dispatch-storage-unverified',
        'Session dispatch storage readback failed.',
      );
  }
}
