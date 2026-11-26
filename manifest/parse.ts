import { declaredToolsSchema } from '../tools/declared/config-schema.ts';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { isAlias, isCollection, isPair, parseDocument, visit } from 'yaml';

import normalizeAutomations, {
  automationFileSchema,
  automationProfileDiagnostics,
  automationModelProfileDiagnostics,
  externalAutomationsSchema,
} from './automation-schema.ts';
import {
  externalSetupDeclarationSchema,
  externalSetupFileSchema,
  normalizeAgentSetup,
} from './setup-schema.ts';
import { decodeAgentSection, externalAgentSectionSchema } from './agent-schema.ts';
import {
  decodeGoogleConfiguration,
  externalGoogleSectionSchema,
} from '../tools/google/config-schema.ts';
import { decodeGitSection, externalGitSectionSchema } from '../tools/git/config-schema.ts';
import {
  decodeGitHubSection,
  externalGitHubSectionSchema,
  hasGitHubWorkflowConfiguration,
} from './github-schema.ts';
import { validateGitHubNotificationPolicy } from '../channels/github/notification-policy.ts';
import { decodeAgentMemory, externalAgentMemorySchema } from './memory-schema.ts';
import { decodeAgentModels, externalAgentModelsSchema } from './models-schema.ts';
import { decodeBackup, externalBackupSchema } from './backup-schema.ts';
import { decodeStorageBackend, externalStorageSchema } from './storage-schema.ts';
import { maximumManifestBytes } from './read-bytes.ts';
import type { AgentManifest, ManifestDiagnostic, ParsedAgentManifest } from './types.ts';
import { decodeEnvironmentSetValue, externalOpSecretReferenceSchema } from './value-schemas.ts';

const externalAgentManifestSchema = Type.Object(
  {
    'schema-version': Type.Literal(1),
    debug: Type.Optional(Type.Boolean()),
    definitions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    automations: Type.Optional(externalAutomationsSchema),
    agent: externalAgentSectionSchema,
    environment: Type.Optional(
      Type.Object(
        {
          dotenv: Type.Optional(
            Type.Union([
              Type.String({ minLength: 1, pattern: '^[^\\u0000\\r\\n]*\\S[^\\u0000\\r\\n]*$' }),
              Type.Array(
                Type.String({
                  minLength: 1,
                  pattern: '^[^\\u0000\\r\\n]*\\S[^\\u0000\\r\\n]*$',
                }),
                { uniqueItems: true },
              ),
            ]),
          ),
          op: Type.Optional(
            Type.Union([
              Type.String({ minLength: 1, pattern: '^[^\\u0000\\r\\n]*\\S[^\\u0000\\r\\n]*$' }),
              Type.Array(
                Type.String({
                  minLength: 1,
                  pattern: '^[^\\u0000\\r\\n]*\\S[^\\u0000\\r\\n]*$',
                }),
                { uniqueItems: true },
              ),
            ]),
          ),
          'path-prepend': Type.Optional(
            Type.Union([
              Type.String({
                minLength: 1,
                pattern: '^(?![/\\\\])[^\\u0000\\r\\n]*\\S$',
              }),
              Type.Array(
                Type.String({
                  minLength: 1,
                  pattern: '^(?![/\\\\])[^\\u0000\\r\\n]*\\S$',
                }),
                { uniqueItems: true },
              ),
            ]),
          ),
          required: Type.Optional(
            Type.Array(Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }), {
              uniqueItems: true,
            }),
          ),
          set: Type.Optional(
            Type.Record(
              Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }),
              Type.Union([Type.String(), externalOpSecretReferenceSchema]),
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    tools: Type.Optional(Type.Union([declaredToolsSchema, Type.String({ minLength: 1 })])),
    google: Type.Optional(externalGoogleSectionSchema),
    git: Type.Optional(externalGitSectionSchema),
    github: Type.Optional(externalGitHubSectionSchema),
    memory: Type.Optional(externalAgentMemorySchema),
    models: Type.Optional(externalAgentModelsSchema),
    'setup-host': Type.Optional(externalSetupDeclarationSchema),
    'setup-agent': Type.Optional(externalSetupDeclarationSchema),
    setup: Type.Optional(externalSetupDeclarationSchema),
    backup: Type.Optional(externalBackupSchema),
    storage: Type.Optional(externalStorageSchema),
  },
  { additionalProperties: false },
);

type ExternalAgentManifest = Static<typeof externalAgentManifestSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pointerSegment(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

function legacyPolicyDiagnostics(value: unknown): ManifestDiagnostic[] {
  if (!isRecord(value)) return [];
  const fields: string[] = [];
  const gitPolicyFields = new Set(['delete-remote-ref', 'force-push']);
  const githubPolicyFields = new Set(['releases']);
  const git = value['git'];
  if (isRecord(git)) {
    const extensions = git['extensions'];
    if (isRecord(extensions)) {
      for (const [name, decision] of Object.entries(extensions)) {
        if (/^[a-z0-9][a-z0-9-]*$/u.test(name) && decision === 'ask') {
          fields.push(`/git/extensions/${pointerSegment(name)}`);
        }
      }
    }
    const policy = git['policy'];
    if (isRecord(policy)) {
      for (const [name, decision] of Object.entries(policy)) {
        if (gitPolicyFields.has(name) && decision === 'ask') {
          fields.push(`/git/policy/${pointerSegment(name)}`);
        }
      }
    }
  }
  const github = value['github'];
  if (isRecord(github)) {
    const policy = github['policy'];
    if (isRecord(policy)) {
      for (const [name, decision] of Object.entries(policy)) {
        if (githubPolicyFields.has(name) && decision === 'ask') {
          fields.push(`/github/policy/${pointerSegment(name)}`);
        }
      }
    }
  }
  return fields.map((fieldPath) => ({
    code: 'manifest-policy-ask-unsupported',
    fieldPath,
    message: `Policy decision ask at ${fieldPath} is no longer supported. An operator must choose deny or allow.`,
    severity: 'error',
  }));
}

function modelTierGroupDiagnostics(value: unknown): ManifestDiagnostic[] {
  if (!isRecord(value)) return [];
  const models = value['models'];
  if (!isRecord(models)) return [];
  const tiers = ['low', 'medium', 'high'] as const;
  const configured = tiers.filter((tier) => Object.hasOwn(models, tier));
  if (configured.length === 0 || configured.length === tiers.length) return [];
  const missing = tiers.filter((tier) => !Object.hasOwn(models, tier));
  return [
    {
      code: 'manifest-model-tier-group-incomplete',
      fieldPath: '/models',
      message: `Model work tiers must declare low, medium, and high together. Missing: ${missing.join(', ')}.`,
      severity: 'error',
    },
  ];
}

function schemaDiagnostic(error: ReturnType<typeof Value.Errors>[number]): ManifestDiagnostic[] {
  if (error.keyword === 'additionalProperties') {
    return error.params.additionalProperties.map((property) => ({
      code: 'manifest-unknown-key',
      fieldPath: `${error.instancePath}/${pointerSegment(String(property))}`,
      message: `Unknown manifest key: ${String(property)}.`,
      severity: 'error',
    }));
  }

  if (error.keyword === 'required') {
    return error.params.requiredProperties.map((property) => ({
      code: 'manifest-required-key',
      fieldPath: `${error.instancePath}/${property}`,
      message: `Required manifest key is missing: ${property}.`,
      severity: 'error',
    }));
  }

  return [
    {
      code: 'manifest-schema',
      fieldPath: error.instancePath || '/',
      message: `Manifest value at ${error.instancePath || '/'} does not match the schema.`,
      severity: 'error',
    },
  ];
}

function decodeManifest(value: ExternalAgentManifest): AgentManifest {
  return {
    schemaVersion: value['schema-version'],
    ...(value.debug === undefined ? {} : { debug: value.debug }),
    agent: decodeAgentSection(value.agent),
    ...(value.environment === undefined
      ? {}
      : {
          environment: {
            ...(value.environment.dotenv === undefined
              ? {}
              : {
                  dotenv:
                    typeof value.environment.dotenv === 'string'
                      ? [value.environment.dotenv]
                      : [...value.environment.dotenv],
                }),
            ...(value.environment.op === undefined
              ? {}
              : {
                  op:
                    typeof value.environment.op === 'string'
                      ? [value.environment.op]
                      : [...value.environment.op],
                }),
            ...(value.environment['path-prepend'] === undefined
              ? {}
              : {
                  pathPrepend:
                    typeof value.environment['path-prepend'] === 'string'
                      ? [value.environment['path-prepend']]
                      : [...value.environment['path-prepend']],
                }),
            ...(value.environment.required === undefined
              ? {}
              : { required: [...value.environment.required] }),
            ...(value.environment.set === undefined
              ? {}
              : {
                  set: Object.fromEntries(
                    Object.entries(value.environment.set).map(([name, input]) => [
                      name,
                      decodeEnvironmentSetValue(input),
                    ]),
                  ),
                }),
          },
        }),
    ...(typeof value.tools === 'object' ? { tools: value.tools } : {}),
    ...(value.google === undefined ? {} : { google: decodeGoogleConfiguration(value.google) }),
    ...(value.git === undefined ? {} : { git: decodeGitSection(value.git) }),
    ...(value.github === undefined ? {} : { github: decodeGitHubSection(value.github) }),
    ...(value.memory === undefined ? {} : { memory: decodeAgentMemory(value.memory) }),
    ...(value.models === undefined ? {} : { models: decodeAgentModels(value.models) }),
    ...(value.backup === undefined ? {} : { backup: decodeBackup(value.backup) }),
    ...(value.storage?.backend === undefined
      ? {}
      : { storage: { backend: decodeStorageBackend(value.storage.backend) } }),
  };
}

/** resolve document-local YAML reuse before schema validation or recursive consumers. */
export function parseManifestYaml(
  source: string,
): { status: 'valid'; value: unknown } | { status: 'invalid'; diagnostics: ManifestDiagnostic[] } {
  const document = parseDocument(source, {
    schema: 'core',
    customTags: [],
    resolveKnownTags: false,
    merge: true,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    version: '1.2',
  });
  const diagnostics: ManifestDiagnostic[] = document.errors.map((error) => ({
    code: error.code === 'DUPLICATE_KEY' ? 'yaml-duplicate-key' : 'yaml-parse-error',
    message:
      error.code === 'DUPLICATE_KEY'
        ? 'YAML mapping keys must be unique.'
        : 'The manifest contains invalid YAML.',
    severity: 'error',
  }));
  const supportedTags = new Set(
    ['str', 'int', 'float', 'bool', 'null', 'map', 'seq', 'merge'].map(
      (name) => `tag:yaml.org,2002:${name}`,
    ),
  );
  visit(document, (_key, node) => {
    if (
      node &&
      typeof node === 'object' &&
      'tag' in node &&
      typeof node.tag === 'string' &&
      !supportedTags.has(node.tag)
    ) {
      diagnostics.push({
        code: 'yaml-tag',
        message: 'Only YAML core tags and the merge extension are supported.',
        severity: 'error',
      });
    }
  });
  if (diagnostics.length > 0) return { status: 'invalid', diagnostics };

  // YAML permits recursive graphs; manifest merging and schema consumers require a DAG.
  const active = new Set<object>();
  const sizes = new Map<object, number>();
  function checkGraph(node: unknown): number {
    if (!node || typeof node !== 'object') return 1;
    const known = sizes.get(node);
    if (known !== undefined) return known;
    if (active.has(node)) throw new Error('yaml-cycle');
    active.add(node);
    let size = 1;
    if (isAlias(node)) {
      const target = node.resolve(document);
      if (!target) throw new Error('yaml-alias-unresolved');
      size += checkGraph(target);
    } else if (isCollection(node)) {
      for (const item of node.items) size += checkGraph(item);
    } else if (isPair(node)) {
      size += checkGraph(node.key) + checkGraph(node.value);
    }
    active.delete(node);
    // Merge aliases bypass toJS's alias counter. Bound expanded traversal as well,
    // using the existing input budget: no more nodes than the permitted input bytes.
    if (size > maximumManifestBytes) throw new Error('yaml-expansion-limit');
    sizes.set(node, size);
    return size;
  }
  try {
    checkGraph(document.contents);
    // Keep the library's bounded alias-expansion default rather than disabling its protection.
    return { status: 'valid', value: document.toJS() };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    const code = ['yaml-cycle', 'yaml-alias-unresolved', 'yaml-expansion-limit'].includes(reason)
      ? reason
      : 'yaml-conversion';
    return {
      status: 'invalid',
      diagnostics: [
        {
          code,
          message:
            code === 'yaml-cycle'
              ? 'YAML aliases must not form cycles.'
              : code === 'yaml-alias-unresolved'
                ? 'YAML aliases must reference an earlier anchor in the same document.'
                : code === 'yaml-expansion-limit'
                  ? 'YAML expanded traversal exceeds the manifest size budget; reduce nested alias reuse.'
                  : 'YAML conversion failed: check merge operands and alias expansion limits.',
          severity: 'error',
        },
      ],
    };
  }
}

/** Parse one manifest without reading files or executing setup commands. */
export default function parseAgentManifest(source: string): ParsedAgentManifest {
  const yaml = parseManifestYaml(source);
  if (yaml.status === 'invalid') return yaml;
  return normalizeAgentManifest(yaml.value);
}

/** validate and normalize an effective document before any external values are resolved. */
export function normalizeAgentManifest(value: unknown): ParsedAgentManifest {
  const agentKey = isRecord(value) && Object.hasOwn(value, 'setup-agent') ? 'setup-agent' : 'setup';
  const github = isRecord(value) && isRecord(value.github) ? value.github : undefined;
  const legacyPickup = github !== undefined && Object.hasOwn(github, 'project-pickup');
  const declarations = (['setup-host', agentKey] as const).flatMap((key) => {
    if (!isRecord(value) || !Object.hasOwn(value, key)) return [];
    const declaration = value[key];
    const file =
      isRecord(declaration) && Object.hasOwn(declaration, 'file') ? declaration : undefined;
    const setup = file === undefined ? normalizeAgentSetup(declaration, `/${key}`) : undefined;
    const fileDiagnostics: ManifestDiagnostic[] =
      file && !Value.Check(externalSetupFileSchema, file)
        ? Value.Errors(externalSetupFileSchema, file).flatMap((error) => {
            const path = `/${key}${error.instancePath}`;
            if (error.keyword === 'additionalProperties')
              return error.params.additionalProperties.map((property) => ({
                code: 'manifest-unknown-key',
                fieldPath: `${path}/${pointerSegment(property)}`,
                message: `Invalid setup file declaration at ${path}/${pointerSegment(property)}.`,
                severity: 'error' as const,
              }));
            return [
              {
                code: 'manifest-schema',
                fieldPath: path,
                message: `Invalid setup file declaration at ${path}.`,
                severity: 'error' as const,
              },
            ];
          })
        : [];
    return [{ key, file, setup, fileDiagnostics }];
  });
  const automationValue = isRecord(value) ? value['automations'] : undefined;
  const automationsFile = Value.Check(automationFileSchema, automationValue)
    ? automationValue.file
    : undefined;
  const automations =
    automationValue === undefined || automationsFile !== undefined
      ? undefined
      : normalizeAutomations(automationValue);
  const declarationDiagnostics = [
    ...(automations?.status === 'invalid' ? automations.diagnostics : []),
    ...(automations?.status === 'valid'
      ? automationProfileDiagnostics(
          automations.automations,
          isRecord(value) ? value.models : undefined,
        )
      : []),
    ...(legacyPickup
      ? [
          {
            code: 'github-project-pickup-removed',
            fieldPath: '/github/project-pickup',
            message:
              'github.project-pickup is no longer supported. Use github.issue-pickup with the same settings, including projects.',
            severity: 'error' as const,
          },
        ]
      : []),
    ...(Array.isArray(github?.routing)
      ? github.routing.flatMap((route: unknown, index: number): ManifestDiagnostic[] =>
          isRecord(route) &&
          Array.isArray(route.workflows) &&
          route.workflows.includes('project-pickup')
            ? [
                {
                  code: 'github-routing-project-pickup-removed',
                  fieldPath: `/github/routing/${index}/workflows`,
                  message:
                    'Routing workflow project-pickup is no longer supported. Use issue-pickup with the same targets and rule order.',
                  severity: 'error',
                },
              ]
            : [],
        )
      : []),
    ...(['issue-assignment', 'issue-pickup'] as const).flatMap((workflow) => {
      const github = isRecord(value) && isRecord(value.github) ? value.github : undefined;
      const settings = github && isRecord(github[workflow]) ? github[workflow] : undefined;
      return automationModelProfileDiagnostics(
        settings?.model,
        isRecord(value) ? value.models : undefined,
        `/github/${workflow}/model`,
      );
    }),
    ...declarations.flatMap(({ setup, fileDiagnostics }) => [
      ...(setup?.status === 'invalid' ? setup.diagnostics : []),
      ...fileDiagnostics,
    ]),
    ...legacyPolicyDiagnostics(value),
    ...(isRecord(value) &&
    isRecord(value.github) &&
    Object.hasOwn(value.github, 'allowed-repository-owners')
      ? [
          {
            code: 'github-repository-owners-removed',
            fieldPath: '/github/allowed-repository-owners',
            message:
              'github.allowed-repository-owners is no longer supported. Replace it with github.routing repository name patterns (for example, routing: ["owner/*"]).',
            severity: 'error' as const,
          },
        ]
      : []),
    ...modelTierGroupDiagnostics(value),
  ];
  if (declarationDiagnostics.length > 0 || !Value.Check(externalAgentManifestSchema, value)) {
    const declarationPaths = new Set(
      declarationDiagnostics.flatMap(({ fieldPath }) =>
        fieldPath === undefined ? [] : [fieldPath],
      ),
    );
    const diagnosticSchema = Type.Object(
      {
        ...externalAgentManifestSchema.properties,
        github: Type.Optional(
          externalGitHubSectionSchema.anyOf[
            isRecord(value) && hasGitHubWorkflowConfiguration(value.github) ? 1 : 0
          ]!,
        ),
      },
      { additionalProperties: false },
    );
    const schemaDiagnostics = Value.Errors(diagnosticSchema, value)
      .flatMap(schemaDiagnostic)
      .filter(
        ({ fieldPath }) =>
          fieldPath === undefined ||
          (!declarationPaths.has(fieldPath) &&
            !declarations.some(
              ({ key, setup, fileDiagnostics }) =>
                (setup?.status === 'invalid' || fileDiagnostics.length > 0) &&
                (fieldPath === `/${key}` || fieldPath.startsWith(`/${key}/`)),
            )),
      );
    return {
      status: 'invalid',
      diagnostics: [...declarationDiagnostics, ...schemaDiagnostics],
    };
  }

  const host = declarations.find(({ key }) => key === 'setup-host');
  const agent = declarations.find(({ key }) => key === agentKey);
  const manifest = decodeManifest(value);
  const notificationDiagnostics = validateGitHubNotificationPolicy(manifest.github);
  if (notificationDiagnostics.some(({ severity }) => severity === 'error')) {
    return { status: 'invalid', diagnostics: notificationDiagnostics };
  }

  return {
    status: 'valid',
    manifest: {
      ...manifest,
      ...(host?.setup?.status === 'valid' ? { setupHost: host.setup.setup } : {}),
      ...(agent?.setup?.status === 'valid' ? { setup: agent.setup.setup } : {}),
    },
    ...(automations?.status === 'valid' ? { automations: automations.automations } : {}),
    ...(typeof value.tools === 'string' ? { toolsFile: value.tools } : {}),
    ...(automationsFile === undefined ? {} : { automationsFile }),
    ...(host?.file && typeof host.file.file === 'string' ? { setupHostFile: host.file.file } : {}),
    ...(agent?.file && typeof agent.file.file === 'string'
      ? {
          setupFile: agent.file.file,
          setupFileFieldPath: `/${agentKey}` as '/setup' | '/setup-agent',
        }
      : {}),
    diagnostics: [
      ...notificationDiagnostics,
      ...(isRecord(value) && Object.hasOwn(value, 'setup')
        ? [
            {
              code: 'manifest-setup-deprecated',
              fieldPath: '/setup',
              message:
                agentKey === 'setup'
                  ? 'Top-level setup is deprecated; use setup-agent instead.'
                  : 'Top-level setup is deprecated and ignored because setup-agent is declared.',
              severity: 'warning' as const,
            },
          ]
        : []),
    ],
  };
}
