import githubNotificationWorkModeInstructions from '../conversation/prompts/mode-work.ts';
import type { GitHubNotificationMode } from './types.ts';

/** Retain the configured coding surface for trusted Work-mode turns. */
const githubNotificationWorkMode: GitHubNotificationMode = {
  instructions: githubNotificationWorkModeInstructions,
  policy: {
    id: 'work',
    label: 'Work',
    toolProjection: { kind: 'inherit-configured', requiredProfile: 'coding' },
  },
};

export default githubNotificationWorkMode;
