import {
  isCredentialKeyValid,
  isCredentialValueValid,
  maximumCredentialBytes,
  type CredentialKey,
  type CredentialStore,
  type CredentialStoreProblem,
  type CredentialStoreReadResult,
  type CredentialStoreRemoveResult,
  type CredentialStoreWriteResult,
} from './types.ts';
import runCredentialCommand, {
  type CredentialCommandOptions,
  type CredentialCommandResult,
} from './run-command.ts';

const defaultTimeoutMs = 5_000;
const secretToolMaximumCredentialBytes = 8_191;

export type SecretServiceCommandRunner = (
  options: CredentialCommandOptions,
) => Promise<CredentialCommandResult>;

export interface SecretServiceCredentialStoreDependencies {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runCommand?: SecretServiceCommandRunner;
  timeoutMs?: number;
}

function problem(
  status: CredentialStoreProblem['status'],
  code: string,
  message: string,
): CredentialStoreProblem {
  return { status, code, message };
}

/** Persist credentials through the Linux Secret Service command-line client. */
export default class SecretServiceCredentialStore implements CredentialStore {
  readonly id = 'secret-service';
  readonly #environment: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;
  readonly #runCommand: SecretServiceCommandRunner;
  readonly #timeoutMs: number;

  constructor(dependencies: SecretServiceCredentialStoreDependencies = {}) {
    const environment = { ...(dependencies.environment ?? process.env) };
    delete environment.OP_SERVICE_ACCOUNT_TOKEN;
    this.#environment = environment;
    this.#platform = dependencies.platform ?? process.platform;
    this.#runCommand = dependencies.runCommand ?? runCredentialCommand;
    this.#timeoutMs = dependencies.timeoutMs ?? defaultTimeoutMs;
  }

  async read(key: CredentialKey): Promise<CredentialStoreReadResult> {
    const unavailable = this.#unavailable(key);
    if (unavailable) return unavailable;

    const result = await this.#run(['lookup', ...this.#attributes(key)]);
    if (result.status === 'output-too-large') {
      return problem(
        'unsafe',
        'credential-secret-service-value-too-large',
        'The Linux Secret Service credential exceeds the supported size limit.',
      );
    }
    if (result.status !== 'completed') return this.#operationUnavailable();
    if (result.exitCode === 1 && result.stdout.byteLength === 0 && result.stderr.byteLength === 0) {
      return { status: 'missing' };
    }
    if (result.exitCode !== 0) return this.#operationUnavailable();

    let value: string;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
    } catch {
      return problem(
        'unsafe',
        'credential-secret-service-encoding',
        'The Linux Secret Service credential must contain valid UTF-8.',
      );
    }
    if (!isCredentialValueValid(value)) {
      return problem(
        'unsafe',
        'credential-secret-service-value',
        'The Linux Secret Service does not contain a usable credential value.',
      );
    }
    return { status: 'found', value };
  }

  async write(key: CredentialKey, value: string): Promise<CredentialStoreWriteResult> {
    if (!isCredentialValueValid(value)) {
      return problem(
        'unsafe',
        'credential-value-invalid',
        'The supplied credential value is empty, invalid, or too large.',
      );
    }
    if (Buffer.byteLength(value, 'utf8') > secretToolMaximumCredentialBytes) {
      return problem(
        'unavailable',
        'credential-secret-service-value-too-large',
        'The credential is too large for the installed Linux Secret Service client.',
      );
    }

    const existing = await this.read(key);
    if (existing.status === 'found' && existing.value === value) return { status: 'unchanged' };
    if (existing.status === 'unsafe' || existing.status === 'unavailable') return existing;

    const result = await this.#run(
      [
        'store',
        `--label=Agent System ${key.credentialId.toUpperCase()} credential for ${key.agentId}`,
        ...this.#attributes(key),
      ],
      value,
    );
    return result.status === 'completed' && result.exitCode === 0
      ? { status: 'stored' }
      : this.#operationUnavailable('credential-secret-service-write-failed');
  }

  async remove(key: CredentialKey): Promise<CredentialStoreRemoveResult> {
    const existing = await this.read(key);
    if (existing.status !== 'found') return existing;

    const result = await this.#run(['clear', ...this.#attributes(key)]);
    return result.status === 'completed' && result.exitCode === 0
      ? { status: 'removed' }
      : this.#operationUnavailable('credential-secret-service-remove-failed');
  }

  #attributes(key: CredentialKey): string[] {
    return [
      'application',
      'tanaab-openclaw-agent-system',
      'agent',
      key.agentId,
      'credential',
      key.credentialId,
    ];
  }

  #operationUnavailable(code = 'credential-secret-service-unavailable'): CredentialStoreProblem {
    return problem(
      'unavailable',
      code,
      'The Linux Secret Service is not available in this session.',
    );
  }

  async #run(args: string[], input?: string): Promise<CredentialCommandResult> {
    try {
      return await this.#runCommand({
        args,
        command: 'secret-tool',
        environment: this.#environment,
        ...(input === undefined ? {} : { input }),
        maximumOutputBytes: maximumCredentialBytes,
        timeoutMs: this.#timeoutMs,
      });
    } catch {
      return {
        status: 'failed-to-start',
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      };
    }
  }

  #unavailable(key: CredentialKey): CredentialStoreProblem | undefined {
    if (!isCredentialKeyValid(key)) {
      return problem(
        'unavailable',
        'credential-secret-service-key-invalid',
        'The Linux Secret Service credential key is invalid.',
      );
    }
    if (this.#platform !== 'linux') {
      return problem(
        'unavailable',
        'credential-secret-service-platform',
        'The Linux Secret Service is only available on Linux.',
      );
    }
    return undefined;
  }
}
