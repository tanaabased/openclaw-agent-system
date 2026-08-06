import {
  isCredentialKeyValid,
  isCredentialValueValid,
  type CredentialKey,
  type CredentialStore,
  type CredentialStoreProblem,
  type CredentialStoreReadResult,
  type CredentialStoreRemoveResult,
  type CredentialStoreWriteResult,
} from './credential-store.ts';

const defaultTimeoutMs = 5_000;

interface KeychainCredential {
  account: string;
  password: string;
}

interface KeychainEntry {
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
  setPassword(password: string, signal?: AbortSignal): Promise<void>;
}

export interface KeychainModule {
  AsyncEntry: new (service: string, account: string) => KeychainEntry;
  findCredentialsAsync(
    service: string,
    target?: string,
    signal?: AbortSignal,
  ): Promise<KeychainCredential[]>;
}

export interface KeychainCredentialStoreDependencies {
  loadKeychain?: () => Promise<KeychainModule>;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

function problem(
  status: CredentialStoreProblem['status'],
  code: string,
  message: string,
): CredentialStoreProblem {
  return { status, code, message };
}

async function loadInstalledKeychain(): Promise<KeychainModule> {
  return import('@napi-rs/keyring');
}

/** Persist credentials in the current user's macOS login Keychain. */
export default class KeychainCredentialStore implements CredentialStore {
  readonly id = 'keychain';
  readonly #loadKeychain: () => Promise<KeychainModule>;
  readonly #platform: NodeJS.Platform;
  readonly #timeoutMs: number;

  constructor(dependencies: KeychainCredentialStoreDependencies = {}) {
    this.#loadKeychain = dependencies.loadKeychain ?? loadInstalledKeychain;
    this.#platform = dependencies.platform ?? process.platform;
    this.#timeoutMs = dependencies.timeoutMs ?? defaultTimeoutMs;
  }

  async read(key: CredentialKey): Promise<CredentialStoreReadResult> {
    const unavailable = this.#unavailable(key);
    if (unavailable) return unavailable;

    try {
      const keychain = await this.#loadKeychain();
      const credentials = await keychain.findCredentialsAsync(
        this.#service(key),
        undefined,
        AbortSignal.timeout(this.#timeoutMs),
      );
      const matches = credentials.filter(({ account }) => account === key.credentialId);
      if (matches.length === 0) return { status: 'missing' };
      if (matches.length > 1) {
        return problem(
          'unsafe',
          'credential-keychain-ambiguous',
          'The macOS Keychain contains multiple matching credentials.',
        );
      }
      const value = matches[0]?.password;
      if (value === undefined || !isCredentialValueValid(value)) {
        return problem(
          'unsafe',
          'credential-keychain-value',
          'The macOS Keychain does not contain a usable credential value.',
        );
      }
      return { status: 'found', value };
    } catch {
      return problem(
        'unavailable',
        'credential-keychain-unavailable',
        'The macOS Keychain is not available.',
      );
    }
  }

  async write(key: CredentialKey, value: string): Promise<CredentialStoreWriteResult> {
    if (!isCredentialValueValid(value)) {
      return problem(
        'unsafe',
        'credential-value-invalid',
        'The supplied credential value is empty, invalid, or too large.',
      );
    }
    const existing = await this.read(key);
    if (existing.status === 'found' && existing.value === value) return { status: 'unchanged' };
    if (existing.status === 'unsafe' || existing.status === 'unavailable') return existing;

    try {
      const keychain = await this.#loadKeychain();
      const entry = new keychain.AsyncEntry(this.#service(key), key.credentialId);
      await entry.setPassword(value, AbortSignal.timeout(this.#timeoutMs));
      return { status: 'stored' };
    } catch {
      return problem(
        'unavailable',
        'credential-keychain-write-failed',
        'The credential could not be stored in the macOS Keychain.',
      );
    }
  }

  async remove(key: CredentialKey): Promise<CredentialStoreRemoveResult> {
    const existing = await this.read(key);
    if (existing.status !== 'found') return existing;

    try {
      const keychain = await this.#loadKeychain();
      const entry = new keychain.AsyncEntry(this.#service(key), key.credentialId);
      const removed = await entry.deleteCredential(AbortSignal.timeout(this.#timeoutMs));
      return removed
        ? { status: 'removed' }
        : problem(
            'unavailable',
            'credential-keychain-remove-failed',
            'The credential could not be removed from the macOS Keychain.',
          );
    } catch {
      return problem(
        'unavailable',
        'credential-keychain-remove-failed',
        'The credential could not be removed from the macOS Keychain.',
      );
    }
  }

  #service(key: CredentialKey): string {
    return `@tanaab/openclaw-agent-system/${key.agentId}`;
  }

  #unavailable(key: CredentialKey): CredentialStoreProblem | undefined {
    if (!isCredentialKeyValid(key)) {
      return problem(
        'unavailable',
        'credential-keychain-key-invalid',
        'The macOS Keychain credential key is invalid.',
      );
    }
    if (this.#platform !== 'darwin') {
      return problem(
        'unavailable',
        'credential-keychain-platform',
        'The macOS Keychain is only available on macOS.',
      );
    }
    return undefined;
  }
}
