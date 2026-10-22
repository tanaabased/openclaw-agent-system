import { realpath } from 'node:fs/promises';
import { Value } from 'typebox/value';

import { directAssessmentRequestSchema } from '../tools/dispatch/assessment-schema.ts';
import type { AgentManifest } from '../manifest/types.ts';
import renderAssessmentResult from '../channels/github/presentation/assessment-result.ts';
import assessmentSkillSource from './assessment-skill-source.ts';
import assessmentCheckout from './assessment-checkout.ts';
import { assessmentInstructions } from './assessment-instructions.ts';
import {
  assessmentResultContextSchema,
  parseAssessmentResult,
  type AssessmentResult,
} from './assessment-result.ts';
import type { AssessmentSelection } from './assessment-selection.ts';
import { type AssessmentEntry, type AssessmentEntries } from './assessment-entry-state.ts';
import AssessmentEntryStore, { type AssessmentEntryBinding } from './assessment-entry-store.ts';
import { automationHash } from './automation-hash.ts';
import type { CodexAssessmentSkill } from './codex-assessment-skill.ts';
import type { DispatchGit } from './codex-dispatch-project.ts';
import dispatchContext from './dispatch-context.ts';
import type { OpenClawFeedbackProvider } from './openclaw-feedback.ts';
import { replyLocator } from './reply-target.ts';
import { selectWorkflowStage } from './workflow-stage.ts';

export interface AssessmentEntryDependencies {
  root: string;
  binding: AssessmentEntryBinding;
  turnId: string;
  inputId: string;
  manifest: AgentManifest;
  now: number;
  git: DispatchGit;
  connectProvider(): Promise<
    Pick<OpenClawFeedbackProvider, 'getRepository' | 'getItem' | 'getItemContext'>
  >;
  resolveSkill(id: string): Promise<CodexAssessmentSkill>;
  assertCurrent(): Promise<void>;
  managed(target: { repository: string; number: number }): Promise<
    | {
        digest: string;
        path: string;
        selection: AssessmentSelection;
        evidence: string;
        result?: AssessmentResult;
        receipt?: unknown;
        entries: AssessmentEntries;
      }
    | undefined
  >;
}

/** bootstrap one assessment, then reuse the existing method, adaptation, and renderer. */
export default async function assessmentEntry(input: unknown, deps: AssessmentEntryDependencies) {
  if (!Value.Check(directAssessmentRequestSchema, input))
    throw new Error('assessment-request-invalid');
  if (
    (input.result !== undefined && input.operation !== 'result') ||
    (input.revise && input.operation !== 'context')
  )
    throw new Error('assessment-request-invalid');
  if (input.operation !== 'context' && !input.id) throw new Error('assessment-entry-id-required');
  await deps.assertCurrent();
  const store = new AssessmentEntryStore(deps.root, deps.binding);
  // find the retained destination without consulting provider prose or changing ownership.
  const retained =
    input.id || input.target
      ? await store.exclusive(async (entries) =>
          entries.find((entry) =>
            input.id
              ? entry.id === input.id
              : entry.target.toLowerCase() === input.target!.toLowerCase(),
          ),
        )
      : undefined;
  const targetUrl = input.target ?? retained?.target;
  if (!targetUrl)
    return {
      status: 'clarification-needed',
      questions: ['Which GitHub issue URL and existing checkout root should be assessed?'],
    };
  const locator = replyLocator(targetUrl);
  if (locator.itemType !== 'issue' || locator.kind)
    throw new Error('assessment-issue-url-required');
  const repository = `${locator.owner}/${locator.name}`;
  const managed = await deps.managed({ repository, number: locator.number });
  const managedEntry = managed
    ? await managed.entries(async (entries) =>
        entries.find(
          (entry) =>
            entry.binding === automationHash(deps.binding) &&
            entry.target.toLowerCase() === targetUrl.toLowerCase(),
        ),
      )
    : undefined;
  const saved = managedEntry ?? retained;
  if (
    saved?.result &&
    (input.operation === 'present' || (input.operation === 'context' && !input.revise))
  ) {
    if (
      saved.ownerDigest !== managed?.digest ||
      saved.target.toLowerCase() !== targetUrl.toLowerCase() ||
      saved.binding !== automationHash(deps.binding)
    )
      throw new Error('assessment-entry-context-changed');
    if (input.path && (await realpath(input.path)) !== saved.checkout.path)
      throw new Error('assessment-checkout-root-required');
    await deps.assertCurrent();
    return {
      status: 'presented',
      retained: true,
      entry: 'direct',
      id: saved.id,
      target: saved.target,
      previousResult: saved.result,
      previousResultDigest: automationHash(saved.result),
      previousResultTurnId: saved.resultTurnId,
      presentation: renderAssessmentResult(saved.result, {
        issue: { label: `${repository}#${locator.number}`, url: saved.target },
        assessment: saved.selection,
        workspace: deps.binding.workspace,
        includeDetails: input.includeDetails,
        assessmentOnly: true,
      }),
      handoff: { next: 'assessment-only' as const },
      instruction:
        'Show this retained assessment without rerunning it. This read grants no implementation or publication authority.',
    };
  }
  const path = input.path ?? retained?.checkout.path ?? managed?.path;
  if (!path)
    return {
      status: 'clarification-needed',
      questions: ['Which existing local checkout root belongs to this issue?'],
    };
  if (managed?.result && !managedEntry && !input.id && !input.revise) {
    if ((await realpath(path)) !== managed.path)
      throw new Error('assessment-managed-checkout-mismatch');
    await deps.assertCurrent();
    return {
      status: 'presented',
      retained: true,
      entry: 'direct',
      previousResult: managed.result,
      previousResultDigest: automationHash(managed.result),
      receipt: managed.receipt,
      presentation: renderAssessmentResult(managed.result, {
        issue: { label: `${repository}#${locator.number}`, url: targetUrl },
        assessment: managed.selection,
        workspace: deps.binding.workspace,
        includeDetails: input.includeDetails,
        assessmentOnly: true,
      }),
      handoff: { next: 'assessment-only' as const },
      instruction:
        'Show the saved assessment. No reassessment, implementation or publication is authorized; preserve the existing managed stage and receipts.',
    };
  }
  // the native git adapter enforces containment before any provider credential is resolved.
  const checkout = await assessmentCheckout(path, repository, deps.git);
  if (managed && checkout.path !== managed.path)
    throw new Error('assessment-managed-checkout-mismatch');
  const provider = await deps.connectProvider();
  const repo = await provider.getRepository(locator.owner, locator.name);
  if (`${repo.owner.login}/${repo.name}`.toLowerCase() !== repository.toLowerCase())
    throw new Error('assessment-repository-identity-mismatch');
  const issue = await provider.getItem(locator.owner, locator.name, locator.number);
  if (issue.itemType !== 'issue' || issue.number !== locator.number)
    throw new Error('assessment-issue-identity-mismatch');
  const canonical = `https://github.com/${repo.owner.login}/${repo.name}/issues/${issue.number}`;
  const presentation = (result: AssessmentResult, selection: AssessmentSelection) =>
    renderAssessmentResult(result, {
      issue: { label: `${repo.owner.login}/${repo.name}#${issue.number}`, url: canonical },
      assessment: selection,
      workspace: deps.binding.workspace,
      includeDetails: input.includeDetails,
      assessmentOnly: true,
    });
  const handoff = { next: 'assessment-only' as const };
  const instruction =
    'Show this complete assessment. This direct request authorizes neither implementation nor publication. Preserve existing managed stage and receipts; do not invoke summary, handoff, or another workflow.';
  const entries: AssessmentEntries = managed?.entries ?? store.exclusive.bind(store);
  return entries(async (records, save) => {
    const binding = automationHash(deps.binding);
    let entry = input.id
      ? records.find((e) => e.id === input.id && e.binding === binding)
      : records.find((e) => e.binding === binding && e.target === canonical);
    if (input.id && !entry) throw new Error('assessment-entry-unavailable');
    if (
      entry &&
      (entry.target !== canonical ||
        entry.repositoryId !== repo.nodeId ||
        entry.subjectId !== issue.nodeId ||
        entry.checkout.path !== checkout.path ||
        entry.ownerDigest !== managed?.digest)
    )
      throw new Error('assessment-entry-context-changed');
    const currentOwner = await deps.managed({ repository, number: locator.number });
    if (currentOwner?.digest !== managed?.digest)
      throw new Error('assessment-managed-context-changed');
    await deps.assertCurrent();
    const response = (record: AssessmentEntry) => ({
      status: 'verified',
      runtime: deps.binding.runtime,
      entry: 'direct',
      id: record.id,
      target: canonical,
      project: record.checkout,
      evidence: JSON.parse(record.evidence),
      assessment: record.selection,
      currentTurnId: deps.turnId,
      previousResult: record.result ?? managed?.result,
      previousResultDigest:
        (record.result ?? managed?.result)
          ? automationHash(record.result ?? managed!.result)
          : undefined,
      previousResultTurnId: record.resultTurnId,
      previousPresentation: record.result
        ? presentation(record.result, record.selection)
        : undefined,
      mode: 'plan',
      handoff,
      resultContract: 'assessment-result/v1',
      resultSchema: assessmentResultContextSchema,
      instructions:
        assessmentInstructions +
        '\n\nDirect execution: use these verified inputs and the selected assessment body, never its entry bootstrap again. Preserve the current chat/model. Submit using dispatch assessment result (action assessment, operation result) with id, target and previousResultDigest; use assessment context/present for refresh/readback. Do not use managed context/result or publication routes. The runtime returns assessment-only even with Work/Auto defaults. Missing or dirty checkout limitations belong in evidence. No assignment, setup, implementation, publication, or new chat is authorized.',
    });
    if (input.operation === 'context') {
      if (entry?.result && !input.revise)
        return {
          ...response(entry),
          status: 'presented',
          retained: true,
          presentation: presentation(entry.result, entry.selection),
          instruction,
        };
      if (!entry) {
        if (records.length >= 20) throw new Error('assessment-entry-capacity');
        const selected =
          managed?.selection ??
          (
            await selectWorkflowStage({
              stage: 'assessment',
              configuration: deps.manifest.github?.notifications?.issueAssignment?.assessment,
              workspace: deps.binding.workspace,
              observedAt: deps.now,
              resolveSkill: deps.resolveSkill,
            })
          ).selection;
        const evidence =
          managed?.evidence ??
          JSON.stringify(
            dispatchContext(
              await provider.getItemContext(locator.owner, locator.name, locator.number),
              canonical,
              deps.now,
            ),
          );
        entry = {
          id: automationHash({ binding, canonical, owner: managed?.digest }),
          binding,
          target: canonical,
          repositoryId: repo.nodeId,
          subjectId: issue.nodeId,
          checkout,
          evidence,
          selection: selected,
          turnId: deps.turnId,
          inputId: deps.inputId,
          ...(managed ? { ownerDigest: managed.digest } : {}),
        };
        records.push(entry);
      } else if (entry.turnId !== deps.turnId || entry.inputId !== deps.inputId) {
        entry.turnId = deps.turnId;
        entry.inputId = deps.inputId;
        entry.checkout = checkout;
        if (!managed) {
          entry.selection = (
            await selectWorkflowStage({
              stage: 'assessment',
              configuration: deps.manifest.github?.notifications?.issueAssignment?.assessment,
              workspace: deps.binding.workspace,
              observedAt: deps.now,
              resolveSkill: deps.resolveSkill,
            })
          ).selection;
          entry.evidence = JSON.stringify(
            dispatchContext(
              await provider.getItemContext(locator.owner, locator.name, locator.number),
              canonical,
              deps.now,
            ),
          );
        }
      }
      await deps.assertCurrent();
      await save();
      return response(entry);
    }
    if (!entry) throw new Error('assessment-context-required');
    if (input.operation === 'present') {
      if (!entry.result) throw new Error('assessment-result-missing');
      return {
        status: 'presented',
        retained: true,
        presentation: presentation(entry.result, entry.selection),
        handoff,
        instruction,
      };
    }
    if (entry.turnId !== deps.turnId || entry.inputId !== deps.inputId)
      throw new Error('assessment-context-required');
    if (automationHash(checkout) !== automationHash(entry.checkout))
      throw new Error('assessment-checkout-changed');
    if (
      entry.resultTurnId !== deps.turnId &&
      automationHash(await assessmentSkillSource(entry.selection.skill)) !==
        automationHash(entry.selection.skill)
    )
      throw new Error('assessment-selection-changed');
    const result = parseAssessmentResult(input.result);
    if (!result.fullAssessment?.trim()) throw new Error('assessment-result-incomplete');
    const previous = entry.result ?? managed?.result;
    if (
      previous &&
      automationHash(previous) !== automationHash(result) &&
      input.previousResultDigest !== automationHash(previous)
    )
      throw new Error('assessment-result-conflict');
    // this record has no workflow permissions; a model-authored auto decision cannot grant them.
    if (entry.result && automationHash(entry.result) !== automationHash(result)) {
      entry.history ??= [];
      if (entry.history.length >= 10) throw new Error('assessment-revision-capacity');
      entry.history.push(entry.result);
    }
    entry.result = result;
    entry.resultTurnId = deps.turnId;
    await deps.assertCurrent();
    await save();
    return {
      status: 'recorded',
      id: entry.id,
      outcome: result.outcome,
      previousResultDigest: automationHash(result),
      presentation: presentation(result, entry.selection),
      handoff,
      instruction,
    };
  });
}
