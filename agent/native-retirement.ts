import { Type } from 'typebox';

import { DirectEntryStore, type AssessmentEntryBinding } from './assessment-entry-store.ts';
import { automationHash } from './automation-hash.ts';
import workflowFailure from './workflow-failure.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const entriesSchema = Type.Array(
  Type.Object(
    {
      digest: text,
      source: text,
      turnId: text,
      inputId: text,
      at: Type.Number(),
      code: Type.Optional(text),
      archived: Type.Optional(Type.Literal(true)),
    },
    { additionalProperties: false },
  ),
  { maxItems: 1 },
);

export interface NativeRetirementTarget {
  id: string;
  incarnation: string;
  cwd?: string;
  revision?: string;
  archived: boolean;
}

export interface NativeRetirementResult {
  status: 'retire-available' | 'retirement-prepared' | 'archived' | 'pending' | 'failed';
  native: string;
  incarnation: string;
  archived: boolean;
  cwd?: string;
  checkout: { disposition: 'native-owned' };
  digest?: string;
  request?: unknown;
  code?: string;
  instruction: string;
}

/** explicit disposal receipts are separate from assignment custody and preservation policy. */
export default async function nativeRetirement(input: {
  root: string;
  binding: AssessmentEntryBinding;
  target: string;
  digest?: string;
  turnId: string;
  inputId: string;
  now: number;
  effects: string;
  assertCurrent(): Promise<void>;
  observe(): Promise<NativeRetirementTarget>;
  managed(): Promise<boolean>;
  archive(target: NativeRetirementTarget): Promise<unknown>;
  attemptOutcome?(attempt: {
    source: string;
    turnId: string;
    at: number;
  }): Promise<'unsubmitted' | 'denied' | 'unverified'>;
}): Promise<NativeRetirementResult> {
  await input.assertCurrent();
  if (await input.managed()) throw new Error('native-retirement-managed-owner-required');
  const target = await input.observe();
  if (target.id !== input.target) throw new Error('native-retirement-target-mismatch');
  const binding = {
    ...input.binding,
    session: target.id,
    incarnation: target.incarnation,
  };
  const store = new DirectEntryStore(input.root, binding, entriesSchema, 'native-retirement');
  const digest = automationHash({ binding, target, turnId: input.turnId, inputId: input.inputId });
  const result = (
    status: NativeRetirementResult['status'],
    observed: NativeRetirementTarget,
    code?: string,
  ): NativeRetirementResult => ({
    status,
    native: observed.id,
    incarnation: observed.incarnation,
    archived: observed.archived,
    ...(observed.cwd ? { cwd: observed.cwd } : {}),
    checkout: { disposition: 'native-owned' },
    ...(code ? { code } : {}),
    instruction: observed.archived
      ? 'Native archival is verified. Checkout effects, if any, are delegated to the runtime and are not verified by archival; cwd alone does not identify a disposable checkout. Use native history/restore where supported; restoring history does not guarantee recovery of discarded local work.'
      : input.effects,
  });
  return store.exclusive(async (entries, save) => {
    const previous = entries[0];
    if (target.archived) {
      if (previous && !previous.archived) {
        previous.archived = true;
        await save();
      }
      return result('archived', target);
    }
    if (
      previous?.archived &&
      previous.source === input.binding.session &&
      previous.turnId === input.turnId &&
      previous.inputId === input.inputId
    )
      return result('failed', target, 'native-retirement-new-input-required');
    if (previous && !previous.archived) {
      const outcome = previous.code ? 'denied' : await input.attemptOutcome?.(previous);
      if (outcome === 'denied')
        return result('failed', target, previous.code ?? 'native-retirement-archive-denied');
      // only an owner-proven unsubmitted effect in this same input may be prepared again.
      if (
        outcome === 'unsubmitted' &&
        previous.source === input.binding.session &&
        previous.turnId === input.turnId &&
        previous.inputId === input.inputId &&
        previous.digest === digest
      )
        return {
          ...result('retirement-prepared', target),
          request: await input.archive(target),
          instruction:
            input.effects +
            ' Execute this exact native request once, honor native denial, then repeat the same retire operation to observe the outcome.',
        };
      return result('pending', target, 'native-retirement-archive-unverified');
    }
    if (!input.digest)
      return { ...result('retire-available', target), digest, instruction: input.effects };
    if (input.digest !== digest) throw new Error('native-retirement-preview-stale');
    await input.assertCurrent();
    if (await input.managed()) throw new Error('native-retirement-managed-owner-required');
    const fresh = await input.observe();
    if (automationHash(fresh) !== automationHash(target))
      throw new Error('native-retirement-preview-stale');
    const attempt = {
      digest,
      source: input.binding.session,
      turnId: input.turnId,
      inputId: input.inputId,
      at: input.now,
    };
    entries.splice(0, entries.length, attempt);
    await save();
    try {
      const request = await input.archive(target);
      if (request)
        return {
          ...result('retirement-prepared', target),
          request,
          instruction:
            input.effects +
            ' Execute this exact native request once, honor native denial, then repeat the same retire operation to observe the outcome.',
        };
    } catch (error) {
      // a failed response can follow a committed mutation; read back before classifying it.
      const observed = await input.observe().catch(() => undefined);
      if (observed?.incarnation === target.incarnation && observed.archived) {
        entries[0]!.archived = true;
        await save();
        return result('archived', observed);
      }
      const failure = workflowFailure(error, 'native-retirement-archive-unverified');
      if (/denied|forbidden|permission/u.test(failure.code)) {
        entries[0]!.code = failure.code;
        await save();
        return result('failed', target, failure.code);
      }
      return result('pending', target, 'native-retirement-archive-unverified');
    }
    const observed = await input.observe().catch(() => undefined);
    if (!observed) return result('pending', target, 'native-retirement-archive-unverified');
    if (observed.incarnation !== target.incarnation)
      throw new Error('native-retirement-target-mismatch');
    if (observed.archived) {
      entries[0]!.archived = true;
      await save();
    }
    return result(
      observed.archived ? 'archived' : 'pending',
      observed,
      observed.archived ? undefined : 'native-retirement-archive-unverified',
    );
  });
}
