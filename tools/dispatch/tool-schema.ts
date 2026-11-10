import { Type, type Static, type TProperties } from 'typebox';
import { Value } from 'typebox/value';
import { dispatchInspectionProperties } from '../../agent/dispatch-inspection.ts';
import { implementationResultSchema } from '../../agent/implementation-result.ts';
import { issueChatTitleGuidance } from '../../agent/issue-chat-title.ts';
import { implementationDecisionSchema } from '../../agent/issue-progression.ts';
import { assessmentSchema } from '../../agent/model-routing.ts';
import WorkflowRequestError from '../../agent/workflow-request-error.ts';
import discriminatedSchema from '../../utils/discriminated-schema.ts';
import { directAssessmentRequestSchema } from './assessment-schema.ts';
import invalidDeliveryRequest from './delivery-request-error.ts';
import {
  implementationMaterialSchema,
  modelMaterialParameters,
  type modelMaterialSchema,
} from './implementation-material-schema.ts';
import {
  directImplementationRequestSchema,
  invalidImplementationRequest,
} from './implementation-schema.ts';
import { launchRequestSchema } from './launch-schema.ts';
import { operatorTargetProperties } from './recovery-schema.ts';
import { invalidReplyRequest, replyExecutionSchema } from './reply-schema.ts';
import { retirementModelSchema, retirementRequestSchema } from './retirement-schema.ts';

const id = Type.String({ pattern: '^[a-f0-9]{64}$' });
const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const dispatchRequestVariants = Type.Union([
  launchRequestSchema,
  replyExecutionSchema,
  directAssessmentRequestSchema,
  directImplementationRequestSchema,
  object({
    action: Type.Literal('recover'),
    id,
    pullRequest: Type.String({ minLength: 1, maxLength: 4096 }),
    digest: Type.Optional(id),
    apply: Type.Optional(Type.Boolean()),
  }),
  retirementRequestSchema,
  object({
    action: Type.Literal('check'),
    observation: Type.Optional(
      object({
        status: Type.Union([Type.Literal('ready'), Type.Literal('blocked')]),
        changed: Type.Boolean(),
        code: Type.Optional(Type.String({ pattern: '^[a-z][a-z0-9-]{0,127}$' })),
      }),
    ),
  }),
  object({ action: Type.Literal('report') }),
  object({ action: Type.Literal('inspect'), ...dispatchInspectionProperties }),
  object({ action: Type.Literal('next') }),
  object({
    action: Type.Literal('prepare'),
    id,
    digest: id,
    assessment: assessmentSchema,
    title: Type.String({
      minLength: 1,
      maxLength: 80,
      description: issueChatTitleGuidance,
      pattern: '^(?=.*\\S)[^\\u0000-\\u001F\\u007F-\\u009F]+$',
    }),
    fallback: Type.Optional(Type.Literal('default')),
  }),
  object({ action: Type.Literal('reconcile'), id }),
  object({ action: Type.Literal('start'), id }),
  object({ action: Type.Literal('assess'), id }),
  object({
    action: Type.Literal('context'),
    id,
    material: Type.Optional(implementationMaterialSchema),
  }),
  object({
    action: Type.Literal('handoff'),
    id,
    apply: Type.Optional(Type.Boolean()),
    permission: Type.Optional(
      Type.Union([
        Type.Literal('implementation'),
        Type.Literal('publication'),
        Type.Literal('implementation-and-publication'),
      ]),
    ),
    digest: Type.Optional(id),
  }),
  object({
    action: Type.Literal('implementation-context'),
    id,
    decision: Type.Optional(implementationDecisionSchema),
    material: Type.Optional(implementationMaterialSchema),
    scope: Type.Optional(Type.Union([Type.Literal('local'), Type.Literal('pull-request')])),
  }),
  object({
    action: Type.Literal('implementation-result'),
    id,
    implementationResult: implementationResultSchema,
  }),
  object({
    action: Type.Literal('delivery'),
    id,
    material: Type.Optional(implementationMaterialSchema),
    operation: Type.Union([
      Type.Literal('link'),
      Type.Literal('bind'),
      Type.Literal('prepare'),
      Type.Literal('publish'),
      Type.Literal('reconcile'),
      Type.Literal('present'),
      Type.Literal('compose'),
      Type.Literal('candidate'),
      Type.Literal('announce'),
    ]),
    pullRequest: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    ),
    publicText: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 512, pattern: '\\S' })),
    body: Type.Optional(Type.String({ minLength: 1, maxLength: 65536, pattern: '\\S' })),
  }),
  object({
    action: Type.Literal('feedback'),
    id,
    eventId: id,
    material: Type.Optional(implementationMaterialSchema),
    operation: Type.Union([Type.Literal('context'), Type.Literal('reconcile')]),
  }),
  object({ action: Type.Literal('retry'), id }),
]);
export const dispatchParameters = discriminatedSchema('action', dispatchRequestVariants);

// current-task reads have no model-facing owner selector.
type ModelDispatchInput<T = Static<typeof dispatchParameters>> = T extends {
  action: 'context' | 'handoff' | 'implementation-context' | 'implementation-result' | 'delivery';
}
  ? Omit<T, 'id' | 'digest' | 'apply'>
  : T extends { action: 'feedback' }
    ? Omit<T, 'id' | 'eventId' | 'digest'> & { source?: string }
    : T extends { action: 'retry' }
      ? Omit<T, 'id'> & { target?: string; chat?: string }
      : T extends { action: 'recover' }
        ? Omit<T, 'id' | 'digest' | 'apply'> & { target?: string; chat?: string; preview?: boolean }
        : T extends { action: 'retire' }
          ? Static<typeof retirementModelSchema>
          : T extends { action: 'prepare' | 'reconcile' | 'start' | 'assess' }
            ? Omit<T, 'id' | 'digest'> & { target?: string }
            : Omit<T, 'projects' | 'observation'>;
type ModelMaterialInput<T> = T extends { material?: unknown }
  ? Omit<T, 'material'> & { material?: Static<typeof modelMaterialSchema> }
  : T;
export const dispatchModelParameters = Type.Unsafe<ModelMaterialInput<ModelDispatchInput>>(
  discriminatedSchema(
    'action',
    Type.Union(
      dispatchRequestVariants.anyOf
        .map((variant) =>
          [
            'context',
            'handoff',
            'implementation-context',
            'implementation-result',
            'delivery',
          ].includes(String(variant.properties.action.const))
            ? Type.Omit(variant, ['id', 'digest', 'apply'], {
                additionalProperties: false,
              })
            : variant.properties.action.const === 'feedback'
              ? object({
                  ...Type.Omit(variant, ['id', 'eventId', 'digest']).properties,
                  source: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
                })
              : variant.properties.action.const === 'retry'
                ? object({ action: Type.Literal('retry'), ...operatorTargetProperties })
                : variant.properties.action.const === 'recover'
                  ? object({
                      ...Type.Omit(variant, ['id', 'digest', 'apply']).properties,
                      target: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
                      chat: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
                      preview: Type.Optional(Type.Boolean()),
                    })
                  : variant.properties.action.const === 'retire'
                    ? retirementModelSchema
                    : ['prepare', 'reconcile', 'start', 'assess'].includes(
                          String(variant.properties.action.const),
                        )
                      ? object({
                          ...Type.Omit(variant, ['id', 'digest']).properties,
                          target:
                            variant.properties.action.const === 'prepare'
                              ? Type.String({ minLength: 1, maxLength: 4096 })
                              : Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
                        })
                      : variant,
        )
        .map((schema) => {
          const fields = Type.Omit(schema, ['projects', 'observation']);
          return modelMaterialParameters({
            ...schema,
            properties: fields.properties,
            required: fields.required,
          });
        }),
    ),
  ),
);

/** validate public arguments before runtime binding, preserving safe operation-specific guidance. */
export function assertDispatchModelRequest(
  input: unknown,
  fallback = 'dispatch-model-request-invalid',
): asserts input is Static<typeof dispatchModelParameters> & Record<string, unknown> {
  if (Value.Check(dispatchModelParameters, input)) return;
  const action = input && typeof input === 'object' && 'action' in input ? input.action : undefined;
  if (action === 'reply') throw invalidReplyRequest(input, dispatchModelParameters);
  if (action === 'implementation') throw invalidImplementationRequest(input);
  if (action === 'delivery')
    throw invalidDeliveryRequest(
      input && typeof input === 'object' && 'operation' in input ? input.operation : undefined,
      'openclaw',
    );
  if (action === 'context' || action === 'contextRequest')
    throw new WorkflowRequestError(
      fallback,
      'Current task context needs no authored selectors. Use agent_system_context with {}, or agent_system_dispatch with {"action":"context"}. Do not supply target, operation, contextRequest, checkout, path, IDs, or authority fields.',
    );
  throw new Error(fallback);
}

/** The native caller supplies every lookup selector. */
export const turnContextParameters = Type.Object({}, { additionalProperties: false });
