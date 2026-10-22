import { realpath } from 'node:fs/promises';

import { parseDirectImplementationRequest } from '../tools/dispatch/implementation-schema.ts';
import assessmentCheckout from './assessment-checkout.ts';
import type { AssessmentEntryDependencies } from './assessment-entry.ts';
import AssessmentEntryStore, { DirectEntryStore } from './assessment-entry-store.ts';
import { automationHash } from './automation-hash.ts';
import dispatchContext from './dispatch-context.ts';
import implementationHandoff from './implementation-handoff.ts';
import implementationEntryDelivery from './implementation-entry-delivery.ts';
import implementationContext from './implementation-context.ts';
import { implementationEntriesSchema } from './implementation-entry-state.ts';
import { implementationPresentation, implementationReadback } from './implementation-result.ts';
import issueProgression from './issue-progression.ts';
import { replyLocator } from './reply-target.ts';
import { selectWorkflowStage } from './workflow-stage.ts';

/** collect only missing inputs; managed execution and the selected skill retain their owners. */
export default async function implementationEntry(
  request: unknown,
  deps: AssessmentEntryDependencies,
) {
  const input = parseDirectImplementationRequest(request);
  await deps.assertCurrent();
  const store = new DirectEntryStore(
    deps.root,
    deps.binding,
    implementationEntriesSchema,
    'implementation',
  );
  const retained = await store.exclusive(async (entries) =>
    entries.find((entry) =>
      input.id ? entry.id === input.id : entry.target.toLowerCase() === input.target?.toLowerCase(),
    ),
  );
  const target = input.target ?? retained?.target ?? deps.currentTarget;
  if (!target)
    return {
      status: 'clarification-needed',
      questions: ['Which GitHub issue URL should be implemented?'],
    };
  const locator = replyLocator(target);
  if (locator.itemType !== 'issue' || locator.kind)
    throw new Error('implementation-issue-url-required');
  const repository = `${locator.owner}/${locator.name}`;
  const managed = await deps.managed({ repository, number: locator.number });
  if (managed) {
    if (!managed.owner) throw new Error('implementation-managed-owner-unavailable');
    if (input.path && (await realpath(input.path)) !== managed.path)
      throw new Error('implementation-managed-checkout-mismatch');
    if (input.id && input.id !== managed.owner.id)
      throw new Error('implementation-managed-owner-mismatch');
    await deps.assertCurrent();
    if (input.operation === 'present')
      return implementationReadback(managed.owner.id, managed.implementationResult);
    return {
      status: 'managed' as const,
      owner: managed.owner,
      runtime: deps.binding.runtime,
      instruction:
        'Use the existing implementation owner with its original plan, stage inputs, source and receipts. Do not bootstrap manual work.',
    };
  }
  if (deps.operator === false) throw new Error('implementation-operator-required');
  if (input.id && !retained) throw new Error('implementation-entry-unavailable');
  const path = input.path ?? retained?.checkout.path;
  if (!path)
    return {
      status: 'clarification-needed',
      questions: ['Which existing local checkout root belongs to this issue?'],
    };
  const checkout = await assessmentCheckout(path, repository, deps.git);
  if (
    retained &&
    (retained.target.toLowerCase() !== target.toLowerCase() ||
      retained.checkout.path !== checkout.path)
  )
    throw new Error('implementation-entry-context-changed');
  // readback and completed recovery never reconnect providers or resolve a skill again.
  if (retained && input.operation === 'delivery')
    return store.exclusive(async (entries, save) => {
      const entry = entries.find((record) => record.id === retained.id);
      if (!entry) throw new Error('implementation-entry-unavailable');
      return implementationEntryDelivery({ entry, action: input, deps, save });
    });
  if (
    retained?.result &&
    (input.operation === 'present' || (retained.result.outcome === 'done' && !input.scope))
  ) {
    if (input.result && automationHash(input.result) !== automationHash(retained.result))
      throw new Error('implementation-result-conflict');
    await deps.assertCurrent();
    if (input.operation === 'present') return implementationReadback(retained.id, retained.result);
    return {
      status: 'presented',
      id: retained.id,
      retained: true,
      deliveryOnly: retained.result.outcome === 'done',
      previousResult: retained.result,
      presentation: implementationPresentation(retained.result),
      handoff: implementationHandoff(retained.id, retained.result.outcome, deps.binding.runtime, {
        publication: retained.scope === 'pull-request',
      }),
      instruction:
        'Show the retained result. Do not repeat completed edits or commits. Follow the retained scope-aware handoff and original publication receipts; never infer publication authority from the plan.',
    };
  }
  const provider = await deps.connectProvider();
  const repo = await provider.getRepository(locator.owner, locator.name);
  const issue = await provider.getItem(locator.owner, locator.name, locator.number);
  if (
    `${repo.owner.login}/${repo.name}`.toLowerCase() !== repository.toLowerCase() ||
    issue.itemType !== 'issue' ||
    issue.number !== locator.number
  )
    throw new Error('implementation-target-identity-mismatch');
  const canonical = `https://github.com/${repo.owner.login}/${repo.name}/issues/${issue.number}`;
  const source = { turnId: deps.turnId, inputId: deps.inputId };
  return store.exclusive(async (entries, save) => {
    let entry = entries.find((record) =>
      input.id ? record.id === input.id : record.target === canonical,
    );
    if (input.id && !entry) throw new Error('implementation-entry-unavailable');
    if (
      entry &&
      (entry.repositoryId !== repo.nodeId ||
        entry.subjectId !== issue.nodeId ||
        entry.checkout.path !== checkout.path)
    )
      throw new Error('implementation-entry-context-changed');
    if (await deps.managed({ repository, number: locator.number }))
      throw new Error('implementation-managed-context-changed');
    await deps.assertCurrent();
    if (input.operation === 'context') {
      if (!entry) {
        if (entries.length >= 20) throw new Error('implementation-entry-capacity');
        entry = {
          id: automationHash({ binding: deps.binding, canonical }),
          target: canonical,
          repositoryId: repo.nodeId,
          subjectId: issue.nodeId,
          checkout,
          evidence: JSON.stringify(
            dispatchContext(
              await provider.getItemContext(locator.owner, locator.name, locator.number),
              canonical,
              deps.now,
            ),
          ),
          scope: input.scope ?? 'local',
          authorization: source,
          scopeSource: source,
          ...(deps.message ? { authorizationText: deps.message } : {}),
          caller: source,
        };
        entries.push(entry);
      }
      if (input.scope && input.scope !== entry.scope) {
        if (
          input.scope === 'pull-request' &&
          automationHash(entry.scopeSource) === automationHash(source)
        )
          throw new Error('implementation-scope-new-input-required');
        entry.scope = input.scope;
        entry.scopeSource = source;
        entry.scopeText = deps.message;
      }
      if (entry.plan && input.plan && entry.plan !== input.plan)
        throw new Error('implementation-consumed-plan-changed');
      if (!entry.plan) {
        const assessment = await new AssessmentEntryStore(deps.root, deps.binding).exclusive(
          async (records) =>
            records.find(
              (record) =>
                record.target === canonical &&
                record.checkout.path === checkout.path &&
                record.repositoryId === repo.nodeId &&
                record.subjectId === issue.nodeId,
            )?.result,
        );
        entry.plan =
          input.plan ?? (assessment?.outcome === 'plan-ready' ? assessment.plan : undefined);
      }
      if (!entry.plan?.trim()) {
        await save();
        return {
          status: 'clarification-needed',
          id: entry.id,
          questions: [
            'Supply the actionable implementation plan, including intended behavior and validation. No assessment will be invented.',
          ],
        };
      }
      if (
        entry.result?.outcome === 'clarification-needed' &&
        automationHash(entry.resultSource) === automationHash(source)
      )
        return {
          status: 'clarification-needed',
          id: entry.id,
          presentation: implementationPresentation(entry.result),
        };
      const transition = issueProgression(entry, {
        mode: 'plan',
        operator: true,
        actionablePlan: entry.plan,
        now: deps.now,
      });
      if (transition.status !== 'ready') throw new Error(transition.reason);
      await save();
      entry.selection ??= (
        await selectWorkflowStage({
          stage: 'implementation',
          configuration: deps.manifest.github?.notifications?.issueAssignment?.implementation,
          workspace: deps.binding.workspace,
          observedAt: deps.now,
          resolveSkill: deps.resolveSkill,
        })
      ).selection;
      entry.progression = transition.progression;
      entry.caller = source;
      await deps.assertCurrent();
      await save();
      return {
        ...implementationContext({
          runtime: deps.binding.runtime,
          id: entry.id,
          path: checkout.path,
          plan: entry.plan,
          implementation: entry.selection,
          previousResult: entry.result,
          scope: entry.scope,
          direct: true,
        }),
        entry: 'direct',
        target: canonical,
        evidence: JSON.parse(entry.evidence),
        currentInput: deps.message,
        instructions:
          'Execute the selected implementation body once using this verified context; never invoke its bootstrap again. Preserve partial files, consumed plan and selection. Reconcile current operator input with this plan. Do not assess, create another chat/worktree, activate notifications or change session settings. Respect the retained publicationAuthorized scope. Local scope forbids push and PR publication. A plan and skill composition grant no publication authority; pull-request scope is collected only from an explicit operator publication request, not inferred from the plan. For requested publication use the host-owned delivery handoff, never publish independently. Submit ordinary substantive output unchanged using dispatch implementation operation result with id and result. On clarification, retain questions and partial work, then wait for a new native input. Refresh this same context on the answer; do not request stage approval again. Existing publication effects must resume through their original owner and receipts, never a substitute publication.',
      };
    }
    if (
      !entry?.progression ||
      !entry.selection ||
      automationHash(entry.caller) !== automationHash(source)
    )
      throw new Error('implementation-context-required');
    if (input.operation === 'present') {
      if (!entry.result) throw new Error('implementation-result-missing');
      return {
        status: 'presented',
        id: entry.id,
        presentation: implementationPresentation(entry.result),
      };
    }
    if (!input.result) throw new Error('implementation-result-required');
    if (
      entry.result &&
      automationHash(entry.result) !== automationHash(input.result) &&
      (entry.result.outcome === 'done' ||
        automationHash(entry.resultSource) === automationHash(source))
    )
      throw new Error('implementation-answer-required');
    entry.result = input.result;
    entry.resultSource = source;
    await deps.assertCurrent();
    await save();
    return {
      status: 'recorded',
      id: entry.id,
      outcome: entry.result.outcome,
      presentation: implementationPresentation(entry.result),
      handoff: implementationHandoff(entry.id, entry.result.outcome, deps.binding.runtime, {
        publication: entry.scope === 'pull-request',
      }),
      instruction:
        'Show this complete result and follow its scope-aware host handoff. Preserve the result and do not repeat completed work.',
    };
  });
}
