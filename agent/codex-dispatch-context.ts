import {
  managedTargetUrl,
  type ManagedIssue as IntakeRecord,
  type ManagedIssueState as IntakeState,
} from './managed-issue.ts';
import GitHubIdentityCache from '../channels/github/identity-cache.ts';
import type AssignmentClaimStore from './assignment-claim-store.ts';

import type CodexAssignmentClaims from './codex-assignment-claims.ts';
import type {
  GitHubNotificationIntakeClient,
  GitHubNotificationItemContextClient,
} from '../channels/github/provider/work-event-types.ts';
import type { inspectCodexDispatchActivation } from './codex-automations.ts';
import { codexDispatchNative } from './codex-dispatch-native.ts';
import { type DispatchGit } from './codex-dispatch-project.ts';
import type prepareDispatchRepository from './codex-dispatch-repository.ts';
import type { DispatchRecord, DispatchState } from './codex-dispatch-state.ts';
import type connectCodexFeedback from './codex-feedback-client.ts';
import codexHostAccess from './codex-host-access.ts';
import {
  type selectCodexIntake,
  connectCodexGitHub,
  type CodexIntakeDependencies,
} from './codex-intake.ts';

import type codexRetirementNative from './codex-retirement-native.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import { inspectContinuedIssue, inspectAdmittedIssue } from './dispatch-assignment.ts';
import workflowFailure from './workflow-failure.ts';

type Client = GitHubNotificationIntakeClient & GitHubNotificationItemContextClient;
export type CodexDispatchSelection = Awaited<ReturnType<typeof selectCodexIntake>>;
export type CodexDispatchNative = ReturnType<typeof codexDispatchNative>;
export interface CodexDispatchDependencies extends Omit<CodexIntakeDependencies, 'connect'> {
  claimStore?: AssignmentClaimStore;
  claims?: Pick<CodexAssignmentClaims, 'select' | 'accept'>;
  connect?: (workspace: string, signal: AbortSignal) => Promise<Client>;
  activation?: typeof inspectCodexDispatchActivation;
  native?: CodexDispatchNative;
  git?: DispatchGit;
  feedbackConnect?: typeof connectCodexFeedback;
  summaryAuthority?: (threadId: string, turnId: string) => Promise<void>;
  prepareRepository?: typeof prepareDispatchRepository;
  replyConnection?: typeof connectCodexThreads;
  retirementNative?: ReturnType<typeof codexRetirementNative>;
  threadId?: string;
}

export function repository(record: IntakeRecord) {
  return record.repository.owner.login + '/' + record.repository.name;
}
export function issueUrl(record: IntakeRecord) {
  return managedTargetUrl(record);
}
export function code(error: unknown) {
  if (codexHostAccess(error)) return 'codex-host-access-required';
  return workflowFailure(error, 'dispatch-operation-failed').code;
}
export async function revalidateDispatchAssignment(
  current: CodexDispatchSelection,
  record: IntakeRecord,
  deps: CodexDispatchDependencies,
  signal: AbortSignal,
  retainedWork = false,
  dispatchRecord?: DispatchRecord,
) {
  if (
    'initiation' in record &&
    (record.agentId !== current.agentId ||
      record.workspaceDir !== current.workspace ||
      record.scope !== current.store.location.scope)
  )
    throw new Error('dispatch-workspace-binding-changed');
  const client = await (deps.connect ?? connectCodexGitHub)(current.workspace, signal);
  await new GitHubIdentityCache(current.store.location).resolve(
    current.manifest.github?.notifications,
    client,
    'assignment',
  );
  const repo = retainedWork
    ? (
        await inspectContinuedIssue(
          record,
          client,
          current.manifest.github?.notifications?.issueAssignment?.allowed ?? [],
          dispatchRecord,
          (deps.now ?? Date.now)(),
        )
      ).repo
    : (await inspectAdmittedIssue(record, client)).repo;
  return { client, repo };
}

export async function withNative<T>(
  current: CodexDispatchSelection,
  deps: CodexDispatchDependencies,
  run: (native: CodexDispatchNative) => Promise<T>,
) {
  if (deps.native) return run(deps.native);
  const connection = await connectCodexThreads(current.workspace, current.codexHome);
  try {
    return await run(codexDispatchNative(connection.request));
  } finally {
    await connection.close();
  }
}

export interface CodexDispatchTransaction {
  operatorInput?: { turnId: string; inputId: string };
  pluginData: string;
  current: CodexDispatchSelection;
  deps: CodexDispatchDependencies;
  state: DispatchState;
  admitted: IntakeState;
  activation: Awaited<ReturnType<typeof inspectCodexDispatchActivation>>;
  caller: string;
  now: number;
  signal: AbortSignal;
  save: () => Promise<void>;
  fresh: () => Promise<void>;
}
