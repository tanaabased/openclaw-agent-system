export const onePasswordServiceAccountTokenEnvironmentVariable = 'OP_SERVICE_ACCOUNT_TOKEN';

export interface OnePasswordCredentialProvider {
  /** Return undefined when unavailable so resolution can continue to the next provider. */
  resolveServiceAccountToken(agentId: string): Promise<string | undefined>;
}

export interface OnePasswordCredentialServiceDependencies {
  hostEnvironment: Readonly<Record<string, string | undefined>>;
  providers?: readonly OnePasswordCredentialProvider[];
}

/** Resolve configured credential providers before the permanent process-environment fallback. */
export default class OnePasswordCredentialService {
  readonly #hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #providers: readonly OnePasswordCredentialProvider[];

  constructor(dependencies: OnePasswordCredentialServiceDependencies) {
    this.#hostEnvironment = Object.freeze({ ...dependencies.hostEnvironment });
    this.#providers = [...(dependencies.providers ?? [])];
  }

  async resolveServiceAccountToken(agentId: string): Promise<string | undefined> {
    for (const provider of this.#providers) {
      const token = await provider.resolveServiceAccountToken(agentId);
      if (token !== undefined && token.trim() !== '') return token;
    }

    const fallback = this.#hostEnvironment[onePasswordServiceAccountTokenEnvironmentVariable];
    return fallback !== undefined && fallback.trim() !== '' ? fallback : undefined;
  }
}
