import { Type, type Static, type TObject } from 'typebox';
import { assessmentSelectionSchema } from './assessment-selection.ts';
import { workflowBindingSchema } from './workflow-result.ts';
import { maximumGitHubNotificationReplyLength } from '../channels/github/publication/limits.ts';
import { implementationMaterialSchema } from '../tools/dispatch/implementation-material-schema.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const assessmentSummaryRequestProperties = {
  operation: Type.Union([
    Type.Literal('compose'),
    Type.Literal('candidate'),
    Type.Literal('publish'),
    Type.Literal('reconcile'),
    Type.Literal('hold'),
  ]),
  digest: Type.Optional(hash),
  publicText: Type.Optional(
    Type.String({ minLength: 1, maxLength: maximumGitHubNotificationReplyLength }),
  ),
  diagnostic: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  material: Type.Optional(implementationMaterialSchema),
};
export const assessmentSummarySchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    resultDigest: hash,
    binding: workflowBindingSchema,
    turnId: text,
    authorityDigest: hash,
    selection: assessmentSelectionSchema,
    authorLogin: Type.Optional(text),
    publicText: Type.Optional(
      Type.String({ minLength: 1, maxLength: maximumGitHubNotificationReplyLength }),
    ),
    attempt: Type.Optional(text),
    publication: Type.Optional(Type.String({ minLength: 1, maxLength: 65536 })),
    receipt: Type.Optional(
      Type.Object(
        { nodeId: text, databaseId: Type.Integer({ minimum: 1 }) },
        { additionalProperties: false },
      ),
    ),
    code: Type.Optional(text),
    diagnostic: Type.Optional(text),
    publicationCommand: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })),
    previewDigest: Type.Optional(hash),
    nativeDenial: Type.Optional(
      Type.Object(
        { turnId: text, callId: text, commandDigest: hash },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type AssessmentSummary = Static<typeof assessmentSummarySchema>;
export type AssessmentSummaryRequest = Static<TObject<typeof assessmentSummaryRequestProperties>>;
