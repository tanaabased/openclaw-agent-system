import { type Static, Type } from 'typebox';

import type { inspectCodexDispatchActivation } from './codex-automations.ts';
import type codexContinuationNative from './codex-continuation-native.ts';
import type codexLiveTurn from './codex-live-turn.ts';
import {
  type default as runCodexDelivery,
  type CodexDeliveryDependencies,
} from './codex-delivery.ts';

import {
  type CodexDispatchSelection,
  type CodexDispatchDependencies,
} from './codex-dispatch-context.ts';

import type { codexDispatchNative } from './codex-dispatch-native.ts';
import type { dispatchGit } from './codex-dispatch-project.ts';
import { implementationResultSchema } from './implementation-result.ts';

export const requestSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal('next'),
      Type.Literal('reconcile'),
      Type.Literal('context'),
      Type.Literal('result'),
      Type.Literal('cancel'),
      Type.Literal('delivery'),
      Type.Literal('retry'),
      Type.Literal('retry-denied'),
    ]),
    id: Type.Optional(Type.String()),
    digest: Type.Optional(Type.String()),
    approvedCallId: Type.Optional(Type.String()),
    result: Type.Optional(implementationResultSchema),
    delivery: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export interface CodexContinuationDependencies extends CodexDispatchDependencies {
  continuationNative?: ReturnType<typeof codexContinuationNative>;
  observeTurn?: ReturnType<typeof codexLiveTurn>;
  deliver?: typeof runCodexDelivery;
  deliveryDependencies?: CodexDeliveryDependencies;
}

export interface CodexWorkContext {
  pluginData: string;
  input: Static<typeof requestSchema>;
  deps: CodexContinuationDependencies;
  current: CodexDispatchSelection;
  caller: string;
  activation: Awaited<ReturnType<typeof inspectCodexDispatchActivation>>;
  schedule: NonNullable<Awaited<ReturnType<typeof inspectCodexDispatchActivation>>['schedule']>;
  native: ReturnType<typeof codexDispatchNative>;
  continuationNative: ReturnType<typeof codexContinuationNative>;
  observeTurn?: ReturnType<typeof codexLiveTurn>;
  git: typeof dispatchGit;
  occurrence: Awaited<ReturnType<ReturnType<typeof codexDispatchNative>['occurrence']>> | undefined;
  admissions: Awaited<ReturnType<CodexDispatchSelection['store']['read']>>;
  save: () => Promise<void>;
  signal: AbortSignal;
}
