import { Kind, parse, valueFromASTUntyped, type SelectionSetNode } from 'graphql';

import { assignmentInputError, type AssignmentEffect } from './assignment-request.ts';

/** inspect only root fields of the selected mutation, including fragment spreads. */
export default function graphqlAssignmentEffects(
  payload: Record<string, unknown>,
): AssignmentEffect[] {
  if (typeof payload.query !== 'string') return assignmentInputError();
  try {
    const document = parse(payload.query);
    const operations = document.definitions.filter(
      (node) => node.kind === Kind.OPERATION_DEFINITION,
    );
    const selected =
      payload.operationName === undefined || payload.operationName === null
        ? operations.length === 1
          ? operations[0]
          : undefined
        : operations.find((node) => node.name?.value === payload.operationName);
    if (!selected) return assignmentInputError();
    if (selected.operation !== 'mutation') return [];
    const variables = { ...((payload.variables ?? {}) as Record<string, unknown>) };
    for (const definition of selected.variableDefinitions ?? []) {
      const name = definition.variable.name.value;
      if (!(name in variables) && definition.defaultValue)
        variables[name] = valueFromASTUntyped(definition.defaultValue);
    }
    const effects: AssignmentEffect[] = [];
    const visit = (selection: SelectionSetNode, seen: Set<string>) => {
      for (const node of selection.selections) {
        const skipped = node.directives?.some((directive) => {
          const condition = directive.arguments?.find((argument) => argument.name.value === 'if');
          const value: unknown = condition
            ? valueFromASTUntyped(condition.value, variables)
            : undefined;
          return (
            (directive.name.value === 'skip' && value === true) ||
            (directive.name.value === 'include' && value === false)
          );
        });
        if (skipped) continue;
        if (node.kind === Kind.FRAGMENT_SPREAD) {
          const name = node.name.value;
          if (seen.has(name)) assignmentInputError();
          const fragment = document.definitions.find(
            (item) => item.kind === Kind.FRAGMENT_DEFINITION && item.name.value === name,
          );
          if (!fragment || fragment.kind !== Kind.FRAGMENT_DEFINITION) assignmentInputError();
          visit(fragment.selectionSet, new Set([...seen, name]));
          continue;
        }
        if (node.kind === Kind.INLINE_FRAGMENT) {
          visit(node.selectionSet, seen);
          continue;
        }
        const name = node.name.value;
        if (
          ![
            'addAssigneesToAssignable',
            'removeAssigneesFromAssignable',
            'updateIssue',
            'updatePullRequest',
          ].includes(name)
        )
          continue;
        const inputs = node.arguments?.filter((argument) => argument.name.value === 'input') ?? [];
        if (inputs.length !== 1) assignmentInputError();
        const value = inputs[0]?.value;
        if (!value) assignmentInputError();
        // duplicate object fields are ambiguous; the provider's decoder must not choose for us.
        const checkValue = (item: typeof value): void => {
          if (item.kind === Kind.OBJECT) {
            if (new Set(item.fields.map((field) => field.name.value)).size !== item.fields.length)
              assignmentInputError();
            for (const field of item.fields) checkValue(field.value);
          }
          if (item.kind === Kind.LIST) for (const child of item.values) checkValue(child);
        };
        checkValue(value);
        const input: unknown = valueFromASTUntyped(value, variables);
        if (!input || typeof input !== 'object' || Array.isArray(input)) assignmentInputError();
        const record = input as Record<string, unknown>;
        const remove = name === 'removeAssigneesFromAssignable';
        const add = name === 'addAssigneesToAssignable';
        if (!remove && !add && !Object.hasOwn(record, 'assigneeIds')) continue;
        const target =
          record[remove || add ? 'assignableId' : name === 'updateIssue' ? 'id' : 'pullRequestId'];
        // updatePullRequest uses pullRequestId, not the issue update's id.
        if (typeof target !== 'string' || !target) assignmentInputError();
        const ids = record.assigneeIds;
        const members =
          ids === null
            ? []
            : Array.isArray(ids)
              ? ids
              : typeof ids === 'string'
                ? [ids]
                : undefined;
        if (!members || members.some((id) => typeof id !== 'string' || !id)) assignmentInputError();
        effects.push({
          mode: remove ? 'remove' : add ? 'add' : 'replace',
          members: members as string[],
          identity: 'node',
          target: { node: target },
        });
      }
    };
    visit(selected.selectionSet, new Set());
    return effects.some((effect) => effect.mode !== 'add') ? effects : [];
  } catch {
    return assignmentInputError();
  }
}
