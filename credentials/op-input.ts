import { password } from '@clack/prompts';
import { type Readable, type Writable } from 'node:stream';
import { text } from 'node:stream/consumers';

import { maximumCredentialBytes } from './types.ts';
import { opServiceAccountTokenEnvironmentVariable } from './op-service.ts';

export type OpCredentialInputSource = 'environment' | 'prompt' | 'stdin';

export type OpCredentialInputResult =
  | { code: string; message: string; status: 'invalid' }
  | { source: OpCredentialInputSource; status: 'read'; token: string };

type PasswordPrompt = (options: {
  input?: Readable;
  message: string;
  output?: Writable;
  validate?(value: string | undefined): string | Error | undefined;
}) => Promise<string | symbol>;

export interface OpCredentialInputDependencies {
  hostEnvironment: Readonly<Record<string, string | undefined>>;
  input: Readable;
  output: Writable;
  prompt?: PasswordPrompt;
}

function invalidInput(token: string | undefined): string | undefined {
  if (token === undefined || token.trim() === '' || token.includes('\0')) {
    return 'The OP credential must contain a usable value.';
  }
  if (Buffer.byteLength(token, 'utf8') > maximumCredentialBytes) {
    return 'The OP credential exceeds the supported size limit.';
  }
  return undefined;
}

/** Read one OP credential without exposing it through command arguments or output. */
export default class OpCredentialInput {
  readonly #hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #prompt: PasswordPrompt;

  constructor(dependencies: OpCredentialInputDependencies) {
    this.#hostEnvironment = Object.freeze({ ...dependencies.hostEnvironment });
    this.#input = dependencies.input;
    this.#output = dependencies.output;
    this.#prompt = dependencies.prompt ?? password;
  }

  async read(source: OpCredentialInputSource): Promise<OpCredentialInputResult> {
    if (source === 'environment') {
      const token = this.#hostEnvironment[opServiceAccountTokenEnvironmentVariable];
      if (token === undefined || token.trim() === '') {
        return {
          status: 'invalid',
          code: 'op-environment-credential-missing',
          message: `${opServiceAccountTokenEnvironmentVariable} is not available to store.`,
        };
      }
      const message = invalidInput(token);
      return message
        ? { status: 'invalid', code: 'op-credential-input-invalid', message }
        : { status: 'read', source, token };
    }

    if (source === 'stdin') {
      try {
        const token = (await text(this.#input)).replace(/\r?\n$/, '');
        const message = invalidInput(token);
        return message
          ? { status: 'invalid', code: 'op-credential-input-invalid', message }
          : { status: 'read', source, token };
      } catch {
        return {
          status: 'invalid',
          code: 'op-credential-input-failed',
          message: 'The OP credential could not be read from standard input.',
        };
      }
    }

    const inputIsTty = (this.#input as Readable & { isTTY?: boolean }).isTTY === true;
    const outputIsTty = (this.#output as Writable & { isTTY?: boolean }).isTTY === true;
    if (!inputIsTty || !outputIsTty) {
      return {
        status: 'invalid',
        code: 'op-credential-input-required',
        message: 'Interactive credential input requires a terminal. Use --from-env or --stdin.',
      };
    }

    let token: string | symbol;
    try {
      token = await this.#prompt({
        input: this.#input,
        message: 'Enter OP service account token',
        output: this.#output,
        validate: invalidInput,
      });
    } catch {
      return {
        status: 'invalid',
        code: 'op-credential-input-failed',
        message: 'The OP credential could not be read from the interactive terminal.',
      };
    }
    if (typeof token === 'symbol') {
      return {
        status: 'invalid',
        code: 'op-credential-input-cancelled',
        message: 'OP credential input was cancelled.',
      };
    }
    const message = invalidInput(token);
    return message
      ? { status: 'invalid', code: 'op-credential-input-invalid', message }
      : { status: 'read', source, token };
  }
}
