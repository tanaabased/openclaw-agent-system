import { realpath } from 'node:fs/promises';
import implementationMaterial from './implementation-material.ts';
import nativeClarification from './native-clarification.ts';
import nativeTaskContext from './native-task-context.ts';
import {
  implementationReviewInstructions,
  taskScopeInstructions,
} from './native-task-instructions.ts';

import { parseDirectImplementationRequest } from '../tools/dispatch/implementation-schema.ts';
import assessmentCheckout from './assessment-checkout.ts';
import type { AssessmentEntryDependencies } from './assessment-entry.ts';
import { automationHash } from './automation-hash.ts';
import { DirectEntryStore } from './direct-entry-store.ts';
import implementationContext from './implementation-context.ts';
import implementationEntryDelivery from './implementation-entry-delivery.ts';
import { implementationEntriesSchema } from './implementation-entry-state.ts';
import implementationHandoff from './implementation-handoff.ts';
import { implementationPresentation } from './implementation-result.ts';
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
  const selectedTarget = input.target ?? deps.currentTarget;
  const retained = await store.exclusive(async (entries) => {
    const candidates = entries.filter((entry) =>
      selectedTarget ? entry.target.toLowerCase() === selectedTarget.toLowerCase() : true,
    );
    if (candidates.length > 1)
      throw new Error('implementation-target-selection-required: select the issue URL');
    return candidates[0];
  });
  const target = selectedTarget ?? retained?.target;
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
    await deps.assertCurrent();
    if (managed.nativeContext && input.operation === 'context')
      return nativeTaskContext(
        'implementation',
        target,
        managed.nativeContext,
        deps,
        input.material,
        managed.selections?.implementation,
      );
    return {
      status: 'managed' as const,
      owner: managed.owner,
      runtime: deps.binding.runtime,
      instruction:
        'Use the existing implementation owner with current native direction and its source and publication receipts. Do not bootstrap manual work.',
    };
  }
  if (input.material && !retained) throw new Error('implementation-entry-unavailable');
  if (deps.operator === false) throw new Error('implementation-operator-required');
  if (input.operation !== 'context' && !retained)
    throw new Error('implementation-entry-unavailable');
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
  // delivery recovery uses its original effect owner.
  if (retained && input.operation === 'delivery')
    return store.exclusive(async (entries, save) => {
      const entry = entries.find((record) => record.id === retained.id);
      if (!entry) throw new Error('implementation-entry-unavailable');
      return implementationEntryDelivery({ entry, action: input, deps, save });
    });
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
    let entry = entries.find((record) => record.target === canonical);
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
      if (input.material && (!entry?.progression || !entry.selection))
        throw new Error('implementation-material-context-required');
      if (!entry) {
        entry = {
          id: automationHash({ binding: deps.binding, canonical }),
          target: canonical,
          repositoryId: repo.nodeId,
          subjectId: issue.nodeId,
          checkout,
          scope: input.scope ?? 'local',
          authorization: source,
          scopeSource: source,
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
      }
      // The supplied plan already belongs to native tool history. Do not retain it
      // or make a historical plan a prerequisite for an admitted implementation.
      if (!entry.progression && !input.plan?.trim()) {
        await save();
        return {
          status: 'clarification-needed',
          id: entry.id,
          questions: [
            'Supply the actionable implementation plan, including intended behavior and validation. No assessment will be invented.',
          ],
        };
      }
      if (!input.material) {
        const transition = issueProgression(entry, {
          mode: 'plan',
          operator: true,
          now: deps.now,
        });
        if (transition.status !== 'ready') throw new Error(transition.reason);
        await save();
        entry.selection = (
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
      }
      const response = {
        ...implementationContext({
          runtime: deps.binding.runtime,
          id: entry.id,
          path: checkout.path,
          implementation: entry.selection,
          scope: entry.scope,
        }),
        entry: 'direct',
        target: canonical,
        evidence: { source: canonical },
        instructions:
          taskScopeInstructions +
          ' ' +
          implementationReviewInstructions +
          ' ' +
          'Read evidence.source through normal GitHub tools for current requirements and relevant discussion, following pagination and recovering truncated reads. Execute the selected implementation body once using this verified context; never invoke its bootstrap again. Preserve partial files and follow the latest native plan and user direction. The plan supplied to this tool stays in native conversation; Agent System does not save or reload it. Do not assess, create another chat/worktree, activate notifications or change session settings. Respect the retained publicationAuthorized scope. Local scope forbids push and PR publication. A plan and skill composition grant no publication authority; pull-request scope is collected only from an explicit operator publication request, not inferred from the plan. When the authorized work is complete and verified, use dispatch implementation delivery publish with authored title and body. The native caller and selected issue determine the retained work; do not supply IDs or digests. Result formatting keeps output in native context and is never a delivery prerequisite. Report ordinary substantive output and ask questions directly in native chat. Keep partial files and questions in the native conversation; an answer is ordinary input and needs no clarification checkpoint. Existing publication effects must resume through their original owner and receipts, never a substitute publication.',
      };
      return implementationMaterial(
        response,
        { action: 'implementation', operation: 'context', target: canonical },
        input.material,
      );
    }
    if (
      !entry?.progression ||
      !entry.selection ||
      automationHash(entry.caller) !== automationHash(source)
    )
      throw new Error('implementation-context-required');
    if (!input.result) throw new Error('implementation-result-required');
    if (input.result.outcome === 'clarification-needed')
      return nativeClarification(entry.id, implementationPresentation(input.result));
    await deps.assertCurrent();
    return {
      status: 'native',
      id: entry.id,
      outcome: input.result.outcome,
      presentation: implementationPresentation(input.result),
      handoff: implementationHandoff(input.result.outcome, deps.binding.runtime, {
        publication: entry.scope === 'pull-request',
        target: entry.target,
      }),
      instruction:
        'Show this complete result and follow its scope-aware host handoff. Preserve the result and do not repeat completed work.',
    };
  });
}
