import type { AssessmentSelection } from '../assessment/assessment-selection.ts';
import { automationHash } from '../../automation-hash.ts';
import type { CodexWorkContext } from './codex-continuation-context.ts';
import type { DispatchNativeThread } from '../../codex-dispatch-native.ts';
import type { DispatchRecord } from '../../codex-dispatch-state.ts';
import codexWorkState from './codex-work-state.ts';
import type issueProgression from '../../issue-progression.ts';

/** Verify native turn custody before returning implementation context or formatting a result. */
export default async function advanceCodexWorkTurn(
  record: DispatchRecord,
  context: CodexWorkContext,
  verified: {
    selection: AssessmentSelection;
    found: DispatchNativeThread & { turnId: string };
    transition: ReturnType<typeof issueProgression>;
  },
) {
  const { found, transition, selection } = verified;
  const work = codexWorkState(record)!;
  if (found.turnEnded || ['completed', 'failed'].includes(found.turnStatus ?? ''))
    return {
      ready: false as const,
      response: {
        status: 'unresolved' as const,
        id: record.id,
        code: 'continuation-turn-state-unresolved',
        instruction:
          'Continue through the native chat. Preserve interrupted requests and native denials; the coordinator does not send a replacement turn.',
      },
    };
  const direction = context.operatorInput ?? context.feedbackInput;
  const revisionInput = {
    turnId: found.turnId,
    inputId: direction?.inputId ?? found.turnId,
  };
  const currentAttempt = context.feedbackInput?.attempt ?? {
    id: automationHash({ id: record.id, ...revisionInput }),
    origin: direction ? ('input' as const) : ('assessment' as const),
    ...(direction ? { inputId: direction.inputId } : {}),
    sourceThreadId: record.threadId!,
    sourceTurnId: found.turnId,
    beforeTurnId: found.turnId,
    turnId: found.turnId,
    request: { threadId: record.threadId!, prompt: 'Read current native input custody.' },
  };
  const receipt = await context.continuationNative(record.sourceThreadId, currentAttempt);
  if (receipt.status !== 'verified' || receipt.turnId !== found.turnId || receipt.ended)
    return {
      ready: false as const,
      response: {
        status: 'unresolved' as const,
        id: record.id,
        code: receipt.status === 'blocked' ? receipt.code : 'continuation-input-unverified',
      },
    };
  if (found.turnStatus === 'interrupted') {
    if (work.observation?.turnId !== found.turnId) {
      work.observation = {
        turnId: found.turnId,
        afterItemId: await context.native.intakeBoundary(record.threadId!, found.turnId),
      };
      await context.save();
    }
    const observed = await context.observeTurn?.({
      threadId: record.threadId!,
      turnId: found.turnId,
      afterItemId: work.observation.afterItemId,
    });
    if (observed?.status !== 'active')
      return {
        ready: false as const,
        response: {
          status: 'observation-required' as const,
          id: record.id,
          code:
            observed?.status === 'denied'
              ? 'continuation-native-approval-denied'
              : 'continuation-turn-state-unresolved',
          ...(observed?.status === 'unresolved' ? { reason: observed.reason } : {}),
          ...(observed?.status === 'required' || observed === undefined
            ? {
                request: {
                  tool: 'read_thread',
                  arguments: { threadId: record.threadId!, turnLimit: 1, includeOutputs: false },
                },
                instruction:
                  'Read this native turn once with the exact request, then refresh context. Do not send a replacement turn.',
              }
            : {
                instruction:
                  'Native desktop evidence could not verify current turn custody. Resolve the reported observation reason before retrying context. Preserve native denials; do not poll for agreement or send a replacement turn.',
              }),
        },
      };
  }
  if (context.input.action === 'context' && transition.status === 'ready') {
    record.progression = { ...transition.progression };
    if (direction) delete work.cancelled;
    work.selection = selection;
    await context.save();
  }
  return { ready: true as const, selection };
}
