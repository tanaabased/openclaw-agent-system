import { createHash } from 'node:crypto';

import type { GitHubNotificationModeId } from '../modes/types.ts';
import { githubNotificationPublicationText } from '../publication/publication.ts';

export const githubNotificationAssignmentAcknowledgments = [
  "Got it — I'm starting on this now.",
  "I've got this and I'm getting started.",
  "Received — I'm taking this on now.",
  "I'm on it and starting now.",
  "Got this one — I'm getting to work.",
  "I've picked this up and I'm starting now.",
  "Understood — I'm getting started on this.",
  "Thanks — I've got this from here.",
  "This is on my plate now — I'm starting.",
  "I'm taking this one and getting started.",
  "Got the assignment — I'm beginning now.",
  "I've picked this one up and I'm on it.",
  "All set — I'm starting on this assignment.",
  "I'm getting to work on this now.",
  "This one's mine — I'm starting now.",
  "I have this and I'm getting underway.",
  "Acknowledged — I'm beginning work on this.",
  "I'm starting on this one now.",
  "Got the handoff — I'm taking it from here.",
  "I've received this and I'm getting started.",
  "I'm taking this forward now.",
  "This is in hand — I'm starting work.",
  "I have the assignment and I'm beginning now.",
  "I'm picking this up and getting to work.",
  "Got it — I'm taking this from here.",
  "I'm underway on this assignment now.",
  "I've got the assignment and I'm starting.",
  "This is mine to handle — I'm beginning now.",
  "I'm taking ownership of this and starting now.",
  "I've picked this up — I'm getting to work.",
  "The assignment is in hand — I'm starting now.",
  "I'm on this now and getting started.",
] as const;

export const githubNotificationGuidedAssignmentAcknowledgments = [
  "I've got the assignment and I'm waiting for your direction.",
  "Assignment received — I'm ready when you are.",
  "I've got this set up and I'm waiting for next steps.",
  "Received — I'll wait for your direction before proceeding.",
  "The assignment is ready, and I'm standing by for instructions.",
  "I've picked this up and will wait for your guidance.",
  'Got it — everything is ready when you want to continue.',
  "This is set up, and I'm waiting to hear what you'd like me to do.",
  "Acknowledged — I'm ready for your next instruction.",
  "I've received the assignment and I'm standing by.",
  "The assignment is in hand; I'll wait for your direction.",
  "Got the assignment — I'm ready for whatever comes next.",
] as const;

/** Select one safe acknowledgment deterministically for an admitted assignment. */
export default function githubNotificationAssignmentAcknowledgment(
  agentId: string,
  assignmentEventId: string,
  modeId: GitHubNotificationModeId = 'work',
): string {
  const acknowledgments =
    modeId === 'guided'
      ? githubNotificationGuidedAssignmentAcknowledgments
      : githubNotificationAssignmentAcknowledgments;
  const index =
    createHash('sha256').update(`${agentId}\0${assignmentEventId}`).digest().readUInt32BE(0) %
    acknowledgments.length;
  return githubNotificationPublicationText('initial-acknowledgment', [
    { text: acknowledgments[index] },
  ]);
}
