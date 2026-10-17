import { Type } from 'typebox';

import { implementationResultSchema } from './implementation-result.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const input = Type.Object({ runId: text, inputEventId: text }, { additionalProperties: false });
export const openclawWorkStateSchema = Type.Object(
  {
    assessmentDigest: hash,
    implementation: Type.Optional(input),
    publication: Type.Optional(input),
    caller: Type.Optional(input),
    result: Type.Optional(implementationResultSchema),
    delivery: Type.Optional(
      Type.Object(
        {
          id: hash,
          binding: Type.Object(
            {
              repositoryId: text,
              issueId: text,
              sessionId: text,
              threadId: text,
              worktree: text,
              branch: text,
              base: text,
              head: text,
              authorId: text,
              policyDigest: hash,
            },
            { additionalProperties: false },
          ),
          title: Type.String({ minLength: 1, maxLength: 512 }),
          body: Type.String({ minLength: 1, maxLength: 65536 }),
          creationAttempted: Type.Boolean(),
          pushedHead: Type.Optional(text),
          pullRequest: Type.Optional(
            Type.Object(
              {
                pullRequestNodeId: text,
                pullRequestNumber: Type.Integer({ minimum: 1 }),
              },
              { additionalProperties: false },
            ),
          ),
          reconciled: Type.Boolean(),
          presentation: Type.Optional(Type.String({ maxLength: 32000 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
