import { Type } from 'typebox';
import { Value } from 'typebox/value';
import nativeTaskContext from '../context/native-task-context.ts';

import type { AssessmentConfiguration } from '../../../manifest/assessment-schema.ts';
import type { AgentManifest } from '../../../manifest/types.ts';
import { directAssessmentRequestSchema } from '../../../tools/dispatch/assessment-schema.ts';
import assessmentCheckout from './assessment-checkout.ts';
import { assessmentInstructions } from './assessment-instructions.ts';
import assessmentMaterial from './assessment-material.ts';
import { assessmentPresentationRequest } from './assessment-render.ts';
import { assessmentResultContextSchema } from './assessment-result.ts';
import type { AssessmentSelection } from './assessment-selection.ts';
import type { AssessmentSkill } from './assessment-skill-source.ts';
import type { DispatchGit } from '../dispatch/codex-dispatch-project.ts';
import { type DirectEntryBinding } from '../direct-entry-store.ts';
import type { nativeIssueContext } from '../context/native-issue-context.ts';
import type { OpenClawDeliveryConnection } from '../delivery/openclaw-delivery.ts';
import type { FeedbackProvider } from '../feedback/feedback-provider.ts';
import { replyLocator } from '../feedback/reply-target.ts';
import { selectWorkflowStage } from '../workflow-stage.ts';

export interface AssessmentEntryDependencies {
  root: string;
  binding: DirectEntryBinding;
  turnId: string;
  inputId: string;
  message?: string;
  operator?: boolean;
  currentTarget?: string;
  connectDelivery?(path: string): Promise<OpenClawDeliveryConnection>;
  manifest: AgentManifest;
  now: number;
  git: DispatchGit;
  connectProvider(): Promise<
    Pick<FeedbackProvider, 'getRepository' | 'getItem' | 'getItemContext'>
  >;
  resolveSkill(id: string): Promise<AssessmentSkill>;
  assertCurrent(): Promise<void>;
  managed(target: { repository: string; number: number }): Promise<
    | {
        digest: string;
        owner?: { id: string; eventId?: string };
        nativeContext?: ReturnType<typeof nativeIssueContext>;
        selections?: {
          assessment?: AssessmentConfiguration;
          implementation?: AssessmentConfiguration;
        };
        path: string;
        selection?: AssessmentSelection;
      }
    | undefined
  >;
}

// validate source completeness at submission so callers receive the shared actionable diagnostic.
const assessmentRequestSchema = Type.Object(
  { ...directAssessmentRequestSchema.properties, result: Type.Optional(Type.Unknown()) },
  { additionalProperties: false },
);

/** bootstrap one assessment, then reuse the existing method, adaptation, and renderer. */
export default async function assessmentEntry(input: unknown, deps: AssessmentEntryDependencies) {
  if (!Value.Check(assessmentRequestSchema, input)) throw new Error('assessment-request-invalid');
  if (input.material && input.operation !== 'context')
    throw new Error('assessment-request-invalid');
  await deps.assertCurrent();
  const targetUrl = input.target ?? deps.currentTarget;
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
  if (managed?.nativeContext)
    return input.operation === 'context'
      ? nativeTaskContext(
          'assessment',
          targetUrl,
          managed.nativeContext,
          deps,
          input.material,
          managed.selections?.assessment,
        )
      : managed.nativeContext;
  const path = input.path ?? managed?.path;
  if (!path)
    return {
      status: 'clarification-needed',
      questions: ['Which existing local checkout root belongs to this issue?'],
    };
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
  const response = (record: {
    checkout: Awaited<ReturnType<typeof assessmentCheckout>>;
    evidence: string;
    selection: AssessmentSelection;
  }) => ({
    status: 'verified',
    runtime: deps.binding.runtime,
    entry: 'direct',
    target: canonical,
    project: record.checkout,
    evidence: JSON.parse(record.evidence),
    assessment: record.selection,
    currentTurnId: deps.turnId,
    mode: 'plan',
    handoff: { next: 'assessment-only' as const },
    resultContract: 'assessment-result/v1',
    resultSchema: assessmentResultContextSchema,
    recording: 'native-context' as const,
    presentationRequest: assessmentPresentationRequest(canonical, true),
    instructions:
      assessmentInstructions +
      '\n\nDirect execution: use these verified inputs and the selected assessment body once. Preserve the current chat/model. Use presentationRequest plus result matching resultFormat through dispatch assessment render. This pure formatter saves no assessment or summary. Show its presentation; keep the full result in native tool context. No assignment, setup, implementation, publication, or new chat is authorized.',
  });
  if (input.operation === 'context') {
    const { selection } = await selectWorkflowStage({
      stage: 'assessment',
      configuration: deps.manifest.github?.notifications?.issueAssignment?.assessment,
      workspace: deps.binding.workspace,
      observedAt: deps.now,
      resolveSkill: deps.resolveSkill,
    });
    const currentOwner = await deps.managed({ repository, number: locator.number });
    if (currentOwner?.digest !== managed?.digest)
      throw new Error('assessment-managed-context-changed');
    await deps.assertCurrent();
    return assessmentMaterial(
      response({ checkout, evidence: JSON.stringify({ source: canonical }), selection }),
      { action: 'assessment', operation: 'context', target: canonical, path: checkout.path },
      input.material,
    );
  }
  throw new Error('assessment-request-invalid');
}
