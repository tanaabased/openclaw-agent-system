import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { isAlias, parseDocument, visit } from 'yaml';

import type { AgentManifest, ManifestDiagnostic, ParsedAgentManifest } from './manifest-types.ts';

const externalAgentManifestSchema = Type.Object(
  {
    'schema-version': Type.Literal(1),
    agent: Type.Object(
      {
        id: Type.String({ minLength: 1, pattern: '^[a-z0-9][a-z0-9-]*$' }),
        name: Type.Optional(Type.String({ minLength: 1 })),
        description: Type.Optional(Type.String({ minLength: 1 })),
        avatar: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
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
                { minItems: 1, uniqueItems: true },
              ),
            ]),
          ),
          required: Type.Optional(
            Type.Array(Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }), {
              minItems: 1,
              uniqueItems: true,
            }),
          ),
          set: Type.Optional(
            Type.Record(Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }), Type.String()),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

type ExternalAgentManifest = Static<typeof externalAgentManifestSchema>;

function schemaDiagnostic(error: ReturnType<typeof Value.Errors>[number]): ManifestDiagnostic[] {
  if (error.keyword === 'additionalProperties') {
    return error.params.additionalProperties.map((property) => ({
      code: 'manifest-unknown-key',
      fieldPath: `${error.instancePath}/${String(property)}`,
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
    agent: {
      id: value.agent.id,
      ...(value.agent.name === undefined ? {} : { name: value.agent.name }),
      ...(value.agent.description === undefined ? {} : { description: value.agent.description }),
      ...(value.agent.avatar === undefined ? {} : { avatar: value.agent.avatar }),
    },
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
            ...(value.environment.required === undefined
              ? {}
              : { required: [...value.environment.required] }),
            ...(value.environment.set === undefined ? {} : { set: { ...value.environment.set } }),
          },
        }),
  };
}

/** Parse one manifest without permitting YAML references, tags, or schema extensions. */
export default function parseAgentManifest(source: string): ParsedAgentManifest {
  const document = parseDocument(source, {
    customTags: [],
    merge: false,
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
  let hasAlias = false;
  let hasAnchor = false;
  let hasTag = false;

  visit(document, (_key, node) => {
    if (!node || typeof node !== 'object') return;
    if (isAlias(node)) hasAlias = true;
    if ('anchor' in node && typeof node.anchor === 'string' && node.anchor.length > 0) {
      hasAnchor = true;
    }
    if ('tag' in node && typeof node.tag === 'string' && node.tag.length > 0) hasTag = true;
  });

  if (hasAlias) {
    diagnostics.push({
      code: 'yaml-alias',
      message: 'YAML aliases are not supported.',
      severity: 'error',
    });
  }
  if (hasAnchor) {
    diagnostics.push({
      code: 'yaml-anchor',
      message: 'YAML anchors are not supported.',
      severity: 'error',
    });
  }
  if (hasTag) {
    diagnostics.push({
      code: 'yaml-tag',
      message: 'Explicit YAML tags are not supported.',
      severity: 'error',
    });
  }
  if (diagnostics.length > 0) return { status: 'invalid', diagnostics };

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    return {
      status: 'invalid',
      diagnostics: [
        {
          code: 'yaml-conversion',
          message: 'The YAML document could not be converted safely.',
          severity: 'error',
        },
      ],
    };
  }

  if (!Value.Check(externalAgentManifestSchema, value)) {
    return {
      status: 'invalid',
      diagnostics: Value.Errors(externalAgentManifestSchema, value).flatMap(schemaDiagnostic),
    };
  }

  return { status: 'valid', manifest: decodeManifest(value), diagnostics: [] };
}
