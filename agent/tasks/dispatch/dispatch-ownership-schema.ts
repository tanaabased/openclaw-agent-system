import { Type, type TObject, type TSchema } from 'typebox';

function select(schema: TSchema, keys: string[]) {
  const properties = (schema as TObject).properties;
  return Type.Object(
    Object.fromEntries(keys.filter((key) => properties[key]).map((key) => [key, properties[key]!])),
  );
}

/** validate resource identities without interpreting another task's authored payload or effects. */
export default function dispatchOwnershipSchema(schema: TObject) {
  const properties = schema.properties;
  const delivery = (properties.delivery as TObject).properties;
  const manual = (properties.manualIssue as TObject).properties;
  const adopted = select(properties.adoptedPullRequest!, [
    'pullRequestNodeId',
    'pullRequestNumber',
    'branch',
  ]);
  const projected: Record<string, TSchema> = {
    ...select(schema, [
      'id',
      'intakeId',
      'issueKey',
      'sourceThreadId',
      'threadId',
      'worktree',
      'worktreeAttemptId',
      'adoptedLocalBranch',
      'pullRequestLink',
      'supersededBy',
      'predecessorId',
      'clientThreadId',
      'receiptThreadId',
    ]).properties,
    adoptedPullRequest: Type.Optional(adopted),
    delivery: Type.Optional(
      Type.Object({
        binding: select(delivery.binding!, [
          'repositoryId',
          'issueId',
          'threadId',
          'sessionId',
          'worktree',
          'branch',
        ]),
        localBranch: delivery.localBranch!,
        pullRequest: delivery.pullRequest!,
        adopted: Type.Optional(adopted),
      }),
    ),
    manualIssue: Type.Optional(
      Type.Object({
        ...select(properties.manualIssue!, ['id', 'scope']).properties,
        receiving: select(manual.receiving!, ['nodeId']),
        repository: select(manual.repository!, ['nodeId']),
        issue: select(manual.issue!, ['nodeId']),
        initiation: select(manual.initiation!, ['session']),
        pullRequest: Type.Optional(select(manual.pullRequest!, ['headRef', 'repositoryNodeId'])),
      }),
    ),
  };
  for (const [key, fields] of [
    ['request', ['key', 'cwd']],
    ['project', ['commonDir']],
    ['issueBranch', ['attemptId', 'name']],
    ['sessionCreation', ['sessionId']],
    ['repositoryPreparation', ['checkout']],
  ] as const) {
    const property = properties[key];
    if (property) projected[key] = Type.Optional(select(property, [...fields]));
  }
  return Type.Object(projected);
}
