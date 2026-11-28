import metadata from '../package.json' with { type: 'json' };
import { opServiceAccountTokenName } from '../environment/resolve.ts';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import { readBoundCodexWorkspace } from '../agent/identity/codex-workspace-binding.ts';
import type { AgentSystemLifecycleFinding } from '../core/lifecycle-registry.ts';
import collectOpEnvironmentRequirements, {
  hasOpEnvironmentRequirements,
  type OpEnvironmentRequirements,
} from '../environment/op-requirements.ts';
import type { CreateOpEnvironmentClient } from '../environment/op-service.ts';
import type { ManifestDiagnostic } from '../manifest/types.ts';
import OpCredentialManager from './op-manager.ts';
import OpCredentialService from './op-service.ts';
import OpCredentialInput, { type OpCredentialInputSource } from './op-input.ts';
import { browserEnrollment, type EnrollmentOutcome } from './codex-op-browser.ts';
import { platformCredentialStore } from './registry.ts';
import type { CredentialStore } from './types.ts';

interface Target {
  owner: string;
  requirements: OpEnvironmentRequirements;
  revision: string;
  label: string;
}

export interface CodexOpDependencies {
  store?: CredentialStore;
  createClient?: CreateOpEnvironmentClient;
  storeEnvironment?: NodeJS.ProcessEnv;
  input?: Pick<OpCredentialInput, 'read'>;
}

async function targetFor(pluginData: string): Promise<Target | undefined> {
  const { binding, loaded } = await readBoundCodexWorkspace(pluginData);
  const { manifest, digest } = loaded;
  const requirements = collectOpEnvironmentRequirements(manifest);
  if (!hasOpEnvironmentRequirements(requirements)) return;
  const owner = createHash('sha256').update(await realpath(pluginData));
  owner.update(JSON.stringify([binding.workspaceDir, manifest.agent.id, binding.credentialScope]));
  return {
    owner: owner.digest('hex'),
    requirements,
    revision: digest,
    label: 'Codex workspace ' + JSON.stringify(binding.workspaceDir),
  };
}

function finding(
  state: 'ready' | 'missing' | 'rejected' | 'inaccessible',
  localStore = false,
): AgentSystemLifecycleFinding {
  const subject = 'The binding 1Password credential';
  const guidance = 'Run interactive Agent System Install to connect 1Password.';
  const descriptions = {
    ready: ' can access the declared resources.',
    missing: ' is missing. ' + guidance,
    rejected: ' was rejected. Check its grants. ' + guidance,
    inaccessible: localStore
      ? ' is inaccessible in the OS credential store. Check macOS login Keychain or Linux Secret Service.'
      : ' could not be validated with 1Password. Check connectivity and access to the declared resources.',
  };
  return {
    component: 'credentials',
    code: 'codex-op-binding-' + state,
    status: state === 'ready' ? 'healthy' : 'blocked',
    message: subject + descriptions[state],
  };
}

function classify(diagnostic?: Pick<ManifestDiagnostic, 'code' | 'providerDiagnostic'>) {
  if (diagnostic?.code === 'op-credential-missing') return 'missing';
  const evidence = diagnostic?.providerDiagnostic;
  if (
    evidence?.classification === 'authentication' ||
    evidence?.classification === 'permission' ||
    evidence?.httpStatus === 401 ||
    evidence?.httpStatus === 403
  )
    return 'rejected';
  return 'inaccessible';
}

/** Resolve private credential ownership from the active Codex workspace binding. */
export async function codexOpCredential(
  pluginData: string,
  dependencies: CodexOpDependencies = {},
) {
  const selected = await targetFor(pluginData);
  if (!selected) return;
  const target = selected;
  const { default: OpEnvironmentService } = await import('../environment/op-service.ts');
  const store =
    dependencies.store ??
    platformCredentialStore({
      platform: process.platform,
      environment: dependencies.storeEnvironment ?? process.env,
    });
  const credentials = new OpCredentialService({
    hostEnvironment: {},
    stores: store ? [store] : [],
    credentialId: 'codex-binding-op',
  });
  const service = new OpEnvironmentService({
    credentialService: credentials,
    createClient: dependencies.createClient,
    integrationVersion: metadata.version,
  });
  async function assertCurrent() {
    const live = await targetFor(pluginData);
    if (!live || live.owner !== target.owner || live.revision !== target.revision)
      throw new Error('The Codex credential owner or declaration changed. Inspect it again.');
  }
  async function check() {
    await assertCurrent();
    if (!store) return { finding: finding('inaccessible', true), canEnroll: false };
    const result = await service.validate(target.owner, target.requirements, {
      allowEnvironmentFallback: false,
    });
    await assertCurrent();
    if (result.status === 'valid') return { finding: finding('ready'), canEnroll: false };
    const diagnostic = result.diagnostics[0];
    const state = classify(diagnostic);
    const localStore = diagnostic?.providerDiagnostic?.operation === 'credential-resolve';
    return {
      finding: finding(state, localStore),
      canEnroll: state === 'missing' || state === 'rejected',
    };
  }
  async function inspect() {
    return (await check()).finding;
  }
  async function save(token: string, storeId: string): Promise<EnrollmentOutcome> {
    await assertCurrent();
    const manager = new OpCredentialManager({
      credentialService: credentials,
      environmentService: service,
    });
    const result = await manager.setForOwner(
      target.owner,
      target.requirements,
      token,
      storeId,
      assertCurrent,
    );
    if (result.status === 'invalid') {
      const { code, providerDiagnostic } = result;
      const state = classify(result);
      const localStore = code.startsWith('credential-');
      if (code === 'op-credential-mutation-uncertain' || code.endsWith('-write-uncertain')) {
        return {
          screen: 'uncertain',
          finding: unconfirmedSave(),
        };
      }
      const accessDenied =
        providerDiagnostic?.classification === 'permission' ||
        providerDiagnostic?.httpStatus === 403 ||
        code === 'op-variable-missing';
      return {
        screen: localStore
          ? 'store'
          : accessDenied
            ? 'access'
            : state === 'rejected'
              ? 'rejected'
              : 'unavailable',
        finding: finding(state, localStore),
      };
    }
    const stored = await inspect();
    return stored.status === 'healthy'
      ? { screen: 'connected', finding: stored }
      : { screen: 'uncertain', finding: unconfirmedSave() };
  }
  function unconfirmedSave(): AgentSystemLifecycleFinding {
    return {
      component: 'credentials',
      status: 'blocked',
      code: 'op-credential-mutation-uncertain',
      message: 'The credential save could not be confirmed. Run Doctor before trying again.',
    };
  }
  async function readAndSave(
    storeId: string,
    source: OpCredentialInputSource,
    environmentVariable?: string,
  ): Promise<AgentSystemLifecycleFinding> {
    const input =
      dependencies.input ??
      new OpCredentialInput({
        hostEnvironment: {},
        input: process.stdin,
        output: process.stderr,
      });
    const candidate = await input.read(
      source,
      'Enter the 1Password service-account token for ' + target.label,
      environmentVariable,
    );
    if (candidate.status === 'invalid')
      return {
        ...finding('missing'),
        code: candidate.code,
        message:
          candidate.code === 'op-credential-input-required'
            ? 'Enrollment requires operator input in a local terminal.'
            : candidate.message,
      };
    return (await save(candidate.token, storeId)).finding;
  }

  return {
    inspect,
    async set(source: OpCredentialInputSource, environmentVariable?: string) {
      await assertCurrent();
      if (!store) return finding('inaccessible', true);
      return readAndSave(store.id, source, environmentVariable);
    },
    async loadBindingEnvironment(
      manifestDigest: string,
      names: ReadonlySet<string>,
      signal?: AbortSignal,
    ) {
      if (target.revision !== manifestDigest)
        throw new Error('The Codex workspace 1Password declaration changed.');
      await assertCurrent();
      const requirements = {
        environmentIds: target.requirements.environmentIds,
        secrets: target.requirements.secrets.filter(({ name }) => names.has(name)),
      };
      const result = await service.load(target.owner, requirements, { fresh: true, signal });
      await assertCurrent();
      return result;
    },
    async enrollInBrowser(onReady: (url: string) => void, environment = process.env) {
      const readiness = await check();
      if (!readiness.canEnroll || !store) return readiness.finding;
      return browserEnrollment({
        label: target.label,
        requirements: target.requirements,
        environmentToken: environment[opServiceAccountTokenName],
        onReady,
        save: async (token) => {
          const current = await check();
          if (current.canEnroll) return save(token, store.id);
          return {
            screen: current.finding.status === 'healthy' ? 'connected' : 'unavailable',
            finding: current.finding,
          };
        },
      });
    },
    async enroll() {
      const readiness = await check();
      if (!readiness.canEnroll || !store) return readiness.finding;
      return readAndSave(store.id, 'prompt');
    },
    // An in-process consumer uses only its selected declaration. Never expose a value-returning shell route.
    async resolve(name: string, environmentId?: string): Promise<string> {
      if (name === opServiceAccountTokenName)
        throw new Error('The bootstrap credential is reserved.');
      const { secrets, environmentIds } = target.requirements;
      const secret = !environmentId && secrets.find((entry) => entry.name === name);
      const environment =
        environmentId ?? (environmentIds.length === 1 ? environmentIds[0] : undefined);
      let selected: OpEnvironmentRequirements;
      if (secret) selected = { secrets: [secret], environmentIds: [] };
      else if (environment && environmentIds.includes(environment))
        selected = {
          secrets: [],
          environmentIds: [environment],
          requiredVariable: { environmentId: environment, name },
        };
      else throw new Error('Select a declared 1Password source.');
      await assertCurrent();
      const result = await service.load(target.owner, selected);
      if (result.status !== 'loaded')
        throw new Error(finding(classify(result.diagnostics[0])).message);
      await assertCurrent();
      const values = secret ? result.set.values : result.sources[0]?.values;
      if (!values || !Object.hasOwn(values, name))
        throw new Error('The declared 1Password variable is missing.');
      return values[name]!;
    },
  };
}
