import githubNotificationGuidedModeInstructions from '../conversation/prompts/mode-guided.ts';
import type { GitHubNotificationMode } from './types.ts';

/** Retain coding capabilities while waiting for explicit operator direction. */
const githubNotificationGuidedMode: GitHubNotificationMode = {
  instructions: githubNotificationGuidedModeInstructions,
  policy: {
    assignmentContinuation: 'wait-for-input',
    id: 'guided',
    label: 'Guided',
    toolProjection: { kind: 'inherit-configured', requiredProfile: 'coding' },
  },
};

export default githubNotificationGuidedMode;
