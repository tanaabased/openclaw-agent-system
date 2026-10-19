import { isDeepStrictEqual } from 'node:util';

import { type TSchema } from 'typebox';
import { Value } from 'typebox/value';

import type { FeedbackSourceEvent, FeedbackSourceState } from './feedback-state.ts';
import { checkRetainedCount, packRetained, unpackRetained } from './retained-history.ts';

export function settledFeedback(event: FeedbackSourceEvent) {
  const native = event as FeedbackSourceEvent & {
    turn?: { status: string; consumedByEventId?: string; replyEventId?: string };
  };
  const completed =
    event.nativeCompleted ||
    (native.turn?.status === 'completed' &&
      native.turn.consumedByEventId &&
      native.turn.replyEventId);
  return Boolean(
    event.phase === 'published' &&
    event.result &&
    completed &&
    (event.receipt || event.replyRequested === false),
  );
}

/** only settled outcomes leave the runnable queue; exact frozen evidence remains in this journal. */
export function compactFeedback<T extends FeedbackSourceEvent>(
  state: Omit<FeedbackSourceState, 'events'> & { events: T[] },
) {
  const completed = state.events.filter(settledFeedback);
  if (!completed.length) return;
  const history = [...(state.history ?? [])];
  checkRetainedCount(history.length + completed.length, 'feedback', completed[0]!.id);
  for (const event of completed) {
    const native = event as T & { turn?: { runId: string }; attempt?: { turnId?: string } };
    history.push({
      id: event.id,
      sourceId: event.sourceId,
      nodeId: event.nodeId,
      revision: event.revision,
      receipt: event.receipt,
      turnId: native.turn?.runId ?? native.attempt?.turnId,
      evidence: packRetained(event, event.id),
    });
  }
  state.history = history;
  state.events = state.events.filter((event) => !settledFeedback(event));
}

export function retainedFeedback<T extends FeedbackSourceEvent>(
  state: (Omit<FeedbackSourceState, 'events'> & { events: T[] }) | undefined,
  id: string | undefined,
): T | undefined {
  const live = state?.events.find((event) => event.id === id);
  if (live) return live;
  const entry = state?.history?.find((event) => event.id === id);
  return entry ? (unpackRetained(entry.evidence) as T) : undefined;
}

export function validFeedbackHistory(state: FeedbackSourceState, schema: TSchema): boolean {
  const ids = [...state.events, ...(state.history ?? [])].map((event) => event.id);
  if (new Set(ids).size !== ids.length) return false;
  for (const entry of state.history ?? []) {
    const event = unpackRetained(entry.evidence) as FeedbackSourceEvent;
    if (
      !Value.Check(schema, event) ||
      !settledFeedback(event) ||
      ['id', 'sourceId', 'nodeId', 'revision', 'receipt'].some(
        (key) =>
          !isDeepStrictEqual(
            entry[key as keyof typeof entry],
            event[key as keyof FeedbackSourceEvent],
          ),
      )
    )
      return false;
    const native = event as FeedbackSourceEvent & {
      turn?: { runId: string };
      attempt?: { turnId?: string };
    };
    if (entry.turnId !== (native.turn?.runId ?? native.attempt?.turnId)) return false;
  }
  return true;
}
