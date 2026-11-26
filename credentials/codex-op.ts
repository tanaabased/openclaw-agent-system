import metadata from '../package.json' with { type: 'json' };
import { opServiceAccountTokenName } from '../environment/resolve.ts';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import { inspectCodexWorkspaceBinding } from '../agent/identity/codex-workspace-binding.ts';
import { readCodexConfiguration } from '../agent/codex-configuration.ts';
import type { AgentSystemLifecycleFinding } from '../core/lifecycle-registry.ts';
import collectOpEnvironmentRequirements, {
  hasOpEnvironmentRequirements,
  type OpEnvironmentRequirements,
} from '../environment/op-requirements.ts';
import type { CreateOpEnvironmentClient } from '../environment/op-service.ts';
import type { ManifestDiagnostic } from '../manifest/types.ts';
import OpCredentialManager from './op-manager.ts';
import OpCredentialService from './op-service.ts';
import OpCredentialInput from './op-input.ts';
import { platformCredentialStore } from './registry.ts';
import type { CredentialStore } from './types.ts';

export type CodexOpScope = 'binding' | 'installation';

interface Target {
  owner: string;
  requirements: OpEnvironmentRequirements;
  revision: string;
  label: string;
}

export interface CodexOpDependencies {
  store?: CredentialStore;
  createClient?: CreateOpEnvironmentClient;
  input?: Pick<OpCredentialInput, 'read'>;
}

async function targetFor(pluginData: string, scope: CodexOpScope): Promise<Target | undefined> {
  const owner = createHash('sha256').update(await realpath(pluginData));
  if (scope === 'installation') {
    const ref = (await readCodexConfiguration(pluginData))?.onePassword;
    if (!ref) return;
    return {
      label: 'this Codex installation',
      owner: owner.digest('hex'),
      requirements: {
        environmentIds: [ref.environmentId],
        requiredVariable: { environmentId: ref.environmentId, name: ref.variable },
        secrets: [],
      },
      revision: JSON.stringify([ref.environmentId, ref.variable]),
    };
  }
  const binding = await inspectCodexWorkspaceBinding(pluginData);
  if (
    binding.status !== 'bound' ||
    binding.preview.status !== 'ready' ||
    binding.preview.manifest.status !== 'loaded'
  )
    throw new Error('A valid Codex workspace binding is required.');
  const { manifest, digest } = binding.preview.manifest;
  const requirements = collectOpEnvironmentRequirements(manifest);
  if (!hasOpEnvironmentRequirements(requirements)) return;
  owner.update(
    JSON.stringify([
      binding.binding.workspaceDir,
      manifest.agent.id,
      binding.binding.credentialScope,
    ]),
  );
  return {
    owner: owner.digest('hex'),
    requirements,
    revision: digest,
    label: 'Codex workspace ' + JSON.stringify(binding.binding.workspaceDir),
  };
}

function finding(
  scope: CodexOpScope,
  state: 'ready' | 'missing' | 'rejected' | 'inaccessible',
  localStore = false,
): AgentSystemLifecycleFinding {
  const subject = 'The ' + scope + ' 1Password credential';
  const enroll = scope === 'binding' ? 'setup enroll-op' : 'setup enroll-installation-op';
  const descriptions = {
    ready: ' can access the declared resources.',
    missing: ' is missing. Run ' + enroll + ' with this plugin data directory in your terminal.',
    rejected:
      ' was rejected. Check its grants or run ' + enroll + ' in your terminal to replace it.',
    inaccessible: localStore
      ? ' is inaccessible in the OS credential store. Check macOS login Keychain or Linux Secret Service.'
      : ' could not be validated with 1Password. Check connectivity and access to the declared resources.',
  };
  return {
    component: 'credentials',
    code: 'codex-op-' + scope + '-' + state,
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

/** Resolve private credential ownership from the live Codex pointer or installation configuration. */
export async function codexOpCredential(
  pluginData: string,
  scope: CodexOpScope,
  dependencies: CodexOpDependencies = {},
) {
  const selected = await targetFor(pluginData, scope);
  if (!selected) return;
  const target = selected;
  const { default: OpEnvironmentService } = await import('../environment/op-service.ts');
  const store =
    dependencies.store ??
    platformCredentialStore({ platform: process.platform, environment: process.env });
  const credentials = new OpCredentialService({
    hostEnvironment: {},
    stores: store ? [store] : [],
    credentialId: 'codex-' + scope + '-op',
  });
  const service = new OpEnvironmentService({
    credentialService: credentials,
    createClient: dependencies.createClient,
    integrationVersion: metadata.version,
  });
  async function assertCurrent() {
    const live = await targetFor(pluginData, scope);
    if (!live || live.owner !== target.owner || live.revision !== target.revision)
      throw new Error('The Codex credential owner or declaration changed. Inspect it again.');
  }
  async function check() {
    await assertCurrent();
    if (!store) return { finding: finding(scope, 'inaccessible', true), canEnroll: false };
    const result = await service.validate(target.owner, target.requirements, {
      allowEnvironmentFallback: false,
    });
    await assertCurrent();
    if (result.status === 'valid') return { finding: finding(scope, 'ready'), canEnroll: false };
    const diagnostic = result.diagnostics[0];
    const state = classify(diagnostic);
    const localStore = diagnostic?.providerDiagnostic?.operation === 'credential-resolve';
    return {
      finding: finding(scope, state, localStore),
      canEnroll: state === 'missing' || state === 'rejected',
    };
  }
  async function inspect() {
    return (await check()).finding;
  }
  return {
    inspect,
    async enroll() {
      const readiness = await check();
      if (!readiness.canEnroll || !store) return readiness.finding;
      const input =
        dependencies.input ??
        new OpCredentialInput({
          hostEnvironment: {},
          input: process.stdin,
          output: process.stderr,
        });
      const candidate = await input.read(
        'prompt',
        'Enter the 1Password service-account token for ' + target.label,
      );
      if (candidate.status === 'invalid')
        return {
          ...readiness.finding,
          code: candidate.code,
          message:
            candidate.code === 'op-credential-input-required'
              ? 'Enrollment requires operator input in a local terminal.'
              : candidate.message,
        };
      await assertCurrent();
      const manager = new OpCredentialManager({
        credentialService: credentials,
        environmentService: service,
      });
      const result = await manager.setForOwner(
        target.owner,
        target.requirements,
        candidate.token,
        store.id,
        assertCurrent,
      );
      if (result.status === 'invalid') {
        if (result.code === 'op-credential-mutation-uncertain')
          return {
            ...finding(scope, 'inaccessible', true),
            code: result.code,
            message: result.message,
          };
        return finding(scope, classify(result), result.code.startsWith('credential-'));
      }
      return inspect();
    },
    // An in-process consumer uses only its selected declaration. Never expose a value-returning shell route.
    async resolve(name: string, environmentId?: string): Promise<string> {
      if (name === opServiceAccountTokenName)
        throw new Error('The bootstrap credential is reserved.');
      const { requiredVariable, secrets, environmentIds } = target.requirements;
      if (
        requiredVariable &&
        (requiredVariable.name !== name ||
          (environmentId && environmentId !== requiredVariable.environmentId))
      )
        throw new Error('Undeclared installation variable.');
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
        throw new Error('The declared 1Password value is inaccessible.');
      await assertCurrent();
      const values = secret ? result.set.values : result.sources[0]?.values;
      if (!values || !Object.hasOwn(values, name))
        throw new Error('The declared 1Password variable is missing.');
      return values[name]!;
    },
  };
}
