export interface CredentialKey {
  agentId: string;
  credentialId: string;
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
