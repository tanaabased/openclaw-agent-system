export interface CredentialKey {
  agentId: string;
  credentialId: string;
}

export const maximumCredentialBytes = 64 * 1024;
const credentialIdentifierPattern = /^[a-z0-9][a-z0-9-]*$/;

export function isCredentialKeyValid(key: CredentialKey): boolean {
  return (
    credentialIdentifierPattern.test(key.agentId) &&
    credentialIdentifierPattern.test(key.credentialId)
  );
}

export function isCredentialValueValid(value: string): boolean {
  return (
    value.trim() !== '' &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= maximumCredentialBytes
  );
}

export interface CredentialStoreProblem {
  code: string;
  message: string;
  status: 'unavailable' | 'unsafe';
}

export type CredentialStoreReadResult =
  CredentialStoreProblem | { status: 'found'; value: string } | { status: 'missing' };

export type CredentialStoreWriteResult =
  CredentialStoreProblem | { status: 'stored' | 'unchanged' };

export type CredentialStoreRemoveResult =
  CredentialStoreProblem | { status: 'removed' | 'missing' };

/** Store one opaque credential without exposing it through metadata operations. */
export interface CredentialStore {
  readonly id: string;
  read(key: CredentialKey): Promise<CredentialStoreReadResult>;
  remove(key: CredentialKey): Promise<CredentialStoreRemoveResult>;
  write(key: CredentialKey, value: string): Promise<CredentialStoreWriteResult>;
}
